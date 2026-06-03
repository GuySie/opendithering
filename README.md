# OpenDithering

A browser-based image dithering tool for e-paper displays. Runs entirely client-side using the Canvas API — no server, no uploads. Download perfectly dithered PNG files to display on your e-paper devices.

**[Try it live →](https://guysie.github.io/opendithering/)**

## Experimental

This app is an experiment to find the optimal dithering engine and settings for different e-paper displays. It is permanently work in progress and not meant for production use.

## Features

- **Dithering algorithms** — To figure out what works best, we're trying classics like Floyd-Steinberg, Atkinson, Jarvis-Judice-Ninke, Stucki, Burkes and Sierra. But also less well-known or more recent algorithms like Riemersma (Hilbert-curve), Blue noise (void and cluster), Yliluoma II, Dizzy, and Eschbach & Knox.
- **Palette-accurate output** — each palette carries both *calibrated* colors (how the panel actually looks) and *ideal* colors (what the device expects); dithering runs against calibrated, export uses ideal
- **Calibration variants** — choose from different color profiles per panel type, based on estimations or measurements
- **Multiple display presets** — Seeed reTerminal, Waveshare ACeP/BWR/BW panels, Pimoroni Inky Impression, or custom dimensions
- **Image adjustments** — tone mapping, saturation, exposure, dynamic range compression
- **Color space control** — dither in RGB, CIELAB, or OKLab; independently choose error diffusion space and nearest-color distance space
- **Zoom / pan** — click the preview canvas to zoom to 1:1 pixels and drag to pan the full image
- **Export** — downloads a PNG or BMP sized exactly to the display, using ideal palette colors

## Supported palettes

| Panel type | Colors |
|---|---|
| Spectra 6 | Black, White, Red, Green, Blue, Yellow |
| ACeP (Gallery) | Black, White, Red, Green, Blue, Yellow, Orange |
| Black & White | Black, White |
| Black, White & Red | Black, White, Red |
| Grayscale 4 | 4 levels |
| Grayscale 16 | 16 levels |

## Inspired by

EPDOptimize (Paperlesspaper): https://github.com/paperlesspaper/epdoptimize. 
aitjcize: https://github.com/aitjcize/esp32-photoframe. 
mattcarter11: https://github.com/mattcarter11/eink-dithering-tester. 
Liam Appelbe: https://liamappelbe.medium.com/dizzy-dithering-2ae76dbceba1. 

## AI Warning

This whole thing was entirely vibecoded with Claude Code. I have not even looked at a single line. If you don't trust AI-written code, you probably should not run this.

## Development

```bash
npm install
npm run dev      # dev server at http://localhost:5173
npm run build    # type-check + production build → dist/
npm run preview  # serve the dist/ build locally
```

Requires Node 20+.

## Architecture notes

The processing pipeline runs in order: resize → dynamic range compression → tone mapping → saturation → exposure → dithering → palette swap (export only). See [CLAUDE.md](CLAUDE.md) for full architecture documentation.
