import type { PaletteGroup } from '../types'

export const bwrGroup: PaletteGroup = {
  id: 'bwr',
  name: 'Black, White & Red',
  variants: [
    {
      id: 'bwr-default',
      name: 'Estimated',
      colors: [
        { name: 'black', measured: [26, 26, 26],   ideal: [0, 0, 0] },
        { name: 'white', measured: [216, 213, 204], ideal: [255, 255, 255] },
        { name: 'red',   measured: [196, 65, 40],   ideal: [255, 0, 0] },
      ],
    },
  ],
}
