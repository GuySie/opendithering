# OpenDithering

A static web app that dithers images for e-paper displays. Runs entirely in the browser (Canvas API, no server). Deployable to GitHub Pages.

## Commands

```bash
npm install       # install dependencies
npm run dev       # dev server at http://localhost:5173
npm run build     # type-check + production build into dist/
npm run preview   # serve the dist/ build locally
npm run bench     # S-CIELAB benchmark of all algorithms + DBS (see "Benchmark" below)
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
- `spectra6` — **OpenDisplay**: `OpenDisplay/epaper-dithering` `measured_palettes.rs` (`SPECTRA_7_3_6COLOR_V2`), iPhone 15 Pro Max ProRAW + Affinity v3, A4 paper white reference, 2026-03-15, 7.3" panel; **EPDOptimize**: `paperlesspaper/epdoptimize` `default-palettes.json` (`spectra6` entry); **aitjcize**: `aitjcize/esp32-photoframe` `main/color_palette.c` (`color_palette_get_defaults`); **Wenting**: `mattcarter11/eink-dithering-tester` `src/config.js` (`wenting` const); **EPDOptimize (Legacy)**: independently confirmed by Rayman, Parallax forums post 177818 (2026-01-11), `SPECTRA6_REAL_WORD_RGB`; **guysie**: CHNSpec CR30, D65/2°, measured directly as sRGB from raw reflectance spectra (`colour.XYZ_to_sRGB` on D65-integrated XYZ, via `epaper-colorcal`; not Lab-sourced), average of 10 reads per color across two independent sessions (5 each, agreeing to within ΔE 0.1–0.5 per color; raw data: `epaper-colorcal`'s `reference/spectra_7_3_6color_cr30_*.json`, field `srgb_d65`), 26 °C ambient, 2026-07-30, 7.3" panel; **GoodDisplay**: GDEP133C02 13.3" datasheet rev 1.0 (2024-05-30) §8.1 typical L\*a\*b\* values (Eye-One Pro3 Plus spectrophotometer, 25 °C), absolute D65/2° Lab→sRGB conversion
- `acep` — **EPDOptimize**: `paperlesspaper/epdoptimize` `default-palettes.json` (`acep` entry)
- `bw`, `bwr`, `grayscale4`, `grayscale8` — **Estimated**: origin unknown; do not label as calibrated
- `bwry` — **OpenDisplay**: `OpenDisplay/epaper-dithering` `measured_palettes.rs` (`BWRY_3_97`), iPhone RAW, paper reference, 2026-03-06, EP397YR 3.97" 800×480 panel; **Estimated**: origin unknown; do not label as calibrated
- `grayscale16` — **Estimated**: origin unknown; **Measured**: photographed from a physical Seeed reTerminal E1003 panel (guysie)

To add a calibration variant to an existing palette, add another `Palette` entry to its `variants` array in the palette file. The registry picks it up automatically.

**Lab-sourced variants:** when a measurement originates as CIELAB (colorimeter or datasheet), record it in the optional `measuredLab` field (`[L*, a*, b*]`, D65/2°, absolute — no white normalisation). The registry derives `measured` sRGB from it at registration via `labToRgb()` in `src/processing/colorspace.ts`, so all Lab-sourced variants share one canonical conversion; the `measured` value written in the file is just a readable cache of that derivation. Variants measured directly in RGB omit `measuredLab`.

### Processing pipeline (order matters)

Implemented in `src/processing/pipeline.ts`:

1. **Resize** — cover / contain / stretch / none (`src/processing/resize.ts`)
2. **Clarity** — midtone-weighted unsharp mask (`applyClarity` in `src/processing/tone.ts`); weight peaks at 50% grey and fades at black/white so quantised extremes are unaffected; positive = sharpen, negative = blur; applied before DRC so tone compression doesn't amplify sharpening artefacts
3. **Dynamic range compression** — maps luminance into the display's actual `[black_Y, white_Y]` range using Rec. 709 coefficients and sRGB↔linear conversion. With `drcMode: 'whitepoint'` ("Panel white point", experimental) steps 3 and 4 swap: the tone curve runs first, then `mapToPanelWhitePoint()` adapts the colour balance to the panel's measured white before compressing — see "Panel white point mapping" below
4. **Tone mapping** — contrast mode (scale around midpoint) or S-curve (strength / shadowBoost / highlightCompress / midpoint)
5. **Saturation** — HSL-space channel scaling, followed immediately by `applyHueSatBands` (per-hue saturation multipliers for Red / Yellow / Green / Cyan / Blue / Magenta)
6. **Exposure** — linear multiply + clamp
7. **Channel gains** — per-channel R/G/B multipliers for color grading (`redGain`, `greenGain`, `blueGain`)
7.5. **Gamut mapping** (optional, `gamutMapping`) — pulls target colours the panel can't reproduce onto the boundary of its gamut (`src/processing/gamut.ts`, see "Gamut mapping" below)
8. **Dithering** — selected algorithm against `measured` palette colors (or expanded palette if `expandPalette` is on)
8. **Remap primaries** — if `expandPalette` was used, pixels that landed on a pure primary are remapped back to the nearest original measured color before export or preview
9. **Palette swap** — measured → ideal (export only)

Steps 1.5–7.5 are `applyAdjustments(img, palette, settings)` and step 8 (incl. Expand palette) is `ditherStep(img, palette, settings)`, both exported so the benchmark runs the exact same code without the canvas-dependent resize. `runPipeline` also returns `target` — the adjusted image just before dithering — which is what DBS refine optimises towards.

The **Balanced**, **Vivid**, and **Soft** presets match the corresponding presets in `aitjcize/esp32-photoframe` `@aitjcize/epaper-image-convert` exactly (tone mapping, algorithm, and color method). The **Grayscale** preset diverges intentionally: aitjcize uses `scurve` + LAB + floyd-steinberg; OpenDithering uses `contrast` + OKLab + Dizzy. The **Pre-DBS** preset (`PRE_DBS_PRESET`, id `predbs`) is OpenDithering's own: Balanced with `drcMode: 'whitepoint'`, `toneMode: 'contrast'` at 1.0 (no curve) and saturation 1.0 — a neutral starting point for DBS refine. DBS reproduces its target faithfully (it compares against the adjusted target, not the source), so settings that mainly compensated for error diffusion's losses — Balanced's 1.3 saturation, Color-tune/Hue-tune — over-saturate under DBS, and boosting colours the panel can't show only adds out-of-gamut error (edge halos). Saturation and contrast are left to add to taste.

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
│   ├── blue-noise.ts          # Blue Noise: Interleaved Gradient Noise (Jimenez 2014) threshold dithering (standalone)
│   ├── yliluoma2.ts           # Yliluoma 2 + Yliluoma 2 + Blue Noise: greedy 64-candidate list indexed by Bayer 8×8 or IGN (standalone)
│   ├── riemersma.ts           # Hilbert-curve traversal + exponential error queue (standalone)
│   ├── dizzy.ts               # Dizzy (2024, Liam Appelbe): Fisher-Yates random-order traversal, proportional error to orthogonal (w=1) + diagonal (configurable, default 0.1) unprocessed neighbours (standalone)
│   ├── knox.ts                # Eschbach & Knox: tone-dependent error diffusion in OKLab with fringe-field and cross-edge suppression (standalone)
│   ├── dbs.ts                 # Colour DBS refine core: dbsRefine(), indicesFromMeasured(), measuredFromIndices() — NOT a registered algorithm, see "Colour DBS refine"
│   └── dbs.worker.ts          # Web Worker wrapper around dbsRefine() (progress per pass; cancelled by terminate())
├── processing/
│   ├── colorspace.ts          # sRGB↔linear, RGB→L*a*b*, RGB→OKLab, deltaE_rgb/lab/oklab, rec709Luminance
│   ├── tone.ts                # compressDynamicRange, applyToneMapping, applySaturation, applyHueSatBands, applyExposure, applyChannelGains, applyClarity, boxBlur
│   ├── resize.ts              # resizeImage (cover/contain/stretch/none)
│   ├── pipeline.ts            # runPipeline() — orchestrates all steps, returns {measured, ideal, target}
│   ├── gamut.ts               # buildGamut() / applyGamutMapping() — convex hull of the measured palette in linear RGB; maps out-of-gamut colours onto it
│   ├── autoexpose.ts          # autoExpose() — one-shot histogram-based tone normalisation; derives exposure and contrast/s-curve params from OKLab luminance statistics of the DRC-adjusted source
│   ├── colortune.ts           # colorTune() — convergence-checked optimizer for RGB channel gains; chroma-only loss (|ΔmeanC| + |ΔmeanA| + |ΔmeanBv|)
│   └── huetune.ts             # hueTune() — convergence-checked optimizer for per-hue saturation bands (Red/Yellow/Green/Cyan/Blue/Magenta)
├── ble/
│   ├── opendisplay.ts         # OpenDisplay BLE upload: isSupported(), encodeImage(), connectDevice(), sendImage()
│   └── gicisky.ts             # Gicisky BLE upload: isSupported(), encodeImage(), connectDevice(), sendImage()
├── main.ts                    # All UI logic, state, event wiring
└── style.css
scripts/
└── benchmark.ts               # S-CIELAB benchmark (npm run bench), runs in Node via tsx
```

