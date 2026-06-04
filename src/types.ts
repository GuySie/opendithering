export interface PaletteColor {
  name: string
  measured: [number, number, number] // sRGB as seen on physical device
  ideal: [number, number, number]     // sRGB the firmware expects
}

export interface Palette {
  id: string
  name: string
  colors: PaletteColor[]
}

export interface HueGap {
  id: string      // e.g. 'magenta' | 'cyan' | 'orange'
  label: string   // e.g. 'Magenta/Purple'
  hueMin: number  // degrees, 0–360
  hueMax: number  // degrees, 0–360
}

export interface PaletteGroup {
  id: string       // e.g. 'spectra6'
  name: string     // e.g. 'Spectra 6 (6-color)' — used in Custom palette-type picker
  variants: Palette[]  // index 0 = default measured variant; ideal appended by registry
  hueGaps?: HueGap[]   // hue ranges the palette cannot reproduce well
}

export interface DisplayPreset {
  id: string
  name: string
  manufacturer: string
  width: number
  height: number
  paletteGroupId: string
}

export type ResizeMode = 'cover' | 'contain' | 'stretch' | 'none'
export type ToneMode = 'contrast' | 'scurve'
export type ColorSpace = 'rgb' | 'cielab' | 'oklab'

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
  ditherAlgorithm: string
  serpentine: boolean             // alternate scan direction each row (default true)
  knoxAlpha: number              // 0.0–1.0, tone-dependency strength for Eschbach & Knox
  knoxFringe: number             // 0.00–0.15, fringe field magnitude for Eschbach & Knox
  knoxEdgeSensitivity: number    // 0.5–8.0, cross-edge suppression sensitivity for Eschbach & Knox
  riemersmaQueueSize: number     // 4–64, error history queue length for Riemersma
  dizzyDiagonalWeight: number    // 0.0–1.0, diagonal neighbour weight for Dizzy
  hueRemapMagenta: number        // 0.0–1.0, remap magenta/purple toward nearest palette hue
  hueRemapCyan: number           // 0.0–1.0, remap cyan/teal toward nearest palette hue
  hueRemapOrange: number         // 0.0–1.0, remap orange toward nearest palette hue
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
  width: number   // display target width (after resize)
  height: number  // display target height (after resize)
}

export const BALANCED_PRESET: ProcessingSettings = {
  exposure: 1.0,
  saturation: 1.3,
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
  ditherAlgorithm: 'floyd-steinberg',
  serpentine: true,
  knoxAlpha: 0.5,
  knoxFringe: 0.04,
  knoxEdgeSensitivity: 4.0,
  riemersmaQueueSize: 16,
  dizzyDiagonalWeight: 0.1,
  hueRemapMagenta: 0,
  hueRemapCyan: 0,
  hueRemapOrange: 0,
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
  ditherAlgorithm: 'floyd-steinberg',
  serpentine: true,
  knoxAlpha: 0.5,
  knoxFringe: 0.04,
  knoxEdgeSensitivity: 4.0,
  riemersmaQueueSize: 16,
  dizzyDiagonalWeight: 0.1,
  hueRemapMagenta: 0,
  hueRemapCyan: 0,
  hueRemapOrange: 0,
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
  ditherAlgorithm: 'stucki',
  serpentine: true,
  knoxAlpha: 0.5,
  knoxFringe: 0.04,
  knoxEdgeSensitivity: 4.0,
  riemersmaQueueSize: 16,
  dizzyDiagonalWeight: 0.1,
  hueRemapMagenta: 0,
  hueRemapCyan: 0,
  hueRemapOrange: 0,
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
  ditherAlgorithm: 'dizzy',
  serpentine: true,
  knoxAlpha: 0.5,
  knoxFringe: 0.04,
  knoxEdgeSensitivity: 4.0,
  riemersmaQueueSize: 16,
  dizzyDiagonalWeight: 0.1,
  hueRemapMagenta: 0,
  hueRemapCyan: 0,
  hueRemapOrange: 0,
}

export type PresetName = 'balanced' | 'vivid' | 'soft' | 'grayscale' | 'custom'

export const PRESETS: Record<Exclude<PresetName, 'custom'>, ProcessingSettings> = {
  balanced: BALANCED_PRESET,
  vivid: VIVID_PRESET,
  soft: SOFT_PRESET,
  grayscale: GRAYSCALE_PRESET,
}
