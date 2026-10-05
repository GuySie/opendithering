export interface PaletteColor {
  name: string
  measured: [number, number, number] // sRGB as seen on physical device
  measuredLab?: [number, number, number] // original instrument L*a*b* (D65/2°, absolute); when present, the registry derives `measured` from it
  ideal: [number, number, number]     // sRGB the firmware expects
}

export interface Palette {
  id: string
  name: string
  colors: PaletteColor[]
}

export interface PaletteGroup {
  id: string       // e.g. 'spectra6'
  name: string     // e.g. 'Spectra 6 (6-color)' — used in Custom palette-type picker
  variants: Palette[]  // index 0 = default measured variant; ideal appended by registry
}

export interface DisplayPreset {
  id: string
  name: string
  manufacturer: string
  width: number
  height: number
  paletteGroupId: string
  diagonalInches?: number  // physical screen diagonal; used to derive PPI for DBS refine
}

export type ResizeMode = 'cover' | 'contain' | 'stretch' | 'none'
export type ToneMode = 'contrast' | 'scurve'
export type ColorSpace = 'rgb' | 'cielab' | 'oklab' | 'oklab-chroma'

export interface ProcessingSettings {
  exposure: number              // 0.5–2.0, default 1.0
  saturation: number            // 0.5–2.0, default 1.0
  compressDynamicRange: boolean // default true
  toneMode: ToneMode
  contrast: number              // 0.5–2.0 (contrast mode)
  strength: number              // 0.0–1.0 (scurve mode)
  shadowBoost: number           // 0.0–1.0 (scurve mode)
  highlightCompress: number     // 0.5–5.0 (scurve mode)
  midpoint: number              // 0.3–0.7 (scurve mode)
  errorSpace: ColorSpace
  distSpace: ColorSpace
  ditherStrength: number         // 0.0–1.0, how much error is forwarded
  localVarianceDetection: boolean // reduce diffusion strength in flat areas
  expandPalette: boolean         // append pure primaries to working palette
  redGain: number                // 0.5–2.0, per-channel color grading
  greenGain: number              // 0.5–2.0
  blueGain: number               // 0.5–2.0
  ditherAlgorithm: string
  serpentine: boolean             // alternate scan direction each row (default true)
  knoxAlpha: number              // 0.0–1.0, tone-dependency strength for Eschbach & Knox
  knoxFringe: number             // 0.00–0.15, fringe field magnitude for Eschbach & Knox
  knoxEdgeSensitivity: number    // 0.5–8.0, cross-edge suppression sensitivity for Eschbach & Knox
  riemersmaQueueSize: number     // 4–64, error history queue length for Riemersma
  dizzyDiagonalWeight: number    // 0.0–1.0, diagonal neighbour weight for Dizzy
  clarity: number                // -1.0–1.0, unsharp mask strength (0 = off, positive = sharpen, negative = blur)
  clarityRadius: number          // 1–4, box blur radius for unsharp mask (larger = coarser features sharpened)
  hueSatBands: [number, number, number, number, number, number]  // per-hue sat multipliers [Red, Yellow, Green, Cyan, Blue, Magenta], default [1,1,1,1,1,1]
  gamutMapping: boolean          // map out-of-gamut target colours onto the palette's hull before dithering
  gamutMappingBalance: number    // 0–1: 0 = keep lightness (desaturate), 1 = keep saturation (move towards mid lightness)
}

export interface DitheringAlgorithm {
  id: string
  name: string
  dither(src: ImageData, palette: Palette, errorSpace: ColorSpace, distSpace: ColorSpace, strength: number, localVariance?: boolean, extraParams?: Record<string, number>): ImageData
}

export interface ImageFile {
  id: string
  name: string
  original: ImageData
  dithered: ImageData | null
  ideal?: ImageData
  target?: ImageData  // adjusted pre-dither image from the last pipeline run (DBS refine target)
  refined?: boolean   // dithered/ideal hold a DBS-refined result (cleared by the next pipeline run)
  width: number   // display target width (after resize)
  height: number  // display target height (after resize)
  cropOffsetX: number // 0–1, position of the crop window within the source image's horizontal overflow (cover/none modes only); 0.5 = centered
  cropOffsetY: number // 0–1, same for vertical overflow
}

export const BALANCED_PRESET: ProcessingSettings = {
  exposure: 1.0,
  saturation: 1.3,
  compressDynamicRange: true,
  toneMode: 'scurve',
  contrast: 1.0,
  strength: 0.9,
  shadowBoost: 0.0,
  highlightCompress: 1.5,
  midpoint: 0.5,
  errorSpace: 'oklab',
  distSpace: 'oklab',
  ditherStrength: 1.0,
  localVarianceDetection: false,
  expandPalette: false,
  redGain: 1.0,
  greenGain: 1.0,
  blueGain: 1.0,
  ditherAlgorithm: 'floyd-steinberg',
  serpentine: true,
  knoxAlpha: 0.5,
  knoxFringe: 0.04,
  knoxEdgeSensitivity: 4.0,
  riemersmaQueueSize: 16,
  dizzyDiagonalWeight: 0.1,
  clarity: 0.0,
  clarityRadius: 2,
  hueSatBands: [1, 1, 1, 1, 1, 1],
  gamutMapping: false,
  gamutMappingBalance: 0.5,
}

