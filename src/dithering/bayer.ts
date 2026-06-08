import type { DitheringAlgorithm, Palette, ColorSpace } from '../types'
import { findNearestColor } from './error-diffusion'

const BAYER4: number[][] = [
  [ 0,  8,  2, 10],
  [12,  4, 14,  6],
  [ 3, 11,  1,  9],
  [15,  7, 13,  5],
]

const BAYER8: number[][] = [
  [ 0, 32,  8, 40,  2, 34, 10, 42],
  [48, 16, 56, 24, 50, 18, 58, 26],
  [12, 44,  4, 36, 14, 46,  6, 38],
  [60, 28, 52, 20, 62, 30, 54, 22],
  [ 3, 35, 11, 43,  1, 33,  9, 41],
  [51, 19, 59, 27, 49, 17, 57, 25],
  [15, 47,  7, 39, 13, 45,  5, 37],
  [63, 31, 55, 23, 61, 29, 53, 21],
]

function orderedDither(
  src: ImageData,
  palette: Palette,
  distSpace: ColorSpace,
  matrix: number[][],
  matrixSize: number,
  levels: number,
): ImageData {
  const { width: w, height: h } = src
  const out = new ImageData(w, h)

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4
      const threshold = ((matrix[y % matrixSize][x % matrixSize] + 0.5) / (matrixSize * matrixSize) - 0.5) * (255 / levels)

      const r = Math.min(255, Math.max(0, src.data[idx]     + threshold))
      const g = Math.min(255, Math.max(0, src.data[idx + 1] + threshold))
      const b = Math.min(255, Math.max(0, src.data[idx + 2] + threshold))

      const colorIdx = findNearestColor(Math.round(r), Math.round(g), Math.round(b), palette, distSpace)
      const [mr, mg, mb] = palette.colors[colorIdx].measured
      out.data[idx]     = mr
      out.data[idx + 1] = mg
      out.data[idx + 2] = mb
      out.data[idx + 3] = 255
    }
  }
  return out
}

export const bayer4: DitheringAlgorithm = {
  id: 'bayer4',
  name: 'Bayer 4×4 (Ordered)',
  dither(src, palette, _errorSpace, distSpace, _strength, _localVariance) {
    return orderedDither(src, palette, distSpace, BAYER4, 4, palette.colors.length)
  },
}

export const bayer8: DitheringAlgorithm = {
  id: 'bayer8',
  name: 'Bayer 8×8 (Ordered)',
  dither(src, palette, _errorSpace, distSpace, _strength, _localVariance) {
    return orderedDither(src, palette, distSpace, BAYER8, 8, palette.colors.length)
  },
}