### Extending the app

**Add a palette:** create `src/palettes/<name>.ts` exporting a `PaletteGroup` with at least one variant in its `variants` array, then call `registerPaletteGroup()` in `src/palettes/index.ts`. The registry automatically appends an "Ideal" variant. Variant ids should follow the pattern `${groupId}-<slug>` (e.g. `spectra6-mydevice`).

**Add a dithering algorithm:** create `src/dithering/<name>.ts` exporting a `DitheringAlgorithm`, register it in `src/dithering/index.ts`. Kernel-based error-diffusion algorithms only need to call `errorDiffuse(src, palette, errorSpace, distSpace, strength, kernel, divisor)`. Algorithms with custom traversal order (e.g. Riemersma, Bayer, Eschbach & Knox) implement `dither()` standalone — import color-space helpers directly from `../processing/colorspace` and reuse the `findNearestColor` export from `error-diffusion.ts` if needed.

**Algorithm-specific parameters:** the `dither()` signature is `dither(src, palette, errorSpace, distSpace, strength, localVariance?, extraParams?)`. `localVariance` is a boolean passed from `ProcessingSettings.localVarianceDetection`; `extraParams` is an optional `Record<string, number>`. The pipeline always passes all algorithm param keys; algorithms ignore the ones they don't use. Current keys:

