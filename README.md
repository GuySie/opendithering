# OpenDithering

A browser-based image dithering tool for e-paper displays. Runs entirely client-side using the Canvas API — no server, no uploads. Download perfectly dithered PNG files, or send them directly to an OpenDisplay device over Bluetooth.

**[Try it live →](https://guysie.github.io/opendithering/)**

## Experimental

This app is an experiment to find the optimal dithering algorithm and settings for different e-paper displays. It is permanently work in progress, can change features at any moment, and is not meant to be relied on for production use. It's a sandbox for me to play around in.

## Features

- **Dithering algorithms** — to figure out what works best, we're trying classics like Floyd-Steinberg, Atkinson, Jarvis-Judice-Ninke, Stucki, Burkes and Sierra. But also less well-known or more recent algorithms like Riemersma (Hilbert-curve), Blue noise (void and cluster), Yliluoma II, Eschbach & Knox, and Dizzy
- **DBS refine** — an optional, slower final step that improves the dithered result with colour Direct Binary Search: it repeatedly toggles and swaps pixels to minimise the error a human eye would see at a given viewing distance and panel pixel density (set automatically from the device preset). Runs in the background in a few seconds to a few minutes depending on resolution. Experimental: on colours the panel can't reproduce it can create halos along hard edges — enable *Map colours into panel gamut* to prevent them. A *Highlight lift* slider keeps near-white areas bright and clean instead of speckled
- **Pre-DBS preset** — a neutral starting point for DBS refine: Balanced with Panel white point mapping, no tone curve (contrast 1.0), saturation 1.0 and Dizzy dithering as DBS's starting point. DBS reproduces its target faithfully, so the boosts that made up for error diffusion's losses aren't needed — add saturation or contrast to taste
- **Panel white point mapping** — optional dynamic range mode that adapts the image's colour balance to the panel's measured white, so pure white lands exactly on the panel's white instead of a neutral grey the panel can't show (no more speckled or pink-tinted white backgrounds). Lower the S-curve strength in this mode: the tone curve becomes a real contrast control here
- **Gamut mapping** — optionally pulls colours the panel physically can't show onto the nearest colour it can, with a lightness ↔ saturation trade-off, so dithering doesn't have to fake them
- **Palette-accurate output** — each palette carries both *measured* colors (how the panel actually looks) and *ideal* colors (what the device expects); dithering runs against calibrated, export uses ideal
- **Calibration variants** — choose from different color profiles per panel type: community estimations, datasheet typicals (GoodDisplay GDEP133C02), and real colorimeter measurements (CR30, 5-sample CIELAB averages)
- **Multiple display presets** — Seeed reTerminal, TRMNL, Waveshare PhotoPainter, Pimoroni Inky Impression, Soldered Inkplate, Solum M3 ESL, Gicisky ESL, GoodDisplay, or custom dimensions and panels
- **Image adjustments** — tone mapping, saturation, exposure, clarity (midtone unsharp mask), dynamic range compression, per-channel RGB gains, and per-hue saturation bands
- **Auto Expose** — one-click histogram-based tone normalisation; derives exposure and contrast from OKLab luminance statistics as a starting point
- **Color-tune** — iterative optimizer that adjusts RGB channel gains to match the dithered output's chroma to the source
- **Hue-tune** — iterative optimizer that independently adjusts the saturation of each hue band (Red / Yellow / Green / Cyan / Blue / Magenta)
- **Color space control** — dither in RGB, CIELAB, OKLab, or OKLab chroma-aware; independently choose error diffusion space and nearest-color distance space
- **Zoom / pan** — click the preview canvas to zoom to 1:1 pixels and drag to pan the full image
- **Export** — downloads a PNG or BMP sized exactly to the display, using ideal palette colors; rotation is applied before export
- **OpenDisplay upload** — send the dithered image directly to an [OpenDisplay](https://opendisplay.org/) device over Web Bluetooth. Requires Chrome or Edge. Preliminary support for Gicisky/Picksmart ESL also added (but only tested on 7.5" tag)

Read the blog for more information: https://style.oversubstance.net/2026/06/dithering-is-obsolete-except-when-it-isnt-creating-opendithering/

## Supported palettes

| Panel type | Colors |
|---|---|
| Spectra 6 | Black, White, Red, Green, Blue, Yellow |
| ACeP (Gallery) | Black, White, Red, Green, Blue, Yellow, Orange |
| BW | Black, White |
| BWR | Black, White, Red |
| BWRY | Black, White, Red, Yellow |
| Grayscale 4 (2bpp) | 4 levels |
| Grayscale 8 (3bpp) | 8 levels |
| Grayscale 16 (4bpp) | 16 levels |

## Inspired by

- EPDOptimize (Paperlesspaper): https://github.com/paperlesspaper/epdoptimize
- aitjcize: https://github.com/aitjcize/esp32-photoframe
- mattcarter11: https://github.com/mattcarter11/eink-dithering-tester
- Liam Appelbe: https://liamappelbe.medium.com/dizzy-dithering-2ae76dbceba1
- OpenDisplay: https://opendisplay.org/

## AI Warning

This whole thing was entirely vibecoded with Claude Code. I have not even looked at a single line. If you don't trust AI-written code, you probably should not run this.

## Development

```bash
npm install
npm run dev      # dev server at http://localhost:5173
npm run build    # type-check + production build → dist/
npm run preview  # serve the dist/ build locally
npm run bench    # S-CIELAB benchmark comparing all algorithms and DBS on test images
```

Requires Node 20+.

## Architecture notes

The processing pipeline runs in order: resize → clarity → dynamic range compression → tone mapping → saturation + hue-sat bands → exposure → channel gains → (optional gamut mapping) → dithering → (optional DBS refine) → palette swap (export only). See [CLAUDE.md](CLAUDE.md) for full architecture documentation.