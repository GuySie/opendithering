import type { PaletteGroup } from '../types'

export const bwGroup: PaletteGroup = {
  id: 'bw',
  name: 'Black & White',
  variants: [
    {
      id: 'bw-default',
      name: 'Estimated',
      colors: [
        { name: 'black', measured: [26, 26, 26],   ideal: [0, 0, 0] },
        { name: 'white', measured: [216, 213, 204], ideal: [255, 255, 255] },
      ],
    },
  ],
}