| Key | Algorithm | Default | Notes |
|-----|-----------|---------|-------|
| `serpentine` | FS, Atkinson, Burkes, Jarvis, Sierra, Stucki, Knox | 1 | 1 = alternate scan direction each row, 0 = always left-to-right |
| `knoxAlpha` | Eschbach & Knox | 0.5 | tone-dependency strength |
| `knoxFringe` | Eschbach & Knox | 0.04 | fringe field L-threshold raise per fired neighbour |
| `knoxEdgeSensitivity` | Eschbach & Knox | 4.0 | gradient scale for cross-edge suppression |
| `riemersmaQueueSize` | Riemersma | 16 | error history queue length (4–64) |
| `dizzyDiagonalWeight` | Dizzy | 0.1 | diagonal neighbour weight relative to orthogonal (0–1) |

To add a new algorithm-specific UI control: add a slider to `index.html` (inside a hidden `<div id="panelXxx">`), add the field to `ProcessingSettings` in `src/types.ts` (with a default in `BALANCED_PRESET`), wire the slider listener and show/hide logic in `src/main.ts` (`algorithmSelect` change handler + `syncSlidersFromSettings`), and pass the value in the `extraParams` object in `src/processing/pipeline.ts`.

**Add a display preset:** add an entry to the `DISPLAY_PRESETS` array in `src/displays/presets.ts`. Set `paletteGroupId` to the id of the relevant `PaletteGroup` (e.g. `'spectra6'`, `'acep'`, `'bw'`). Set `diagonalInches` when the physical screen size is known (from a datasheet or the product page, not guessed): `presetPpi()` derives PPI from it for DBS refine. Leave it out if unknown; the PPI slider then stays manual.

### Color space system

`ProcessingSettings` carries two independent color space fields for dithering:

- `errorSpace: ColorSpace` — the space in which quantization error is accumulated and diffused to neighbours. The `errorDiffuse()` float buffer is stored in this space.
- `distSpace: ColorSpace` — the space used to find the nearest palette color. Can differ from `errorSpace`.

`ColorSpace` is `'rgb' | 'cielab' | 'oklab' | 'oklab-chroma'`. For Bayer (ordered) dithering only `distSpace` applies — there is no error buffer.

The UI exposes six named presets via a "Color matching" dropdown: RGB (full), CIELAB distance, CIELAB (full), OKLab distance, OKLab (full), OKLab chroma-aware. Below the dropdown, two read-only text fields show the active spaces — "Find color using" (`distSpace`) and "Diffuse error in" (`errorSpace`) — and update automatically when the preset changes. There is no manual/advanced mode; all valid combinations are covered by the presets. `deltaE_lab` uses `2·dL² + da² + db²` (L weighted double) for CIELAB distance; `deltaE_oklab` uses plain Euclidean; `oklab-chroma` uses `dL² + (da² + db²) × (1 + C×10)` where C is the source pixel's OKLab chroma — saturated source pixels strongly prefer chromatic palette entries over neutral ones of similar lightness.

