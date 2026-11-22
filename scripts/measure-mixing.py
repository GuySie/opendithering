# /// script
# requires-python = ">=3.13"
# dependencies = [
#   "epaper-colorcal[ble,serial,opendisplay]>=0.6",
#   "pillow",
# ]
# ///
"""Measure how a panel's inks mix, to check the model DBS refine relies on.

DBS assumes a patch of mixed dots looks like the linear-light (XYZ) average of the measured inks.
On e-paper that may not hold: particles at the border between two inks can behave differently from
a solid area. This shows full-screen test patterns on an OpenDisplay board, reads each with a CR30
(through epaper-colorcal), and compares the measured colour with the linear-mix prediction made from
solid inks measured in the same run.

Every pattern fills the whole screen, so the instrument stays seated in one place for the whole run.
Results are written after every pattern; --resume continues an interrupted run.

    uv run scripts/measure-mixing.py --address OD216205 --cr30-ble --out mixing.json
    uv run scripts/measure-mixing.py --dry-run --out /tmp/mixing-dry.json      # no hardware
    uv run scripts/measure-mixing.py analyse mixing.json                        # report only
"""

from __future__ import annotations

import argparse
import asyncio
import datetime as dt
import itertools
import json
import sys
from dataclasses import dataclass, field
from pathlib import Path

import colour
import numpy as np
from PIL import Image

from epaper_colorcal.colorimetry import reading_from_spectrum
from epaper_colorcal.instrument_options import add_instrument_options, chosen, open_instrument
from epaper_colorcal.spectrum import Spectrum, average_spectra

SPECTRA6 = {  # name -> nominal sRGB; exact nominals always map to their own ink (no dithering)
    "black": (0, 0, 0), "white": (255, 255, 255), "yellow": (255, 255, 0),
    "red": (255, 0, 0), "blue": (0, 0, 255), "green": (0, 255, 0),
}
D65 = colour.CCS_ILLUMINANTS["CIE 1931 2 Degree Standard Observer"]["D65"]


# --- patterns -------------------------------------------------------------------------------------

@dataclass
class Pattern:
    name: str
    kind: str                      # solid | checker1 | checker2 | lines-h | lines-v | coverage
    image: Image.Image
    coverage: dict[str, float] = field(default_factory=dict)   # ink -> fraction of pixels
    boundary: float = 0.0          # fraction of 4-neighbour pixel pairs with different inks


def _from_mask(name: str, kind: str, mask: np.ndarray, a: str, b: str, inks: dict) -> Pattern:
    """mask True -> ink a, False -> ink b."""
    rgb = np.where(mask[..., None], np.array(inks[a], np.uint8), np.array(inks[b], np.uint8)).astype(np.uint8)
    cov_a = float(mask.mean())
    diff = np.concatenate([(mask[:, 1:] != mask[:, :-1]).ravel(), (mask[1:, :] != mask[:-1, :]).ravel()])
    return Pattern(name, kind, Image.fromarray(rgb, "RGB"), {a: cov_a, b: 1 - cov_a}, float(diff.mean()))


def _image_pattern(path: Path, w: int, h: int) -> Pattern:
    """A full-screen image drawn only in the inks' nominal colours."""
    img = Image.open(path).convert("RGB")
    if img.size != (w, h):
        sys.exit(f"{path.name} is {img.size[0]}x{img.size[1]}, the panel is {w}x{h}")
    a = np.asarray(img).reshape(-1, 3)
    cov = {}
    known = np.zeros(len(a), bool)
    for n, rgb in SPECTRA6.items():
        hit = np.all(a == rgb, axis=1)
        known |= hit
        if hit.any():
            cov[n] = float(hit.mean())
    if not known.all():
        sys.exit(f"{path.name} has {int((~known).sum())} pixels that aren't a nominal ink colour")
    return Pattern(f"image {path.stem}", "image", img, cov)


