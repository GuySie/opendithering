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
- `spectra6` — **EPDOptimize**: `paperlesspaper/epdoptimize` `default-palettes.json` (`spectra6` entry); **aitjcize**: `aitjcize/esp32-photoframe` `main/color_palette.c` (`color_palette_get_defaults`)
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

Steps 3–5 match the aitjcize esp32-photoframe "balanced" preset defaults exactly.

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
│   ├── dizzy.ts               # Dizzy (2024, Liam Appelbe): Fisher-Yates random-order traversal, proportional error to orthogonal (w=1) + diagonal (w=0.1) unprocessed neighbours (standalone)
│   └── knox.ts                # Eschbach & Knox: tone-dependent error diffusion in OKLab with fringe-field and cross-edge suppression (standalone)
├── processing/
│   ├── colorspace.ts          # sRGB↔linear, RGB→L*a*b*, RGB→OKLab, deltaE_rgb/lab/oklab, rec709Luminance
│   ├── tone.ts                # compressDynamicRange, applyToneMapping, applySaturation, applyExposure
│   ├── resize.ts              # resizeImage (cover/contain/stretch/none)
│   └── pipeline.ts            # runPipeline() — orchestrates all steps, returns {measured, ideal}
├── main.ts                    # All UI logic, state, event wiring
└── style.css
```

### Extending the app

**Add a palette:** create `src/palettes/<name>.ts` exporting a `PaletteGroup` with at least one variant in its `variants` array, then call `registerPaletteGroup()` in `src/palettes/index.ts`. The registry automatically appends an "Ideal" variant. Variant ids should follow the pattern `${groupId}-<slug>` (e.g. `spectra6-mydevice`).

**Add a dithering algorithm:** create `src/dithering/<name>.ts` exporting a `DitheringAlgorithm`, register it in `src/dithering/index.ts`. Kernel-based error-diffusion algorithms only need to call `errorDiffuse(src, palette, errorSpace, distSpace, strength, kernel, divisor)`. Algorithms with custom traversal order (e.g. Riemersma, Bayer, Eschbach & Knox) implement `dither()` standalone — import color-space helpers directly from `../processing/colorspace` and reuse the `findNearestColor` export from `error-diffusion.ts` if needed.

**Algorithm-specific parameters:** the `dither()` signature accepts an optional `extraParams?: Record<string, number>` as its last argument. The pipeline always passes `{ knoxAlpha }` here; add further keys as needed. If an algorithm needs a UI control, add the slider to `index.html`, wire it in `src/main.ts` (show/hide on algorithm change + `syncSlidersFromSettings`), and add the field to `ProcessingSettings` in `src/types.ts`.

**Add a display preset:** add an entry to the `DISPLAY_PRESETS` array in `src/displays/presets.ts`. Set `paletteGroupId` to the id of the relevant `PaletteGroup` (e.g. `'spectra6'`, `'acep'`, `'bw'`).

### Color space system

`ProcessingSettings` carries two independent color space fields for dithering:

- `errorSpace: ColorSpace` — the space in which quantization error is accumulated and diffused to neighbours. The `errorDiffuse()` float buffer is stored in this space.
- `distSpace: ColorSpace` — the space used to find the nearest palette color. Can differ from `errorSpace`.

`ColorSpace` is `'rgb' | 'cielab' | 'oklab'`. For Bayer (ordered) dithering only `distSpace` applies — there is no error buffer.

The UI exposes five named presets via a "Color matching" dropdown: RGB (full), CIELAB distance, CIELAB (full), OKLab distance, OKLab (full). Below the dropdown, two read-only text fields show the active spaces — "Find color using" (`distSpace`) and "Diffuse error in" (`errorSpace`) — and update automatically when the preset changes. There is no manual/advanced mode; all valid combinations are covered by the presets. `deltaE_lab` uses `2·dL² + da² + db²` (L weighted double) for CIELAB distance; `deltaE_oklab` uses plain Euclidean.

**Expand palette** (`expandPalette: boolean`): before dithering, six pure primaries (`[0,0,0]`, `[255,255,255]`, `[255,0,0]`, `[0,255,0]`, `[0,0,255]`, `[255,255,0]`) are appended to the working palette as extra snap-points. After dithering, `remapToOriginalPalette()` replaces any pixel that landed on a primary with the nearest original measured color, so the preview and export are unaffected.

**Diffusion strength** (`ditherStrength: number`, 0–1): multiplies the error before it is forwarded to neighbours. Default 1.0 (full diffusion).

**Eschbach & Knox tone dependency** (`knoxAlpha: number`, 0–1, Eschbach & Knox only): controls how strongly lightness affects diffusion strength. At α=0 diffusion is uniform; at α=1 the full Knox `4t(1−t)` curve applies — midtones get full diffusion, highlights and shadows get none. Default 0.5. `errorSpace`/`distSpace` settings are ignored by Eschbach & Knox — it always operates in OKLab.

### Palette color values

The `ideal` values are the nominal RGB codes the firmware expects (e.g. pure `[255,0,0]` for red). The `measured` values vary by variant — see variant sources listed under "Palette groups and calibration variants" above. When adding real device measurements, add a new named variant rather than overwriting an existing one.

### Auto-orientation

When an image is activated or a display preset is changed, `autoOrientDisplay()` compares the image's aspect ratio to the display's aspect ratio. If they don't match (one is portrait, the other landscape), it swaps `displayWidth` and `displayHeight` automatically and updates the dimension inputs.

### Zoom / pan

Clicking either preview canvas zooms to 1:1 pixels, centered on the click point. Dragging pans both canvases in sync. Clicking again returns to fit view. Changing any setting exits zoom mode. Implemented via `position: absolute` canvas inside an `overflow: hidden` `.canvas-viewport` div; both canvases receive the same `transform: translate()`.

## Deployment

Push to `main` — GitHub Actions (`.github/workflows/deploy.yml`) runs `npm ci && npm run build` and deploys `dist/` to the `gh-pages` branch. Requires GitHub Pages to be configured to serve from `gh-pages` in the repository settings.

`vite.config.ts` uses `base: './'` so all asset paths are relative, which is required for GitHub Pages subdirectory hosting.