**Clarity** (`clarity: number`, −1–1; `clarityRadius: number`, 1–4): midtone-weighted unsharp mask applied before DRC. `clarity` controls strength (0 = off, positive = sharpen, negative = blur); `clarityRadius` controls the box-blur radius (larger = coarser features affected). The midtone weight `4L(1−L)` peaks at L=0.5 and falls to zero at black/white.

**Per-hue saturation bands** (`hueSatBands: [number, number, number, number, number, number]`): saturation multipliers for Red, Yellow, Green, Cyan, Blue, and Magenta hue segments. Applied after the global saturation step. Default `[1, 1, 1, 1, 1, 1]`. Slider range 0.25–4.0.

**Expand palette** (`expandPalette: boolean`): before dithering, six pure primaries (`[0,0,0]`, `[255,255,255]`, `[255,0,0]`, `[0,255,0]`, `[0,0,255]`, `[255,255,0]`) are appended to the working palette as extra snap-points. After dithering, `remapToOriginalPalette()` replaces any pixel that landed on a primary with the nearest original measured color, so the preview and export are unaffected.

**Panel white point mapping** (`drcMode: 'luminance' | 'whitepoint'`, default `'luminance'`; UI: *Mapping* dropdown under *Compress dynamic range*; `mapToPanelWhitePoint()` in `src/processing/tone.ts`). Brightness-only compression keeps the source's colour balance, so pure white becomes a *neutral* grey at the panel white's luminance. Measured Spectra 6 whites are slightly green, so that grey is outside the gamut and DBS fakes it with red dots (a pink cast on white backgrounds). White point mode first applies a Bradford chromatic adaptation from D65 to the panel white's chromaticity (at Y = 1), then the same brightness compression as `compressDynamicRange` — done in float, because the adapted white exceeds 1.0 in some channels and an 8-bit round-trip in between clips its hue. Source white lands exactly on the panel's measured white; greys take its tint. The tone curve runs *before* the mapping so it can't dim white.

Findings (illustration with a pure white background, guysie palette, DBS without highlight lift):
- White background 79.3% → **99.2%** pure panel white; Floyd-Steinberg 88.4% → 99.9%.
- **The panel's black point is deliberately not mapped.** Full relative colorimetric with black point compensation (black → panel black too) was tried first: it adds the panel black's purplish tint to every colour and cut hair chroma 0.095 → 0.074.
- **In brightness-only mode the S-curve is nearly dormant.** It runs on values already compressed below its midpoint, so Balanced's S-curve mostly just dims white (79.3% white with it, 92.3% without) and barely touches other colours. In white point mode it runs on the full-range source and acts as a real contrast curve: at Balanced's 0.9 it darkens skin (L 0.567 → 0.525) and mutes hair (0.095 → 0.071). At **S-curve strength 0** the look stays close to brightness-only + Balanced (skin 0.564/0.042/79° vs 0.567/0.035/76°, backpack chroma 0.118 vs 0.117, hair 0.088 vs 0.095) with 99% white backgrounds.
- Cost: dark anti-aliased outline pixels take the panel white's (greenish) tint instead of sitting near the panel's (purplish) black, so DBS black outlines are a little less clean (65.8% → 55.8% pure black).
- The tuners' reference uses the same mapping (`applyTuneReferenceMapping` in `colortune.ts`); otherwise Color-tune would see the deliberate shift towards the panel white as a colour error and adjust the gains to undo it. Auto Expose keeps its own OKLab-based compression for its statistics.
- Benchmark: `--drc whitepoint`. Its "vs source" scores aren't comparable across modes, since the reference is mapped the same way.

**Gamut mapping** (`gamutMapping: boolean`, default off; `gamutMappingBalance: number`, 0–1, default 0.5): the colours a panel can show on average are all mixes of its measured colours, i.e. the convex hull of the measured palette in **linear** RGB (the eye averages light). `buildGamut()` finds the hull faces by brute force over palette triples; a flat hull (BW, BWR, grayscale) returns null and mapping is a no-op. For each out-of-gamut pixel, `mapColor()` picks an anchor on the panel's own black→white axis and bisects along the straight OKLab line anchor → pixel (constant hue) for the last point inside the hull, then steps back until the 8-bit-rounded result is still inside. The anchor's lightness is the trade-off: balance 0 = the pixel's own lightness (keep lightness, lose saturation), 1 = the panel's mid lightness (keep more saturation). Results are cached per RGB value.

