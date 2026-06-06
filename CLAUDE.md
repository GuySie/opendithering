# OpenDithering

A static web app that dithers images for e-paper displays. Runs entirely in the browser (Canvas API, no server). Deployable to GitHub Pages.

## Commands

```bash
npm install       # install dependencies
npm run dev       # dev server at http://localhost:5173
npm run build     # type-check + production build into dist/
npm run preview   # serve the dist/ build locally
```

## Architecture

### Key concept: dual-palette system

Every palette color carries two RGB triplets:
- `measured` — the color as it actually appears on the physical device (calibrated from real hardware)
- `ideal` — the RGB value the device firmware expects to produce that color

Dithering runs against `measured` colors so that the error diffusion matches what the eye will see on the device. After dithering, a palette swap replaces every `measured` pixel with its `ideal` counterpart. The **preview always shows measured colors** (realistic appearance); the **exported PNG uses ideal colors** (for firmware).

### Palette groups and calibration variants

Palettes are organised as `PaletteGroup`s. Each group (e.g. `spectra6`) holds one or more `Palette` variants — each variant is a complete set of `measured`+`ideal` colors for that ink type. The registry auto-generates an **"Ideal"** variant for every group by mapping each color's `ideal` as its `measured`; this lets users dither against the firmware's reference values directly (no remapping step needed, since measured === ideal).

The UI shows a **Calibration** dropdown (always visible) and a row of **color swatches** below it. Each swatch is split: the top half shows the measured color, the bottom half shows the ideal color.

**Variant naming convention:** use the source name as the variant name (e.g. `EPDOptimize`, `aitjcize`). If the origin is unknown, use `Estimated`. The auto-generated variant is always named `Ideal`. Do not use "Default".

**Current variant sources:**
- `spectra6` — **EPDOptimize**: `paperlesspaper/epdoptimize` `default-palettes.json` (`spectra6` entry); **aitjcize**: `aitjcize/esp32-photoframe` `main/color_palette.c` (`color_palette_get_defaults`); **Wenting**: `mattcarter11/eink-dithering-tester` `src/config.js` (`wenting` const); **EPDOptimize (Legacy)**: independently confirmed by Rayman, Parallax forums post 177818 (2026-01-11), `SPECTRA6_REAL_WORD_RGB`
- `acep` — **EPDOptimize**: `paperlesspaper/epdoptimize` `default-palettes.json` (`acep` entry)
- `bw`, `bwr`, `bwry`, `grayscale4`, `grayscale8` — **Estimated**: origin unknown; do not label as calibrated
- `grayscale16` — **Estimated**: origin unknown; **Measured**: photographed from a physical Seeed reTerminal E1003 panel (guysie)

To add a calibration variant to an existing palette, add another `Palette` entry to its `variants` array in the palette file. The registry picks it up automatically.

### Processing pipeline (order matters)

Implemented in `src/processing/pipeline.ts`:

1. **Resize** — cover / contain / stretch / none (`src/processing/resize.ts`)
2. **Dynamic range compression** — maps luminance into the display's actual `[black_Y, white_Y]` range using Rec. 709 coefficients and sRGB↔linear conversion
3. **Tone mapping** — contrast mode (scale around midpoint) or S-curve (strength / shadowBoost / highlightCompress / midpoint)
4. **Saturation** — HSL-space channel scaling
5. **Exposure** — linear multiply + clamp
6. **Dithering** — selected algorithm against `measured` palette colors (or expanded palette if `expandPalette` is on)
7. **Remap primaries** — if `expandPalette` was used, pixels that landed on a pure primary are remapped back to the nearest original measured color before export or preview
8. **Palette swap** — measured → ideal (export only)

The **Balanced**, **Vivid**, and **Soft** presets match the corresponding presets in `aitjcize/esp32-photoframe` `@aitjcize/epaper-image-convert` exactly (tone mapping, algorithm, and color method). The **Grayscale** preset diverges intentionally: aitjcize uses `scurve` + LAB + floyd-steinberg; OpenDithering uses `contrast` + OKLab + Dizzy.

### File structure

