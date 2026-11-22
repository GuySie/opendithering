import type { PaletteGroup } from '../types'

export const spectra6Group: PaletteGroup = {
  id: 'spectra6',
  name: 'Spectra 6 (6-color)',
  variants: [
    {
      // CHNSpec CR30, 26 °C ambient, 7.3" panel. Measured directly as sRGB under D65/2°
      // (colour.XYZ_to_sRGB on D65-integrated XYZ from raw reflectance spectra, via
      // epaper-colorcal) — not Lab-sourced, so no measuredLab here. Average of 10 reads
      // per color across two independent sessions (5 each), which agreed to within
      // ΔE 0.1-0.5 per color (raw data: epaper-colorcal's
      // reference/spectra_7_3_6color_cr30_*.json, field srgb_d65).
      id: 'spectra6-guysie',
      name: 'guysie',
      colors: [
        { name: 'black',  measured: [33, 23, 36],    ideal: [0, 0, 0] },
        { name: 'white',  measured: [143, 154, 152], ideal: [255, 255, 255] },
        { name: 'green',  measured: [34, 78, 63],    ideal: [0, 255, 0] },
        { name: 'blue',   measured: [8, 71, 127],    ideal: [0, 0, 255] },
        { name: 'red',    measured: [106, 23, 18],   ideal: [255, 0, 0] },
        { name: 'yellow', measured: [158, 152, 18],  ideal: [255, 255, 0] },
      ],
    },
    {
      // CHNSpec CR30, 22 °C ambient, 7.3" panel (same panel as 'spectra6-guysie', which
      // was measured at 26 °C). Measured directly as sRGB under D65/2°
      // (colour.XYZ_to_sRGB on D65-integrated XYZ from raw reflectance spectra, via
      // epaper-colorcal) — not Lab-sourced, so no measuredLab here. Average of 40 reads
      // per color across 8 independent sessions (5 each; 2 of 10 sessions excluded),
      // each within ΔE 0.72 of the pool (raw data: epaper-colorcal's
      // reference/spectra_7_3_6color_cr30_22c_*.json, field srgb_d65).
      id: 'spectra6-guysie-22c',
      name: 'guysie (22 °C)',
      colors: [
        { name: 'black',  measured: [38, 30, 40],    ideal: [0, 0, 0] },
        { name: 'white',  measured: [145, 155, 152], ideal: [255, 255, 255] },
        { name: 'green',  measured: [47, 84, 70],    ideal: [0, 255, 0] },
        { name: 'blue',   measured: [4, 69, 123],    ideal: [0, 0, 255] },
        { name: 'red',    measured: [110, 28, 24],   ideal: [255, 0, 0] },
        { name: 'yellow', measured: [157, 148, 25],  ideal: [255, 255, 0] },
      ],
    },
    {
      // CHNSpec CR30, 22 °C ambient, 7.09" 1200x1600 panel. Measured directly as sRGB
      // under D65/2° (colour.XYZ_to_sRGB on D65-integrated XYZ from raw reflectance
      // spectra, via epaper-colorcal) — not Lab-sourced, so no measuredLab here. Average
      // of 40 reads per color across 8 independent sessions (5 each; 2 of 10 sessions
      // excluded), each within ΔE 0.37 of the pool (raw data: epaper-colorcal's
      // reference/spectra_7_09_6color_cr30_*.json, field srgb_d65).
      id: 'spectra6-guysie-7in09',
      name: 'guysie (7.09")',
      colors: [
        { name: 'black',  measured: [35, 26, 41],    ideal: [0, 0, 0] },
        { name: 'white',  measured: [133, 147, 157], ideal: [255, 255, 255] },
        { name: 'green',  measured: [53, 92, 74],    ideal: [0, 255, 0] },
        { name: 'blue',   measured: [17, 70, 126],   ideal: [0, 0, 255] },
        { name: 'red',    measured: [122, 24, 18],   ideal: [255, 0, 0] },
        { name: 'yellow', measured: [156, 145, 14],  ideal: [255, 255, 0] },
      ],
      // 4-neighbour mixing model (scripts/mixing, R=1: kernel weight 2.981 × fitted β per pair/channel),
      // fitted on 1×1 checkerboards measured with a CR30 on this panel; predicts 2×2 checkerboards at mean
      // ΔE00 1.62 and real DBS output at 1.63 (linear mixing: 5.95 / 3.87).
      mixing: {
        source: 'CHNSpec CR30, Seeed XIAO EE02 (ODA08AB0), 7.09" panel, room 20.7 °C, 2026-11-22, white reset before every pattern',
        neighbourAttenuation: {
          'black/white':  [0.3178, 0.3393, 0.2360],
          'black/yellow': [0.1765, 0.2292, 0.0398],
          'black/red':    [0.0168, -0.0005, -0.0155],
          'black/blue':   [0.0625, 0.0542, 0.1192],
          'black/green':  [-0.0880, -0.0494, -0.0550],
          'white/yellow': [0.0111, 0.0065, 0.0553],
          'white/red':    [0.0656, 0.0724, 0.1898],
          'white/blue':   [0.0806, 0.0825, 0.0362],
          'white/green':  [-0.0520, -0.0565, 0.0051],
          'yellow/red':   [0.0256, 0.0465, -0.0319],
          'yellow/blue':  [0.1102, 0.1137, 0.0561],
          'yellow/green': [-0.0040, -0.0098, 0.0688],
          'red/blue':     [0.0483, 0.0099, 0.1683],
          'red/green':    [-0.0036, -0.0242, 0.0730],
          'blue/green':   [-0.0776, -0.0889, -0.0096],
        },
      },
    },
    {
      // GDEP133C02 datasheet rev 1.0 §8.1 typical L*a*b* (Eye-One Pro3 Plus, 25 °C).
      // measuredLab is the source of truth; measured sRGB is derived by the registry
      // (values shown here are that derivation, kept for reference).
      id: 'spectra6-goodisplay',
      name: 'GoodDisplay',
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
