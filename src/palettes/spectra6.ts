import type { PaletteGroup } from '../types'

export const spectra6Group: PaletteGroup = {
  id: 'spectra6',
  name: 'Spectra 6 (6-color)',
  variants: [
    {
      id: 'spectra6-aitjcize',
      name: 'aitjcize',
      colors: [
        { name: 'black',  measured: [2, 2, 2],        ideal: [0, 0, 0] },
        { name: 'white',  measured: [190, 200, 200],  ideal: [255, 255, 255] },
        { name: 'green',  measured: [39, 102, 60],    ideal: [0, 255, 0] },
        { name: 'blue',   measured: [5, 64, 158],     ideal: [0, 0, 255] },
        { name: 'red',    measured: [135, 19, 0],     ideal: [255, 0, 0] },
        { name: 'yellow', measured: [205, 202, 0],    ideal: [255, 255, 0] },
      ],
    },
    {
      id: 'spectra6-wenting',
      name: 'Wenting',
      colors: [
        { name: 'black',  measured: [46, 44, 66],    ideal: [0, 0, 0] },
        { name: 'white',  measured: [211, 214, 205], ideal: [255, 255, 255] },
        { name: 'green',  measured: [92, 138, 91],   ideal: [0, 255, 0] },
        { name: 'blue',   measured: [49, 106, 193],  ideal: [0, 0, 255] },
        { name: 'red',    measured: [177, 29, 25],   ideal: [255, 0, 0] },
        { name: 'yellow', measured: [217, 199, 1],   ideal: [255, 255, 0] },
      ],
    },
    {
      id: 'spectra6-opendisplay',
      name: 'OpenDisplay',
      colors: [
        { name: 'black',  measured: [31, 24, 41],    ideal: [0, 0, 0] },
        { name: 'white',  measured: [168, 180, 182],  ideal: [255, 255, 255] },
        { name: 'green',  measured: [50, 84, 60],     ideal: [0, 255, 0] },
        { name: 'blue',   measured: [36, 70, 139],    ideal: [0, 0, 255] },
        { name: 'red',    measured: [113, 24, 19],    ideal: [255, 0, 0] },
        { name: 'yellow', measured: [180, 173, 0],    ideal: [255, 255, 0] },
      ],
    },
    {
      id: 'spectra6-epdoptimize',
      name: 'EPDOptimize',
      colors: [
        { name: 'black',  measured: [31, 34, 38],    ideal: [0, 0, 0] },
        { name: 'white',  measured: [185, 199, 201],  ideal: [255, 255, 255] },
        { name: 'green',  measured: [53, 86, 58],     ideal: [0, 255, 0] },
        { name: 'blue',   measured: [35, 63, 142],    ideal: [0, 0, 255] },
        { name: 'red',    measured: [98, 32, 30],     ideal: [255, 0, 0] },
        { name: 'yellow', measured: [193, 187, 30],   ideal: [255, 255, 0] },
      ],
    },
    {
      // CR30 colorimeter, D65/2°, 26.5 °C ambient, 7.3" panel. measuredLab is the
      // average of 5 samples per color (raw data: reference/guysie-spectra6measurements.pdf);
      // measured sRGB is derived by the registry (values here are that derivation, kept
      // for reference). Blue is slightly outside sRGB gamut — R clamps to 0.
      id: 'spectra6-guysie',
      name: 'guysie',
      colors: [
        { name: 'black',  measuredLab: [9.414, 6.136, -6.848],    measured: [30, 24, 36],    ideal: [0, 0, 0] },
        { name: 'white',  measuredLab: [62.566, -3.988, 0.262],   measured: [144, 153, 151], ideal: [255, 255, 255] },
        { name: 'green',  measuredLab: [30.602, -21.66, 9.01],    measured: [36, 81, 57],    ideal: [0, 255, 0] },
        { name: 'blue',   measuredLab: [31.754, -3.508, -34.162], measured: [0, 79, 128],    ideal: [0, 0, 255] },
        { name: 'red',    measuredLab: [23.862, 36.28, 26.854],   measured: [110, 26, 18],   ideal: [255, 0, 0] },
        { name: 'yellow', measuredLab: [60.494, -7.37, 63.85],    measured: [162, 147, 3],   ideal: [255, 255, 0] },
      ],
    },
    {
      // GDEP133C02 datasheet rev 1.0 §8.1 typical L*a*b* (Eye-One Pro3 Plus, 25 °C).
      // measuredLab is the source of truth; measured sRGB is derived by the registry
      // (values shown here are that derivation, kept for reference).
      id: 'spectra6-goodisplay',
      name: 'GooDisplay',
      colors: [
        { name: 'black',  measuredLab: [12, 7, -11],    measured: [33, 29, 47],    ideal: [0, 0, 0] },
        { name: 'white',  measuredLab: [66.5, -4, 0],   measured: [154, 164, 162], ideal: [255, 255, 255] },
        { name: 'green',  measuredLab: [35, -22, 15],   measured: [52, 91, 58],    ideal: [0, 255, 0] },
        { name: 'blue',   measuredLab: [34, 3.5, -37],  measured: [24, 82, 139],   ideal: [0, 0, 255] },
        { name: 'red',    measuredLab: [26.5, 41, 30],  measured: [123, 25, 19],   ideal: [255, 0, 0] },
        { name: 'yellow', measuredLab: [62, -11, 65],   measured: [161, 153, 3],   ideal: [255, 255, 0] },
      ],
    },
    {
      id: 'spectra6-epdoptimize-legacy',
      name: 'EPDOptimize (Legacy)',
      colors: [
        { name: 'black',  measured: [25, 30, 33],     ideal: [0, 0, 0] },
        { name: 'white',  measured: [232, 232, 232],  ideal: [255, 255, 255] },
        { name: 'green',  measured: [18, 95, 32],     ideal: [0, 255, 0] },
        { name: 'blue',   measured: [33, 87, 186],    ideal: [0, 0, 255] },
        { name: 'red',    measured: [178, 19, 24],    ideal: [255, 0, 0] },
        { name: 'yellow', measured: [239, 222, 68],   ideal: [255, 255, 0] },
      ],
    },
  ],
}
