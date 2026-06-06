import type { DitheringAlgorithm, Palette, ColorSpace } from '../types'
import { findNearestColor } from './error-diffusion'

// Blue noise threshold dithering (Ulichney 1993, void-and-cluster).
// Threshold computed via Interleaved Gradient Noise (Jimenez 2014) — aperiodic,
// no stored texture required, no tiling artifacts at any resolution.
function ign(x: number, y: number): number {
  return (52.9829189 * ((0.06711056 * x + 0.00583715 * y) % 1)) % 1
}

export const blueNoise: DitheringAlgorithm = {
  id: 'blue-noise',
  name: 'Blue Noise',
  dither(src: ImageData, palette: Palette, _errorSpace: ColorSpace, distSpace: ColorSpace, _strength?: number, _localVariance?: boolean, extraParams?: Record<string, number>): ImageData {
    const { width: w, height: h } = src
    const out = new ImageData(w, h)
    const levels = palette.colors.length

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = (y * w + x) * 4
        const threshold = (ign(x, y) - 0.5) * (255 / levels)

        const r = Math.min(255, Math.max(0, src.data[idx]     + threshold))
        const g = Math.min(255, Math.max(0, src.data[idx + 1] + threshold))
        const b = Math.min(255, Math.max(0, src.data[idx + 2] + threshold))

        const colorIdx = findNearestColor(Math.round(r), Math.round(g), Math.round(b), palette, distSpace, !!extraParams?.oklabWeighted)
        const [mr, mg, mb] = palette.colors[colorIdx].measured
        out.data[idx]     = mr
        out.data[idx + 1] = mg
        out.data[idx + 2] = mb
        out.data[idx + 3] = 255
      }
    }
    return out
  },
}
