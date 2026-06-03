import type { PaletteGroup } from '../types'

export const acepGroup: PaletteGroup = {
  id: 'acep',
  name: 'Gallery / ACeP (7-color)',
  variants: [
    {
      id: 'acep-epdoptimize',
      name: 'EPDOptimize',
      colors: [
        { name: 'black',  measured: [25, 30, 33],    ideal: [0, 0, 0] },
        { name: 'white',  measured: [241, 241, 241],  ideal: [255, 255, 255] },
        { name: 'green',  measured: [83, 164, 40],    ideal: [0, 255, 0] },
        { name: 'blue',   measured: [49, 49, 143],    ideal: [0, 0, 255] },
        { name: 'red',    measured: [210, 14, 19],    ideal: [255, 0, 0] },
        { name: 'yellow', measured: [243, 207, 17],   ideal: [255, 255, 0] },
        { name: 'orange', measured: [184, 94, 28],    ideal: [255, 128, 0] },
      ],
    },
  ],
}