Why it exists: out-of-gamut targets leave error that no dot arrangement can remove; error diffusion smears it forward and DBS refine pushes it across edges as **halos** (a dark band outside, an off-colour rim inside, as wide as the eye-model blur — so worst on dense panels). On a synthetic cyan/dark-figure edge at 282 PPI, mapping cut DBS halo deviation from 4.0/8.8 to 0.9/1.3 (OKLab ΔE×100) and DBS's error reduction went from 14% to 99.8%. The cost: S-CIELAB vs the DRC-only source gets somewhat worse on average (DBS 19.9 → 23.1 on the three synthetic images, dominated by the fully saturated hue sweep; grey ramp unchanged, sky/skin 13.2 → 14.1). Note S-CIELAB itself blurs over ~1°, so it barely sees halos — the benchmark can't settle this trade-off; the panel can.

**Diffusion strength** (`ditherStrength: number`, 0–1): multiplies the error before it is forwarded to neighbours. Default 1.0 (full diffusion).

**Eschbach & Knox parameters** (Eschbach & Knox only — `errorSpace`/`distSpace` ignored, always OKLab):
- `knoxAlpha` (0–1, default 0.5): tone-dependency strength. At α=0 diffusion is uniform; at α=1 the full Knox `4t(1−t)` curve applies — midtones get full diffusion, highlights and shadows get none.
- `knoxFringe` (0–0.15, default 0.04): OKLab L-threshold raise applied to unprocessed 4-connected neighbours after each pixel fires. Models physical ink bleed (fringe field effect); tune per device.
- `knoxEdgeSensitivity` (0.5–8, default 4.0): scales the gradient magnitude used for cross-edge suppression. The gradient is computed with centred differences in the interior and one-sided differences at image boundaries. At 4.0 a centred gradient of 0.25 (i.e. L changes by 0.5 across 2 pixels) gives full suppression; lower values require steeper edges to suppress, higher values suppress at gentler gradients.

**Riemersma queue size** (`riemersmaQueueSize: number`, 4–64, default 16): length of the exponential error-history queue traversed along the Hilbert curve. Longer queues spread error over more pixels (smoother gradients, less grain); shorter queues are more local.

**Dizzy diagonal weight** (`dizzyDiagonalWeight: number`, 0–1, default 0.1): weight of diagonal neighbours relative to orthogonal (always 1) in Dizzy's proportional error distribution. 0 = pure 4-connected diffusion; 1 = equal 8-connected spreading.

### Palette color values

The `ideal` values are the nominal RGB codes the firmware expects (e.g. pure `[255,0,0]` for red). The `measured` values vary by variant — see variant sources listed under "Palette groups and calibration variants" above. When adding real device measurements, add a new named variant rather than overwriting an existing one.

### Auto Expose

Implemented in `src/processing/autoexpose.ts`. `autoExpose()` is a **one-shot** (non-iterative) tone normaliser. It resets all tone, saturation, and gain parameters to neutral, then derives exposure and contrast/s-curve settings from OKLab luminance statistics of the DRC-adjusted source image. Intended as a starting point before optionally running Color-tune or Auto-tune.

**Algorithm:**
1. Resize the source and apply DRC so luminance stats match the pipeline's fixed tone range.
2. Compute meanL, stddevL, shadowMeanL (pixels below L=0.35), and highlightFraction (pixels above L=0.85).
3. Derive `exposure = TARGET_MEAN_L / meanL` (target 0.55, clamped 0.5–2.0).
4. In contrast mode: `contrast = TARGET_STDDEV_L / stddevL` (target 0.27, clamped 0.5–2.0). In s-curve mode: derive `strength`, `shadowBoost`, and `highlightCompress` from the same stats.

**Return value:** `AutoExposeResult` — `{ exposure, saturation, contrast, strength, shadowBoost, highlightCompress, midpoint, redGain, greenGain, blueGain, compressDynamicRange, debug: AutoExposeDebug }`. All gain and saturation fields are reset to 1.0; `compressDynamicRange` is always `true`. The debug struct carries `{ meanL, stddevL, shadowMeanL, highlightFraction }`. The debug panel (`#debugAutoExpose`) renders this after each Auto Expose or Auto-tune run.

### Color-tune

Implemented in `src/processing/colortune.ts`. `colorTune()` iteratively adjusts **RGB channel gains** to match the dithered output's chroma to the source image, measured by `|ΔmeanC| + |ΔmeanA| + |ΔmeanBv|` in OKLab. Tone parameters (exposure, contrast, s-curve) are not touched — use Auto Expose for those.

