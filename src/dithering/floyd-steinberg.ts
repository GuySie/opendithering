import type { DitheringAlgorithm, Palette, ColorSpace } from '../types'
import { errorDiffuse } from './error-diffusion'

//     * 7
// 3 5 1  /16
const KERNEL = [
  { dx:  1, dy: 0, weight: 7 },
  { dx: -1, dy: 1, weight: 3 },
  { dx:  0, dy: 1, weight: 5 },
  { dx:  1, dy: 1, weight: 1 },
]

export const floydSteinberg: DitheringAlgorithm = {
  id: 'floyd-steinberg',
  name: 'Floyd-Steinberg',
  dither(src: ImageData, palette: Palette, errorSpace: ColorSpace, distSpace: ColorSpace, strength: number, localVariance?: boolean): ImageData {
    return errorDiffuse(src, palette, errorSpace, distSpace, strength, KERNEL, 16, localVariance)
  },
}