```
src/
├── types.ts                    # All interfaces + preset definitions
├── palettes/
│   ├── index.ts               # Registry: getPaletteGroup(id), getAllPaletteGroups(), getPaletteVariant(groupId, variantId)
│   ├── bw.ts                  # 2-color
│   ├── bwr.ts                 # 3-color (BWR)
│   ├── bwry.ts                # 4-color (BWRY)
│   ├── spectra6.ts            # 6-color (Spectra 6 panels)
│   ├── acep.ts                # 7-color (Gallery / ACeP panels)
│   └── grayscale.ts           # 4-level, 8-level, and 16-level
├── displays/
│   └── presets.ts             # Device preset registry (name, W×H, paletteGroupId)
├── dithering/
│   ├── index.ts               # Registry: getAlgorithm(id), getAllAlgorithms()
│   ├── error-diffusion.ts     # Shared serpentine-scan engine + findNearestColor
│   ├── floyd-steinberg.ts
│   ├── atkinson.ts
│   ├── jarvis.ts              # Jarvis-Judice-Ninke
│   ├── stucki.ts
│   ├── burkes.ts              # 2-row kernel (simplified Stucki), divisor 32
│   ├── sierra.ts
│   ├── bayer.ts               # Ordered dithering: bayer4 (4×4) and bayer8 (8×8) — registered but hidden from UI dropdown
│   ├── riemersma.ts           # Hilbert-curve traversal + exponential error queue (standalone)
│   ├── dizzy.ts               # Dizzy (2024, Liam Appelbe): Fisher-Yates random-order traversal, proportional error to orthogonal (w=1) + diagonal (configurable, default 0.1) unprocessed neighbours (standalone)
│   └── knox.ts                # Eschbach & Knox: tone-dependent error diffusion in OKLab with fringe-field and cross-edge suppression (standalone)
├── processing/
│   ├── colorspace.ts          # sRGB↔linear, RGB→L*a*b*, RGB→OKLab, deltaE_rgb/lab/oklab, rec709Luminance
│   ├── tone.ts                # compressDynamicRange, applyToneMapping, applySaturation, applyExposure
│   ├── resize.ts              # resizeImage (cover/contain/stretch/none)
│   ├── pipeline.ts            # runPipeline() — orchestrates all steps, returns {measured, ideal}
│   └── autotune.ts            # autoTune() — convergence-checked optimizer for saturation/exposure/highlightCompress
├── ble/
│   ├── opendisplay.ts         # OpenDisplay BLE upload: isSupported(), encodeImage(), connectDevice(), sendImage()
│   └── gicisky.ts             # Gicisky BLE upload: isSupported(), encodeImage(), connectDevice(), sendImage()
├── main.ts                    # All UI logic, state, event wiring
└── style.css
```

### Extending the app

**Add a palette:** create `src/palettes/<name>.ts` exporting a `PaletteGroup` with at least one variant in its `variants` array, then call `registerPaletteGroup()` in `src/palettes/index.ts`. The registry automatically appends an "Ideal" variant. Variant ids should follow the pattern `${groupId}-<slug>` (e.g. `spectra6-mydevice`).

**Add a dithering algorithm:** create `src/dithering/<name>.ts` exporting a `DitheringAlgorithm`, register it in `src/dithering/index.ts`. Kernel-based error-diffusion algorithms only need to call `errorDiffuse(src, palette, errorSpace, distSpace, strength, kernel, divisor)`. Algorithms with custom traversal order (e.g. Riemersma, Bayer, Eschbach & Knox) implement `dither()` standalone — import color-space helpers directly from `../processing/colorspace` and reuse the `findNearestColor` export from `error-diffusion.ts` if needed.

**Algorithm-specific parameters:** the `dither()` signature accepts an optional `extraParams?: Record<string, number>` as its last argument. The pipeline always passes all algorithm param keys; algorithms ignore the ones they don't use. Current keys:

| Key | Algorithm | Default | Notes |
|-----|-----------|---------|-------|
| `serpentine` | FS, Atkinson, Burkes, Jarvis, Sierra, Stucki, Knox | 1 | 1 = alternate scan direction each row, 0 = always left-to-right |
| `knoxAlpha` | Eschbach & Knox | 0.5 | tone-dependency strength |
| `knoxFringe` | Eschbach & Knox | 0.04 | fringe field L-threshold raise per fired neighbour |
| `knoxEdgeSensitivity` | Eschbach & Knox | 4.0 | gradient scale for cross-edge suppression |
| `riemersmaQueueSize` | Riemersma | 16 | error history queue length (4–64) |
| `dizzyDiagonalWeight` | Dizzy | 0.1 | diagonal neighbour weight relative to orthogonal (0–1) |

