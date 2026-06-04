import type { DitheringAlgorithm, Palette, ColorSpace } from '../types'
import { errorDiffuse } from './error-diffusion'

//   * 1 1
// 1 1 1
//   1      /8  (only 6/8 of error is distributed — intentional)
const KERNEL = [
  { dx:  1, dy: 0, weight: 1 },
  { dx:  2, dy: 0, weight: 1 },
  { dx: -1, dy: 1, weight: 1 },
  { dx:  0, dy: 1, weight: 1 },
  { dx:  1, dy: 1, weight: 1 },
  { dx:  0, dy: 2, weight: 1 },
]

export const atkinson: DitheringAlgorithm = {
  id: 'atkinson',
  name: 'Atkinson',
  dither(src: ImageData, palette: Palette, errorSpace: ColorSpace, distSpace: ColorSpace, strength: number, localVariance?: boolean, extraParams?: Record<string, number>): ImageData {
    return errorDiffuse(src, palette, errorSpace, distSpace, strength, KERNEL, 8, localVariance, extraParams?.serpentine !== 0)
  },
}
