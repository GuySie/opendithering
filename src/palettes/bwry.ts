import type { PaletteGroup } from '../types'

export const bwryGroup: PaletteGroup = {
  id: 'bwry',
  name: 'Black, White, Red & Yellow',
  variants: [
    {
      id: 'bwry-opendisplay',
      name: 'OpenDisplay',
      colors: [
        { name: 'black',  measured: [10, 7, 14],      ideal: [0, 0, 0] },
        { name: 'white',  measured: [173, 178, 174],   ideal: [255, 255, 255] },
        { name: 'red',    measured: [85, 24, 14],      ideal: [255, 0, 0] },
        { name: 'yellow', measured: [172, 128, 0],     ideal: [255, 255, 0] },
      ],
    },
    {
      id: 'bwry-default',
      name: 'Estimated',
      colors: [
        { name: 'black',  measured: [26, 26, 26],    ideal: [0, 0, 0] },
        { name: 'white',  measured: [216, 213, 204],  ideal: [255, 255, 255] },
        { name: 'red',    measured: [196, 65, 40],    ideal: [255, 0, 0] },
        { name: 'yellow', measured: [210, 185, 50],   ideal: [255, 255, 0] },
      ],
    },
  ],
}
