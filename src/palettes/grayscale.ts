import type { PaletteGroup } from '../types'

function grayLevel(level: number, max: number): [number, number, number] {
  const v = Math.round((level / max) * 255)
  return [v, v, v]
}

function grayEntry(level: number, max: number, label: string) {
  const ideal = grayLevel(level, max)
  const raw = (level / max) * 255
  const measured = Math.round(raw * 0.82 + 18)
  return { name: label, measured: [measured, measured, measured] as [number, number, number], ideal }
}

export const grayscale4Group: PaletteGroup = {
  id: 'grayscale4',
  name: 'Grayscale 4-level',
  variants: [
    {
      id: 'grayscale4-default',
      name: 'Estimated',
      colors: [
        grayEntry(0, 3, 'black'),
        grayEntry(1, 3, 'dark gray'),
        grayEntry(2, 3, 'light gray'),
        grayEntry(3, 3, 'white'),
      ],
    },
  ],
}

export const grayscale16Group: PaletteGroup = {
  id: 'grayscale16',
  name: 'Grayscale 16-level',
  variants: [
    {
      id: 'grayscale16-default',
      name: 'Estimated',
      colors: Array.from({ length: 16 }, (_, i) =>
        grayEntry(i, 15, i === 0 ? 'black' : i === 15 ? 'white' : `gray ${i}`)
      ),
    },
    {
      id: 'grayscale16-measured',
      name: 'Measured',
      colors: [
        { name: 'black',   measured: [ 32,  32,  32], ideal: [  0,   0,   0] },
        { name: 'gray 1',  measured: [ 38,  38,  38], ideal: [ 17,  17,  17] },
        { name: 'gray 2',  measured: [ 42,  42,  42], ideal: [ 34,  34,  34] },
        { name: 'gray 3',  measured: [ 46,  46,  46], ideal: [ 51,  51,  51] },
        { name: 'gray 4',  measured: [ 51,  51,  51], ideal: [ 68,  68,  68] },
        { name: 'gray 5',  measured: [ 58,  58,  58], ideal: [ 85,  85,  85] },
        { name: 'gray 6',  measured: [ 63,  63,  63], ideal: [102, 102, 102] },
        { name: 'gray 7',  measured: [ 72,  72,  72], ideal: [119, 119, 119] },
        { name: 'gray 8',  measured: [ 86,  86,  86], ideal: [136, 136, 136] },
        { name: 'gray 9',  measured: [ 95,  95,  95], ideal: [153, 153, 153] },
        { name: 'gray 10', measured: [100, 100, 100], ideal: [170, 170, 170] },
        { name: 'gray 11', measured: [114, 114, 114], ideal: [187, 187, 187] },
        { name: 'gray 12', measured: [123, 123, 123], ideal: [204, 204, 204] },
        { name: 'gray 13', measured: [142, 142, 142], ideal: [221, 221, 221] },
        { name: 'gray 14', measured: [156, 156, 156], ideal: [238, 238, 238] },
        { name: 'white',   measured: [160, 160, 160], ideal: [255, 255, 255] },
      ],
    },
  ],
}