To add a new algorithm-specific UI control: add a slider to `index.html` (inside a hidden `<div id="panelXxx">`), add the field to `ProcessingSettings` in `src/types.ts` (with a default in `BALANCED_PRESET`), wire the slider listener and show/hide logic in `src/main.ts` (`algorithmSelect` change handler + `syncSlidersFromSettings`), and pass the value in the `extraParams` object in `src/processing/pipeline.ts`.

**Add a display preset:** add an entry to the `DISPLAY_PRESETS` array in `src/displays/presets.ts`. Set `paletteGroupId` to the id of the relevant `PaletteGroup` (e.g. `'spectra6'`, `'acep'`, `'bw'`).

### Color space system

`ProcessingSettings` carries two independent color space fields for dithering:

- `errorSpace: ColorSpace` — the space in which quantization error is accumulated and diffused to neighbours. The `errorDiffuse()` float buffer is stored in this space.
- `distSpace: ColorSpace` — the space used to find the nearest palette color. Can differ from `errorSpace`.

`ColorSpace` is `'rgb' | 'cielab' | 'oklab'`. For Bayer (ordered) dithering only `distSpace` applies — there is no error buffer.

The UI exposes five named presets via a "Color matching" dropdown: RGB (full), CIELAB distance, CIELAB (full), OKLab distance, OKLab (full). Below the dropdown, two read-only text fields show the active spaces — "Find color using" (`distSpace`) and "Diffuse error in" (`errorSpace`) — and update automatically when the preset changes. There is no manual/advanced mode; all valid combinations are covered by the presets. `deltaE_lab` uses `2·dL² + da² + db²` (L weighted double) for CIELAB distance; `deltaE_oklab` uses plain Euclidean.

**Expand palette** (`expandPalette: boolean`): before dithering, six pure primaries (`[0,0,0]`, `[255,255,255]`, `[255,0,0]`, `[0,255,0]`, `[0,0,255]`, `[255,255,0]`) are appended to the working palette as extra snap-points. After dithering, `remapToOriginalPalette()` replaces any pixel that landed on a primary with the nearest original measured color, so the preview and export are unaffected.

**Diffusion strength** (`ditherStrength: number`, 0–1): multiplies the error before it is forwarded to neighbours. Default 1.0 (full diffusion).

**Eschbach & Knox parameters** (Eschbach & Knox only — `errorSpace`/`distSpace` ignored, always OKLab):
- `knoxAlpha` (0–1, default 0.5): tone-dependency strength. At α=0 diffusion is uniform; at α=1 the full Knox `4t(1−t)` curve applies — midtones get full diffusion, highlights and shadows get none.
- `knoxFringe` (0–0.15, default 0.04): OKLab L-threshold raise applied to unprocessed 4-connected neighbours after each pixel fires. Models physical ink bleed (fringe field effect); tune per device.
- `knoxEdgeSensitivity` (0.5–8, default 4.0): scales the gradient magnitude used for cross-edge suppression. At 4.0 a ΔL of 0.25/px gives full suppression; lower values require steeper edges to suppress, higher values suppress at gentler gradients.

**Riemersma queue size** (`riemersmaQueueSize: number`, 4–64, default 16): length of the exponential error-history queue traversed along the Hilbert curve. Longer queues spread error over more pixels (smoother gradients, less grain); shorter queues are more local.

**Dizzy diagonal weight** (`dizzyDiagonalWeight: number`, 0–1, default 0.1): weight of diagonal neighbours relative to orthogonal (always 1) in Dizzy's proportional error distribution. 0 = pure 4-connected diffusion; 1 = equal 8-connected spreading.

### Palette color values

The `ideal` values are the nominal RGB codes the firmware expects (e.g. pure `[255,0,0]` for red). The `measured` values vary by variant — see variant sources listed under "Palette groups and calibration variants" above. When adding real device measurements, add a new named variant rather than overwriting an existing one.

### Auto-tune

Implemented in `src/processing/autotune.ts`. `autoTune()` adjusts `saturation`, `exposure`, and (in s-curve mode) `highlightCompress` to make the dithered output match the source image as closely as possible, measured by L1 distance in Oklab L+C (`|ΔmeanL| + |ΔmeanC|`).