**Algorithm:**
1. Resize the source and apply DRC to build reference stats (meanC, meanA, meanBv, and per-channel sRGB means).
2. Reset redGain, greenGain, blueGain to 1.0 and establish a baseline loss from there.
3. Each iteration: compute ratio-based gain adjustments (30% damping, ±15% per-run cap relative to the reset values, absolute bounds 0.5–2.0). Run the pipeline, compute new loss. If `newLoss >= prevLoss − 1e-4`, revert and stop. Otherwise commit and continue.
4. Maximum 12 iterations.

**Return value:** `ColorTuneResult` — `{ saturation, redGain, greenGain, blueGain, debug: ColorTuneDebug }`. `saturation` is always returned unchanged (not optimised). The debug struct carries `iterationsRun`, `converged`, `refStats`/`initialStats`/`finalStats` (each with meanC/meanA/meanBv), `initialLoss`, `finalLoss`, `lossHistory`, and before/after values for the three gain parameters. The debug panel (`#debugColorTune`) renders this after each run.

### Hue-tune

Implemented in `src/processing/huetune.ts`. `hueTune()` iteratively adjusts the six **per-hue saturation band multipliers** (`hueSatBands`: Red/Yellow/Green/Cyan/Blue/Magenta) so that the mean OKLab chroma of each hue segment in the dithered output matches the source. Loss is the sum of `|refMeanC − dithMeanC|` across all active hue bands (bands with fewer than `minPixels` pixels are skipped).

**Algorithm:**
1. Resize the source, optionally apply DRC, then segment pixels into 6 hue bands using RGB hue angle. Ignore achromatic pixels (RGB span < 0.05).
2. Establish a baseline loss.
3. Each iteration: check early-exit — if every active band already has its multiplier pressed against its absolute bound in the direction of the gradient (palette-limited), break and mark `converged = true`. Otherwise compute ratio-based candidate multipliers (30% damping, ±25% per-step relative cap, absolute bounds 0.25–4.0). Run the pipeline with a box-blurred dithered output for stable statistics. If `newLoss >= prevLoss − 1e-4`, revert and stop. Otherwise commit.
4. Maximum 20 iterations.

**Return value:** `HueTuneResult` — `{ hueSatBands, debug: HueTuneDebug }`. The debug struct carries `iterationsRun`, `converged`, `bands` (array of `HueTuneBandDebug` with per-band pixel count, refMeanC, initialMeanC, finalMeanC, initialBandValue, finalBandValue), `initialLoss`, `finalLoss`, `lossHistory`. The debug panel (`#debugHueTune`) renders this after each run.

### Colour DBS refine

Direct Binary Search (Analoui & Allebach 1992; colour version per Agar & Allebach 2005) — an iterative optimiser, run on demand from the **Refine (DBS)** button in the Dithering section rather than from the algorithm dropdown (seconds per image, too slow for live preview). It starts from the currently shown error-diffusion result (`img.dithered`, mapped back to palette indices) and minimises perceived error against `img.target`.