export const VIVID_PRESET: ProcessingSettings = {
  exposure: 1.1,
  saturation: 1.6,
  compressDynamicRange: false,
  toneMode: 'scurve',
  contrast: 1.0,
  strength: 0.7,
  shadowBoost: 0.1,
  highlightCompress: 1.3,
  midpoint: 0.5,
  errorSpace: 'rgb',
  distSpace: 'rgb',
  ditherStrength: 1.0,
  localVarianceDetection: false,
  expandPalette: false,
  redGain: 1.0,
  greenGain: 1.0,
  blueGain: 1.0,
  ditherAlgorithm: 'floyd-steinberg',
  serpentine: true,
  knoxAlpha: 0.5,
  knoxFringe: 0.04,
  knoxEdgeSensitivity: 4.0,
  riemersmaQueueSize: 16,
  dizzyDiagonalWeight: 0.1,
  clarity: 0.0,
  clarityRadius: 2,
  hueSatBands: [1, 1, 1, 1, 1, 1],
  gamutMapping: false,
  gamutMappingBalance: 0.5,
}

export const SOFT_PRESET: ProcessingSettings = {
  exposure: 1.0,
  saturation: 1.1,
  compressDynamicRange: true,
  toneMode: 'contrast',
  contrast: 0.9,
  strength: 0.9,
  shadowBoost: 0.0,
  highlightCompress: 1.5,
  midpoint: 0.5,
  errorSpace: 'rgb',
  distSpace: 'rgb',
  ditherStrength: 1.0,
  localVarianceDetection: false,
  expandPalette: false,
  redGain: 1.0,
  greenGain: 1.0,
  blueGain: 1.0,
  ditherAlgorithm: 'stucki',
  serpentine: true,
  knoxAlpha: 0.5,
  knoxFringe: 0.04,
  knoxEdgeSensitivity: 4.0,
  riemersmaQueueSize: 16,
  dizzyDiagonalWeight: 0.1,
  clarity: 0.0,
  clarityRadius: 2,
  hueSatBands: [1, 1, 1, 1, 1, 1],
  gamutMapping: false,
  gamutMappingBalance: 0.5,
}

export const GRAYSCALE_PRESET: ProcessingSettings = {
  exposure: 1.0,
  saturation: 0.0,
  compressDynamicRange: true,
  toneMode: 'contrast',
  contrast: 1.0,
  strength: 0.9,
  shadowBoost: 0.0,
  highlightCompress: 1.5,
  midpoint: 0.5,
  errorSpace: 'oklab',
  distSpace: 'oklab',
  ditherStrength: 1.0,
  localVarianceDetection: false,
  expandPalette: false,
  redGain: 1.0,
  greenGain: 1.0,
  blueGain: 1.0,
  ditherAlgorithm: 'dizzy',
  serpentine: true,
  knoxAlpha: 0.5,
  knoxFringe: 0.04,
  knoxEdgeSensitivity: 4.0,
  riemersmaQueueSize: 16,
  dizzyDiagonalWeight: 0.1,
  clarity: 0.0,
  clarityRadius: 2,
  hueSatBands: [1, 1, 1, 1, 1, 1],
  gamutMapping: false,
  gamutMappingBalance: 0.5,
}

export const NONE_PRESET: ProcessingSettings = {
  exposure: 1.0,
  saturation: 1.0,
  compressDynamicRange: false,
  toneMode: 'contrast',
  contrast: 1.0,
  strength: 0.0,
  shadowBoost: 0.0,
  highlightCompress: 1.0,
  midpoint: 0.5,
  errorSpace: 'rgb',
  distSpace: 'rgb',
  ditherStrength: 1.0,
  localVarianceDetection: false,
  expandPalette: false,
  redGain: 1.0,
  greenGain: 1.0,
  blueGain: 1.0,
  ditherAlgorithm: 'floyd-steinberg',
  serpentine: true,
  knoxAlpha: 0.5,
  knoxFringe: 0.04,
  knoxEdgeSensitivity: 4.0,
  riemersmaQueueSize: 16,
  dizzyDiagonalWeight: 0.1,
  clarity: 0.0,
  clarityRadius: 2,
  hueSatBands: [1, 1, 1, 1, 1, 1],
  gamutMapping: false,
  gamutMappingBalance: 0.5,
}

export type PresetName = 'balanced' | 'vivid' | 'soft' | 'grayscale' | 'none' | 'custom'

export const PRESETS: Record<Exclude<PresetName, 'custom'>, ProcessingSettings> = {
  balanced: BALANCED_PRESET,
  vivid: VIVID_PRESET,
  soft: SOFT_PRESET,
  grayscale: GRAYSCALE_PRESET,
  none: NONE_PRESET,
}