**Algorithm:**
1. Resize the source to the display dimensions and compute reference stats (`refStats`: meanL, meanC, highlightFraction).
2. Run the pipeline once with the current settings to establish a baseline loss.
3. Each iteration: compute ratio-based candidate adjustments (50% damping on saturation, 30% on exposure, both with ±15% per-run caps relative to the initial values), run the pipeline with the candidate settings, compute the new loss. If `newLoss >= prevLoss`, revert to the last best and stop. Otherwise commit and continue.
4. Maximum 8 iterations; early termination via the convergence check is the normal stopping condition.

**Idempotency:** pressing Auto-tune a second time runs the baseline pass and tries one candidate — if the candidate doesn't improve, it breaks immediately and returns unchanged settings. This means repeated clicks are a no-op once the algorithm has converged.

**Saturation and the discrete-palette floor:** the dithered output's mean chroma will always be ≤ the source's, because palette quantization clips the range. The ±15% per-run saturation cap prevents unbounded drift; the convergence check catches the point where further increases no longer improve the dithered output.

**Return value:** `AutoTuneResult` — `{ saturation, exposure, highlightCompress, debug: AutoTuneDebug }`. The `AutoTuneDebug` struct carries `iterationsRun`, `converged`, `refStats`, `initialStats`, `finalStats`, `initialLoss`, `finalLoss`, `lossHistory` (baseline + loss after each committed iteration), and the before/after values for all three parameters. The debug panel in the UI (`#debugAutoTune`) renders this after each run.

### OpenDisplay BLE upload

Implemented in `src/ble/opendisplay.ts`. Sends the already-dithered `ideal` ImageData directly to an OpenDisplay-compatible e-paper device over Web Bluetooth. Requires Chrome or Edge (Web Bluetooth is not supported in Firefox or Safari).

**Protocol** (OpenDisplay direct-write, service/characteristic UUID `0x2446`, device name prefix `OD`):
1. `navigator.bluetooth.requestDevice()` → connect GATT → get characteristic → `startNotifications()`
2. Send `[0x00, 0x70]` (start direct write, no payload — device reads its own dimensions/color-scheme from firmware config)
3. Receive `[0x00, 0x70]` ack → send `[0x00, 0x71, ...chunk]` chunks of up to 230 bytes, one at a time
4. Receive `[0x00, 0x71]` ack per chunk → send next chunk
5. After all chunks: send `[0x00, 0x72]` (end / full refresh)
6. Receive `[0x00, 0x73]` → refresh complete, Promise resolves

**Palette → OpenDisplay color scheme mapping:**

| Palette group | Scheme | Encoding |
|---|---|---|
| `bw` | 0 | 1 bit/pixel, 8 px/byte, MSB first |
| `bwr` | 1 | 2 bitplanes (plane1 then plane2), 1 bit/pixel each |
| `bwry` | 3 | 2 bits/pixel, 4 px/byte, MSB first |
| `spectra6` | 4 | 4 bits/pixel nibble-packed (black=0, white=1, yellow=2, red=3, blue=5, green=6) |
| `acep` | — | **Unsupported** — 7-color has no matching scheme; upload button disabled |
| `grayscale4` | 5 | 2 bits/pixel, 4 px/byte, MSB first |
| `grayscale8` | 6 | 4 bits/pixel nibble-packed, Rec.709 luminance → 0–15 |
| `grayscale16` | 6 | 4 bits/pixel nibble-packed, Rec.709 luminance → 0–15 |

Because the `ideal` ImageData already contains exact palette RGB values, `encodeImage()` uses direct colour matching rather than nearest-colour search. The BLE connection is maintained between uploads and reused on subsequent sends. The `gattserverdisconnected` device event clears it if the device drops the link.

The Export section UI provides: an **↑ OpenDisplay BLE** / **↑ Gicisky BLE** split button (label reflects the active protocol), a **▾** dropdown with **OpenDisplay** / **Gicisky** protocol switchers plus **Connect** and **Disconnect** items, a shared connection status indicator, and a browser-compatibility hint. Switching protocol auto-disconnects the current connection. The active protocol is tracked in `bleProtocol` (`'opendisplay' | 'gicisky'`) and the connection in `bleState` (a discriminated union typed by protocol) in `main.ts`.

**Types dependency:** `@types/web-bluetooth` (dev dependency); `tsconfig.json` includes `"types": ["web-bluetooth"]`.

### Gicisky BLE upload