- **Colour space: YyCxCz** (Flohr, Kolpatzik & Allebach): `Yy = 116·Y`, `Cx = 500·(X/Xn − Y)`, `Cz = 200·(Y − Z/Zn)` from linear XYZ of the **measured** palette and the target. It must be linear: the eye averages *light*, so the blur only models what's seen when applied to linear values — OKLab/CIELAB are wrong here.
- **Eye model:** one separable Gaussian per channel, narrow for luminance and wider for chrominance. σ comes from the Kolpatzik & Bouman exponential CSFs `exp(−α·f)` (luminance α = 1/(0.525·ln 11 + 3.91) ≈ 0.193 from the Näsänen model at 11 cd/m², chrominance α = 0.419 from Mullen; per Bouman's ECE 637 "Color Fidelity Metrics" notes; the luminance filter's angular dependence s(Θ) is ignored): `σ_px = (α/2π) / pixelAngleDeg`, with `pixelAngleDeg = (180/π)·(2.54/ppi)/distanceCm`. ≈1.07 / 2.33 px at 127 PPI, 40 cm.
- **Search:** raster order; per pixel, try toggling to every other palette colour and swapping with each differing 8-neighbour; accept the most negative ΔE. ΔE is O(1) from the cached `c_pe = c_pp ∗ e` (`c_pp` = filter autocorrelation, separable since the filter is): toggle `ΔE = Σ_ch a²·c_pp(0) + 2a·c_pe(m)`, swap `ΔE = Σ_ch 2a²·(c_pp(0) − c_pp(n−m)) + 2a·(c_pe(m) − c_pe(n))`. On accept, `a·c_pp` is added into `c_pe` around the changed pixel(s). Error outside the image is zero, so edges are exact. Stops after a pass with no changes or after the **Passes** slider's limit (`dbsMaxPasses` in `main.ts`, 1–30, default 10; module state like the other DBS settings). `finalE` is recomputed from scratch (a check that the incremental update hasn't drifted).
- **Worker:** `dbs.worker.ts` gets `{ target, initIdx, palette, params }`, posts `{type:'pass'}` per pass and `{type:'done', idx, stats}`. The search is synchronous, so cancelling = `worker.terminate()` (click the button while running, or any `scheduleProcess`/`invalidateAll`).
- **Lifecycle:** the result replaces `img.dithered`/`img.ideal` and sets `img.refined`, so PNG/BMP export and BLE upload use it automatically. Any pipeline re-run discards it. ZIP export only contains a refinement for images that were refined individually.
- **Viewing distance / Panel PPI** sliders live in module state in `main.ts` (`dbsViewingDistanceCm`, `dbsPpi`), not in `ProcessingSettings`, because they describe the panel, not the look — presets must not reset them. Panel PPI is set automatically (`applyPresetPpi`) on startup and on device-preset change when the preset has `diagonalInches` (√(w²+h²)/diagonal, square pixels assumed); Custom or unknown-size presets keep the current value. Double-clicking the PPI slider restores the preset's value.
- **Highlight lift** (`dbsHighlightLift` in `main.ts`, 0–1, default 0; `applyHighlightLift()` in `src/processing/tone.ts`): applied to a *copy* of `img.target` just before Refine, so error diffusion and the preview are unaffected. Why: near-whites usually land below the panel's white after DRC + tone mapping. DBS mixes in linear light (as the eye does) and reproduces that faithfully with ~⅓ dark dots, so light areas look dim and speckled; error diffusion in OKLab *overshoots* towards white because a few dark dots among white look brighter than their OKLab average suggests (synthetic pale sky at 282 PPI: target L 0.614, DBS 0.615, Floyd-Steinberg 0.636, panel white 0.677). The lift blends colours towards the panel's measured white in OKLab, weighted by a smoothstep from `HIGHLIGHT_KNEE` (65%) to 100% of the panel's black→white L range, times a chroma gate that fades the effect out between 60% and 100% of the **Lift tint tolerance** (`dbsLiftTolerance`, OKLab chroma, slider 0–0.08, default `HIGHLIGHT_TINT_TOLERANCE` = 0.025) so light colours with a real tint keep their colour. The default was chosen on an illustration where white is 0.000, a pale blue 0.032 and skin 0.040: the original fixed gate (0.03–0.08) partly lifted the skin and turned DBS's warm skin (chroma 0.035, hue 76°) as sallow as Floyd-Steinberg's (0.020, 93°); at 0.025 skin and blue are untouched while the background still reaches 96% pure white. Faint off-whites (the mountain sky, ~0.011) are still fully lifted. Lift 0.5 ≈ Floyd-Steinberg's sky brightness; 1.0 → L 0.655, 87% pure white. (A tone-dependent luminance weight inside DBS was tried first and did nothing: there was no lightness-vs-colour conflict, DBS already matched the target.) Benchmark: `--highlight-lift <0–1>`, `--lift-tolerance <chroma>`.
- **Halos and gamut mapping:** out-of-gamut targets make DBS trade error across edges (halos). Enabling **Map colours into panel gamut** (Experimental section) removes the cause — see "Gamut mapping" above.
- **Interaction with Auto-tune:** the tuners never run DBS (30+ runs per Auto-tune would take minutes); they tune against error diffusion, then you Refine. Risk: tuners partly compensate for error diffusion's chroma loss, and DBS reproduces the boosted target more faithfully → possible overshoot. The `#debugDbs` panel shows the tuners' own metrics (Color-tune loss, Hue-tune loss, per-band mean chroma) for the error-diffusion result vs the DBS result, against the same DRC-only reference (`buildTuneReference` in `colortune.ts`, shared with both tuners).

### Benchmark

