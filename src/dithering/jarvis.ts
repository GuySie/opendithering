import type { DitheringAlgorithm, Palette, ColorSpace } from '../types'
import { errorDiffuse } from './error-diffusion'

//       * 7 5
// 3 5 7 5 3
// 1 3 5 3 1   /48
const KERNEL = [
  { dx:  1, dy: 0, weight: 7 },
  { dx:  2, dy: 0, weight: 5 },
  { dx: -2, dy: 1, weight: 3 },
  { dx: -1, dy: 1, weight: 5 },
  { dx:  0, dy: 1, weight: 7 },
  { dx:  1, dy: 1, weight: 5 },
  { dx:  2, dy: 1, weight: 3 },
  { dx: -2, dy: 2, weight: 1 },
  { dx: -1, dy: 2, weight: 3 },
  { dx:  0, dy: 2, weight: 5 },
  { dx:  1, dy: 2, weight: 3 },
  { dx:  2, dy: 2, weight: 1 },
]

export const jarvis: DitheringAlgorithm = {
  id: 'jarvis',
  name: 'Jarvis-Judice-Ninke',
  dither(src: ImageData, palette: Palette, errorSpace: ColorSpace, distSpace: ColorSpace, strength: number, localVariance?: boolean): ImageData {
    return errorDiffuse(src, palette, errorSpace, distSpace, strength, KERNEL, 48, localVariance)
  },
}