Implemented in `src/ble/gicisky.ts`. Sends the already-dithered `ideal` ImageData to Gicisky / Picksmart ESL badge devices over Web Bluetooth. Requires Chrome or Edge.

**BLE identifiers** (confirmed via `eigger/hass-gicisky` and `atc1441/ATC_GICISKY_ESL`):
- Manufacturer ID: `0x5053` (used as device filter)
- Service UUID: `0xFEF0`
- CMD characteristic: `0xFEF1` — commands out, notifications in
- IMG characteristic: `0xFEF2` — image data out

These UUIDs are consistent across all known Gicisky/Picksmart ESL models.

**Protocol** (4-step state machine, references: `eigger/hass-gicisky`, `fpoli/gicisky-tag`):
1. Write `[0x01]` to CMD → ack `[0x01, lo, hi]` where bytes 1–2 are the device's preferred block size (LE; typically `0xF4 0x00` = 244, giving a 240-byte payload after the 4-byte part-index header)
2. Write `[0x02, size LE4B, 0x00 0x00 0x00]` to CMD (8 bytes; or `[0x02, size LE4B, 0x01]` 6 bytes for mode2 devices) → ack `[0x02, ...]`
3. Write `[0x03]` to CMD → ack `[0x05, 0x00, ...]`
4. Loop: write `[partIdx LE4B, ...≤240B chunk]` to IMG → ack `[0x05, 0x00, nextPartIdx LE4B]` on CMD; `status != 0x00` signals completion. Stall guard: 3× identical part index → error.

Each step has a 5-second timeout. Notifications are always received on CMD; image data is always written to IMG.

**Device detection and compression:** After connecting, `connectDevice()` uses `watchAdvertisements()` (Chrome 87+) to read manufacturer data bytes 0 and 4, computing `deviceId = ((data[4] << 8) | data[0]) & 0x3FFF`. This is looked up in `DEVICE_TABLE` to determine compression mode and `invertLuminance`. Falls back to `compression: 'none'` if advertisement data is unavailable.

**Palette → Gicisky encoding:**

| Palette | Format | Notes |
|---|---|---|
| `bw` | 1 bit/pixel, 8 px/byte MSB-first | bit=1 for white; inverted if `invertLuminance` |
| `bwr` | 2 separate 1-bit planes (BW then Red) | BW plane: 1=white (or 1=non-white if `invertLuminance`); Red plane: 1=red |
| `bwry` | 2 bits/pixel, 4 px/byte MSB-first | black=00, white=01, yellow=10, red=11 |
| `spectra6`, `acep`, `grayscale*` | **Unsupported** | upload button disabled |

**Compression modes** (device-dependent, from `DEVICE_TABLE`):

| Mode | Devices | Format |
|---|---|---|
| `none` | Most small devices (2.1", 2.9", 4.2") | Raw plane bytes concatenated |
| `mode1` | 3.7" EPD (device ID `0x022B`) | `[4B LE total_len]` + per-column chunks: `[0x75][bytePerLine+7][bytePerLine][0x00×4][...column bytes]` |
| `mode2` | 7.5" (`0x012B`), 10.2" (`0x008B`) | BW+Red planes concatenated, split in half, each half wrapped in 64-byte uncompressed chunks: `[4B LE part2_len][0x74][total_len][n][...data] ...` |

`mode2` currently uses force-raw (no QuickLZ) matching the current HA integration behaviour.

### Auto-orientation

When an image is activated or a display preset is changed, `autoOrientDisplay()` compares the image's aspect ratio to the display's aspect ratio. If they don't match (one is portrait, the other landscape), it swaps `displayWidth` and `displayHeight` automatically and updates the dimension inputs.

### Zoom / pan

Clicking either preview canvas zooms to 1:1 pixels, centered on the click point. Dragging pans both canvases in sync. Clicking again returns to fit view. Changing any setting exits zoom mode. Implemented via `position: absolute` canvas inside an `overflow: hidden` `.canvas-viewport` div; both canvases receive the same `transform: translate()`.

## Deployment

Push to `main` — GitHub Actions (`.github/workflows/deploy.yml`) runs `npm ci && npm run build` and deploys `dist/` to the `gh-pages` branch. Requires GitHub Pages to be configured to serve from `gh-pages` in the repository settings.

`vite.config.ts` uses `base: './'` so all asset paths are relative, which is required for GitHub Pages subdirectory hosting.