`npm run bench -- [--palette spectra6-guysie] [--preset balanced] [--ppi 127] [--distance 40] [--passes 10] [--gamut-mapping <balance>] [--highlight-lift <0–1>] [--lift-tolerance <chroma>] [--drc luminance|whitepoint] [--no-synthetic] [images/*.png]` (`scripts/benchmark.ts`, Node via `tsx`, `pngjs` for input). Runs every registered algorithm plus DBS-from-Floyd-Steinberg on three synthetic images (grey ramp, hue sweep, sky/skin) and any PNGs given — which must already be at panel resolution, since the app's resize needs a browser canvas. Scores with **S-CIELAB** (Zhang & Wandell 1996: opponent transform → per-channel sum-of-Gaussians blur at the given px/° → CIELAB → per-pixel ΔE76, mean and p95) against two references: the adjusted **target** (how faithfully each algorithm reproduces its input) and the DRC-only **source** (what the tuners aim for). Filter details follow the reference implementation ([wandell/SCIELAB-1996](https://github.com/wandell/SCIELAB-1996) `separableFilters.m`/`gauss.m`): spreads are full widths at half maximum, every kernel is limited to a 1° window and normalised within it, and below 224 samples/° each tap is integrated over sub-samples (the reference upsamples instead).

Caveat: DBS minimises an eye-filtered error too, so S-CIELAB is structurally inclined to favour it (the two eye models differ, which reduces but doesn't remove the bias). The physical panel is the final judge.

### Auto-tune

The **Auto-tune** button (`btnAutoTune`) chains all three optimisers in sequence on the same image and settings:

1. **Auto Expose** — resets tone/gain/saturation to neutral and derives exposure + contrast/s-curve from luminance statistics
2. **Color-tune** — adjusts RGB channel gains to match dithered chroma to the source
3. **Hue-tune** — independently adjusts per-hue saturation bands to match per-segment chroma

Each step feeds its output settings into the next. After all three complete, all three debug panels (`#debugAutoExpose`, `#debugColorTune`, `#debugHueTune`) are rendered and `syncSlidersFromSettings()` is called to reflect the final values in the UI.

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
| `mode2` | 7.5" (`0x012B`), 10.2" (`0x008B`) | BW+Red planes concatenated, split in half, each half wrapped in 64-byte QuickLZ L1 chunks (0x75), with raw fallback (0x74): `[4B LE half_raw_len][0x75/0x74][total_len][n][...data] ...` |

### Rotation

A **Rotation** dropdown (0°/90°/180°/270°) lives in the Display section's dim-row alongside Width and Height. The selected rotation is applied to the `ideal` ImageData before BLE upload **and** before PNG, BMP, and zip export — `applyRotationToImageData()` wraps `rotatePixels()` for the download paths; the BLE upload path calls `rotatePixels()` directly.

When a non-custom device preset is active, the UI shows a warning if the chosen rotation would produce output dimensions that don't match the preset's native dimensions (e.g. rotating 90° when the display is already portrait-native). The check in `checkRotationConflict()` compares the rotated output size against `preset.width × preset.height` and shows `#rotationWarn` if they differ.

The rotation select is excluded from the `dims-readonly` CSS rule so it remains interactive even when a preset locks the width/height fields.

### Auto-orientation

When an image is activated or a display preset is changed, `autoOrientDisplay()` compares the image's aspect ratio to the display's aspect ratio. If they don't match (one is portrait, the other landscape), it swaps `displayWidth` and `displayHeight` internally and sets the Rotation dropdown to 270°. The width/height input fields are intentionally **not** updated — showing both swapped dims and a non-zero rotation would be confusing.

### Device preset cascade menu

The Device preset dropdown is a custom two-level cascade (`#presetCascade` trigger + a `position: fixed` menu/submenus appended to `document.body`, built in `buildCascadeMenu()` in `src/main.ts`). Manufacturers are top-level items; their models open in a flyout submenu. Selection goes through the hidden `#presetSelect` element so existing change handlers keep working.

**Do not use `mouseenter`/`mouseleave` for the submenus:** some Chromium-based browsers (Arc) fail to synthesize hover boundary events over fixed-position overlays, only delivering the deferred enter event on click. Hover detection is therefore a delegated `pointermove` listener on the menu, clicking a manufacturer always opens (never toggles) its submenu, and the hide timer resets rather than stacks. Submenus flip to the left / clamp vertically when they would overflow the viewport (Arc's sidebar narrows it).

### Zoom / pan

Clicking either preview canvas zooms to 1:1 pixels, centered on the click point. Dragging pans both canvases in sync. Clicking again returns to fit view. Changing any setting exits zoom mode. Implemented via `position: absolute` canvas inside an `overflow: hidden` `.canvas-viewport` div; both canvases receive the same `transform: translate()`.

## Deployment

Push to `main` — GitHub Actions (`.github/workflows/deploy.yml`) runs `npm ci && npm run build` and deploys `dist/` to the `gh-pages` branch. Requires GitHub Pages to be configured to serve from `gh-pages` in the repository settings.

`vite.config.ts` uses `base: './'` so all asset paths are relative, which is required for GitHub Pages subdirectory hosting.