def make_patterns(w: int, h: int, inks: dict[str, tuple[int, int, int]]) -> list[Pattern]:
    yy, xx = np.mgrid[0:h, 0:w]
    out: list[Pattern] = []
    for n, rgb in inks.items():
        out.append(Pattern(f"solid {n}", "solid", Image.new("RGB", (w, h), rgb), {n: 1.0}, 0.0))
    for a, b in itertools.combinations(inks, 2):
        out.append(_from_mask(f"checker1 {a}/{b}", "checker1", (xx + yy) % 2 == 0, a, b, inks))
    for a, b in itertools.combinations(inks, 2):
        out.append(_from_mask(f"checker2 {a}/{b}", "checker2", (xx // 2 + yy // 2) % 2 == 0, a, b, inks))
    if "black" in inks and "white" in inks:
        out.append(_from_mask("lines-h black/white", "lines-h", yy % 2 == 0, "black", "white", inks))
        out.append(_from_mask("lines-v black/white", "lines-v", xx % 2 == 0, "black", "white", inks))
        out.append(_from_mask("coverage 25% black/white", "coverage", (xx % 2 == 0) & (yy % 2 == 0), "black", "white", inks))
        out.append(_from_mask("coverage 75% black/white", "coverage", ~((xx % 2 == 0) & (yy % 2 == 0)), "black", "white", inks))
        # feature-size series: how fast the deviation fades as the squares grow (checker1/2 are above)
        for s in (4, 8, 16):
            out.append(_from_mask(f"checker{s} black/white", f"checker{s}", (xx // s + yy // s) % 2 == 0, "black", "white", inks))
        # repeated at the end: drift check (temperature, instrument, panel settling over the run)
        out.append(Pattern("solid black (repeat)", "solid", Image.new("RGB", (w, h), inks["black"]), {"black": 1.0}))
        out.append(Pattern("solid white (repeat)", "solid", Image.new("RGB", (w, h), inks["white"]), {"white": 1.0}))
    return out


# --- hardware (and a simulated stand-in) ----------------------------------------------------------

class PatternDisplay:
    """An OpenDisplay board showing arbitrary full-screen images, undithered.

    Modelled on epaper-colorcal's OpenDisplay adapter, but it passes the key to the constructor: with
    py-opendisplay 8 the config is read while connecting, and an encrypted board refuses that read without
    a session (epaper-colorcal 0.6's adapter authenticates only afterwards, so it can't open such a board).
    """

    def __init__(self, address: str, key: bytes | None, settle: float) -> None:
        self._address, self._key, self._settle = address, key, settle
        self._dev = None

    async def connect(self) -> tuple[int, int]:
        import re
        from opendisplay import OpenDisplayDevice
        from opendisplay.exceptions import BLEConnectionError
        by_addr = re.fullmatch(r"([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}|[0-9A-Fa-f-]{36}", self._address)
        from opendisplay.exceptions import BLETimeoutError
        for attempt in range(3):  # a board can miss a scan, or be slow to answer (busy redrawing, WiFi coexistence)
            dev = OpenDisplayDevice(**({"mac_address": self._address} if by_addr else {"device_name": self._address}),
                                    encryption_key=self._key)
            try:
                await dev.__aenter__()  # authenticates (with the key), then reads the config
                break
            except (BLEConnectionError, BLETimeoutError, TimeoutError) as exc:
                if attempt == 2:
                    sys.exit(f"Could not connect to {self._address} ({exc}). Is it awake, in range and free "
                             "(not connected to Home Assistant or the toolbox)?")
                print(f"connect attempt {attempt + 1} failed ({type(exc).__name__}: {exc}); retrying in 15 s", file=sys.stderr)
                try:
                    await dev.__aexit__(None, None, None)
                except Exception:  # noqa: BLE001 - best effort
                    pass
                await asyncio.sleep(15)
        self._dev = dev
        return dev.width, dev.height

    async def temperature(self) -> float | None:
        try:
            from epaper_colorcal.displays.opendisplay import read_board_temperature
            return await read_board_temperature(self._address)
        except Exception:  # noqa: BLE001 - optional; the advertisement may not carry it
            return None

    async def board_status(self) -> dict:
        """The board's MCU chip temperature (not the panel's or the room's) and battery, over the open link."""
        try:
            m = await asyncio.wait_for(self._dev.read_msd(), 20)
            return {"chip_temperature_c": float(m.temperature_c), "battery_mv": int(m.battery_mv)}
        except Exception:  # noqa: BLE001 - optional
            return {}

    def _supports_zip(self) -> bool:
        cfg = self._dev.config
        return bool(cfg.displays[0].supports_zip) if cfg and cfg.displays else True

    async def show(self, p: Pattern) -> None:
        from epaper_dithering import DitherMode
        from opendisplay import prepare_image
        prepared = prepare_image(p.image, config=self._dev.config, dither_mode=DitherMode.NONE,
                                 compress=self._supports_zip())
        _check_unchanged(p, prepared[2])
        await self._dev.upload_prepared_image(prepared)   # returns after the board reports refresh complete
        await asyncio.sleep(self._settle)

    async def close(self) -> None:
        if self._dev is not None:
            await self._dev.__aexit__(None, None, None)
            self._dev = None


def _check_unchanged(p: Pattern, preview: Image.Image) -> None:
    """The board must show exactly our pattern: each nominal colour maps to one ink, consistently."""
    want = np.asarray(p.image.convert("RGB")).reshape(-1, 3)
    got = np.asarray(preview.convert("RGB").resize(p.image.size, Image.NEAREST)).reshape(-1, 3)
    keys_w = want[:, 0].astype(np.int64) << 16 | want[:, 1].astype(np.int64) << 8 | want[:, 2]
    keys_g = got[:, 0].astype(np.int64) << 16 | got[:, 1].astype(np.int64) << 8 | got[:, 2]
    pairs = set(zip(keys_w.tolist(), keys_g.tolist()))
    if len(pairs) != len(set(keys_w.tolist())) or len({g for _, g in pairs}) != len(pairs):
        raise RuntimeError(f"{p.name}: the prepared image doesn't match the pattern ({len(pairs)} colour pairs)")


class SimDisplay:
    """Dry run: a pretend panel whose inks mix linearly, darkened a little at ink boundaries."""

    def __init__(self) -> None:
        self.current: Pattern | None = None

    async def connect(self) -> tuple[int, int]:
        return 1200, 1600

    async def temperature(self) -> float | None:
        return 21.0

    async def board_status(self) -> dict:
        return {"chip_temperature_c": 25.0}

    async def show(self, p: Pattern) -> None:
        self.current = p

    async def close(self) -> None:
        pass


WL = tuple(float(w) for w in range(400, 710, 10))


def _sim_ink(name: str) -> np.ndarray:
    w = np.array(WL)
    step = lambda c, s: 1 / (1 + np.exp(-(w - c) / s))  # noqa: E731
    return {"black": 3 + 0 * w, "white": 35 + 0 * w, "yellow": 3 + 32 * step(500, 12),
            "red": 3 + 30 * step(590, 10), "blue": 3 + 22 * np.exp(-((w - 450) / 30) ** 2),
            "green": 3 + 15 * np.exp(-((w - 530) / 35) ** 2)}[name]


class SimInstrument:
    def __init__(self, display: SimDisplay) -> None:
        self._d = display
        self._rng = np.random.default_rng(1)

    async def __aenter__(self) -> SimInstrument:
        return self

    async def __aexit__(self, *exc: object) -> None:
        pass

    async def measure(self) -> Spectrum:
        p = self._d.current
        assert p is not None, "show() before measure()"
        r = sum(f * _sim_ink(n) for n, f in p.coverage.items()) * (1 - 0.06 * p.boundary)
        return Spectrum(WL, tuple(float(v) for v in r + self._rng.normal(0, 0.05, len(WL))))


# --- measuring ------------------------------------------------------------------------------------

async def run(args: argparse.Namespace) -> None:
    out = Path(args.out)
    results: dict = json.loads(out.read_text()) if args.resume and out.exists() else {}
    display: SimDisplay | PatternDisplay
    if args.dry_run:
        sim = SimDisplay()
        display, instrument = sim, SimInstrument(sim)
    else:
        if not args.address or not chosen(args):
            sys.exit("Need --address and an instrument (--cr30-ble [NAME] or --port PORT), or --dry-run.")
        display = PatternDisplay(args.address, bytes.fromhex(args.key) if args.key else None, args.settle)
        instrument = open_instrument(args)

    temp = args.temp if args.temp is not None else await display.temperature()
    w, h = await display.connect()
    patterns = make_patterns(w, h, SPECTRA6)
    if args.images:
        # measure arbitrary full-screen images (e.g. dithered test colours), after the six solid inks
        patterns = [p for p in patterns if p.kind == "solid" and "repeat" not in p.name]
        for f in sorted(Path(args.images).glob("*.png")):
            patterns.append(_image_pattern(f, w, h))
    if args.only:
        patterns = [p for p in patterns if any(s in p.name for s in args.only.split(","))]
    if args.check_every:
        # solid black and white measured again every N patterns, to track drift through the run
        checked: list[Pattern] = []
        for i, p in enumerate(patterns, 1):
            checked.append(p)
            if i % args.check_every == 0 and i < len(patterns):
                k = i // args.check_every
                for ink in ("black", "white"):
                    checked.append(Pattern(f"solid {ink} (check {k})", "solid", Image.new("RGB", (w, h), SPECTRA6[ink]), {ink: 1.0}))
        patterns = checked
    # Shown (not measured) before every pattern: the panel keeps a trace of the previous image (a 2x2
    # checkerboard read ΔE00 5.6 apart after solid white vs after a 1x1 checkerboard), so each pattern
    # starts from the same state.
    reset = Pattern(f"reset {args.reset}", "reset", Image.new("RGB", (w, h), SPECTRA6[args.reset]), {args.reset: 1.0}) if args.reset else None
    meta = results.setdefault("meta", {})
    meta.update({"address": args.address, "panel": f"{w}x{h}", "temperature_c": temp, "count": args.count,
                 "started": meta.get("started", dt.datetime.now().isoformat(timespec="seconds")),
                 "dry_run": args.dry_run, "reset": args.reset, "check_every": args.check_every,
                 "room_temperature_c": args.room_temp})
    done = results.setdefault("patterns", {})
    tag = args.tag or ""
    todo = [p for p in patterns if p.name + tag not in done]
    print(f"{len(todo)} of {len(patterns)} patterns to measure on a {w}x{h} panel"
          + (f", {temp} °C" if temp is not None else ""), file=sys.stderr)
    try:
        async with instrument:
            if args.calibrate and not args.dry_run:
                if args.go_file:
                    async def ask(prompt: str) -> str:
                        # for unattended runs: wait for the file instead of Enter, then remove it
                        go = Path(args.go_file)
                        print(f"{prompt}[waiting for {go}]", file=sys.stderr, flush=True)
                        while not go.exists():
                            await asyncio.sleep(0.5)
                        go.unlink()
                        return ""
                else:
                    from epaper_colorcal.prompts import ask
                await ask("Close the CR30 cap fully (black calibration), then press Enter… ")
                if not await instrument.calibrate_black():
                    sys.exit("Black calibration failed.")
                await ask("Keep the cap closed (white calibration), then press Enter… ")
                if not await instrument.calibrate_white():
                    sys.exit("White calibration failed.")
                await ask("Calibrated. Seat the CR30 flat in the middle of the panel and leave it there, then press Enter… ")
            for i, p in enumerate(todo, 1):
                t0 = asyncio.get_running_loop().time()
                if reset is not None:
                    await display.show(reset)
                await display.show(p)
                spectra = [await instrument.measure() for _ in range(args.count)]
                reads = [reading_from_spectrum(s) for s in spectra]
                mean = reading_from_spectrum(average_spectra(spectra))
                spread = max(colour.delta_E(np.array(r.lab_d65), np.array(mean.lab_d65), method="CIE 2000") for r in reads)
                done[p.name + tag] = {
                    "kind": p.kind, "coverage": p.coverage, "boundary": p.boundary,
                    "xyz_d65": list(mean.xyz_d65), "lab_d65": list(mean.lab_d65),
                    "spectrum": {"wavelengths": list(spectra[0].wavelengths),
                                 "values": list(average_spectra(spectra).values)},
                    "read_spread_de00": float(spread),
                    **(await display.board_status()),
                    "time": dt.datetime.now().isoformat(timespec="seconds"),
                }
                out.write_text(json.dumps(results, indent=1))
                L, a, b = mean.lab_d65
                print(f"[{i:2}/{len(todo)}] {p.name + tag:28} L* {L:6.2f} a* {a:6.2f} b* {b:6.2f}  "
                      f"(reads within ΔE00 {spread:.2f}, {asyncio.get_running_loop().time() - t0:.0f} s)", file=sys.stderr)
    finally:
        await display.close()
    analyse(results)


# --- analysis -------------------------------------------------------------------------------------

def _lab(xyz: np.ndarray) -> np.ndarray:
    return colour.XYZ_to_Lab(xyz, D65)


def analyse(results: dict) -> None:
    pats = results.get("patterns", {})
    solids: dict[str, list[np.ndarray]] = {}
    for name, r in pats.items():
        if r["kind"] == "solid":
            ink = next(iter(r["coverage"]))
            solids.setdefault(ink, []).append(np.array(r["xyz_d65"]))
    if not solids:
        print("No solid inks measured yet.")
        return
    solid = {k: np.mean(v, axis=0) for k, v in solids.items()}
    for ink in ("black", "white"):
        if len(solids.get(ink, [])) == 2:
            print(f"drift over the run, {ink}: ΔE00 {float(colour.delta_E(_lab(solids[ink][0]), _lab(solids[ink][1]), method='CIE 2000')):.2f}")
    print(f"\n{'pattern':28} {'measured L*a*b*':>22} {'linear-mix prediction':>24} {'ΔE00':>6} {'Y meas/pred':>11} {'boundary':>8}")
    rows = []
    for name, r in pats.items():
        if r["kind"] == "solid" or not all(k in solid for k in r["coverage"]):
            continue
        pred = sum(f * solid[k] for k, f in r["coverage"].items())
        meas = np.array(r["xyz_d65"])
        de = float(colour.delta_E(_lab(meas), _lab(pred), method="CIE 2000"))
        yr = meas[1] / pred[1]
        rows.append((r["kind"], name, de, yr, r["boundary"]))
        lm, lp = _lab(meas), _lab(pred)
        print(f"{name:28} {lm[0]:6.1f} {lm[1]:6.1f} {lm[2]:6.1f}     {lp[0]:6.1f} {lp[1]:6.1f} {lp[2]:6.1f}   {de:6.2f} {yr:11.3f} {r['boundary']:8.2f}")
    print()
    for kind in ("checker1", "checker2", "checker4", "checker8", "checker16", "lines-h", "lines-v", "coverage"):
        sel = [x for x in rows if x[0] == kind]
        if sel:
            print(f"{kind:9}: mean ΔE00 {np.mean([x[2] for x in sel]):.2f}, max {max(x[2] for x in sel):.2f}, "
                  f"mean Y meas/pred {np.mean([x[3] for x in sel]):.3f}  ({len(sel)} patterns)")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    if len(sys.argv) > 1 and sys.argv[1] == "analyse":
        analyse(json.loads(Path(sys.argv[2]).read_text()))
        return
    if len(sys.argv) > 1 and sys.argv[1] == "show":
        # show a full-screen image (nominal ink colours) on the board, without measuring
        sp = argparse.ArgumentParser(prog="measure-mixing.py show")
        sp.add_argument("image")
        sp.add_argument("--address", required=True)
        sp.add_argument("--key")
        a = sp.parse_args(sys.argv[2:])

        async def show_one() -> None:
            d = PatternDisplay(a.address, bytes.fromhex(a.key) if a.key else None, 0.0)
            w, h = await d.connect()
            try:
                await d.show(_image_pattern(Path(a.image), w, h))
            finally:
                await d.close()
        asyncio.run(show_one())
        print(f"shown: {a.image}")
        return
    ap.add_argument("--address", help="the OpenDisplay board: its name (e.g. OD216205), MAC or macOS UUID")
    ap.add_argument("--key", help="the board's encryption key (32 hex characters), if it has one")
    add_instrument_options(ap)
    ap.add_argument("--calibrate", action="store_true",
                    help="explicit black/white calibration first, with the cap closed (CR30 over USB); "
                         "the CR30 also calibrates itself against its cap")
    ap.add_argument("--go-file", help="with --calibrate: each prompt waits for this file to appear (and removes it) "
                                      "instead of Enter, for runs started from somewhere without a terminal")
    ap.add_argument("--reset", choices=list(SPECTRA6), help="show this solid ink (not measured) before every pattern, "
                                                            "so each starts from the same state (the panel keeps a trace of the last image)")
    ap.add_argument("--check-every", type=int, default=0, metavar="N",
                    help="measure solid black and white again after every N patterns, to track drift")
    ap.add_argument("--count", type=int, default=3, help="reads averaged per pattern (default 3)")
    ap.add_argument("--settle", type=float, default=3.0, help="extra seconds after the refresh completes (default 3)")
    ap.add_argument("--temp", type=float, help="panel temperature in °C (default: what the board reports)")
    ap.add_argument("--room-temp", type=float, help="room temperature in °C, recorded with the results (the board only reports its MCU chip temperature)")
    ap.add_argument("--only", help="comma-separated substrings: measure only matching patterns (e.g. 'solid,checker1 black')")
    ap.add_argument("--images", help="measure the PNGs in this directory (full-screen, nominal ink colours only) "
                                     "instead of the generated patterns, after the six solid inks")
    ap.add_argument("--out", required=True, help="results JSON, written after every pattern")
    ap.add_argument("--resume", action="store_true", help="skip patterns already in --out")
    ap.add_argument("--tag", help="suffix for the stored pattern names, to measure patterns again (e.g. ' r2')")
    ap.add_argument("--dry-run", action="store_true", help="simulated panel and instrument, no hardware")
    asyncio.run(run(ap.parse_args()))


if __name__ == "__main__":
    main()
