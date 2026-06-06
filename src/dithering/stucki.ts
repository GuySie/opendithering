import type { DitheringAlgorithm, Palette, ColorSpace } from '../types'
import { errorDiffuse } from './error-diffusion'

//       * 8 4
// 2 4 8 4 2
// 1 2 4 2 1   /42
const KERNEL = [
  { dx:  1, dy: 0, weight: 8 },
  { dx:  2, dy: 0, weight: 4 },
  { dx: -2, dy: 1, weight: 2 },
  { dx: -1, dy: 1, weight: 4 },
  { dx:  0, dy: 1, weight: 8 },
  { dx:  1, dy: 1, weight: 4 },
  { dx:  2, dy: 1, weight: 2 },
  { dx: -2, dy: 2, weight: 1 },
  { dx: -1, dy: 2, weight: 2 },
  { dx:  0, dy: 2, weight: 4 },
  { dx:  1, dy: 2, weight: 2 },
  { dx:  2, dy: 2, weight: 1 },
]

export const stucki: DitheringAlgorithm = {
  id: 'stucki',
  name: 'Stucki',
  dither(src: ImageData, palette: Palette, errorSpace: ColorSpace, distSpace: ColorSpace, strength: number, localVariance?: boolean, extraParams?: Record<string, number>): ImageData {
    return errorDiffuse(src, palette, errorSpace, distSpace, strength, KERNEL, 42, localVariance, extraParams?.serpentine !== 0, !!extraParams?.oklabWeighted)
  },
}
