import type { ProcessingSettings, Palette, ResizeMode, HueGap } from '../types'
import { resizeImage } from './resize'
import { compressDynamicRange, applyToneMapping, applySaturation, applyExposure } from './tone'
import { applyHueRemap } from './hueremap'
import { getAlgorithm } from '../dithering/index'

export interface PipelineInput {
  source: HTMLImageElement | ImageBitmap
  srcWidth: number
  srcHeight: number
  dstWidth: number
  dstHeight: number
  resizeMode: ResizeMode
  palette: Palette
  settings: ProcessingSettings
  hueGaps?: HueGap[]
}

export interface PipelineResult {
  /** Dithered image with measured palette colors (for preview — realistic device appearance) */
  measured: ImageData
  /** Dithered image with ideal palette colors (for export — correct for firmware) */
  ideal: ImageData
}

export function runPipeline(input: PipelineInput): PipelineResult {
  const { source, srcWidth, srcHeight, dstWidth, dstHeight, resizeMode, palette, settings } = input

  // 1. Resize
  const resized = resizeImage(source, srcWidth, srcHeight, dstWidth, dstHeight, resizeMode)

  // 2. Dynamic range compression
  if (settings.compressDynamicRange) {
    compressDynamicRange(resized.data, palette)
  }

  // 3. Tone mapping
  applyToneMapping(resized.data, settings)

  // 4. Saturation
  applySaturation(resized.data, settings.saturation)

  // 4.5. Hue remapping — rotate gap-zone hues toward nearest representable palette hue
  if (input.hueGaps?.length) {
    applyHueRemap(resized.data, palette, input.hueGaps, {
      magenta: settings.hueRemapMagenta ?? 0,
      cyan:    settings.hueRemapCyan    ?? 0,
      orange:  settings.hueRemapOrange  ?? 0,
    })
  }

  // 5. Exposure
  applyExposure(resized.data, settings.exposure)

  // 6. Dithering — produces output with measured palette colors
  const algorithm = getAlgorithm(settings.ditherAlgorithm)

  // Optionally expand the palette with pure primaries for wider gamut snap-points.
  // The primaries are internal snap-points only: after dithering we remap any pixel
  // that landed on a primary back to the nearest original palette measured color so
  // that preview and export are unaffected by the expansion.
  const workingPalette = settings.expandPalette ? expandWithPrimaries(palette) : palette

  let measured = algorithm.dither(resized, workingPalette, settings.errorSpace, settings.distSpace, settings.ditherStrength, settings.localVarianceDetection, {
    serpentine:          settings.serpentine           ? 1 : 0,
    knoxAlpha:           settings.knoxAlpha           ?? 0.5,
    knoxFringe:          settings.knoxFringe           ?? 0.04,
    knoxEdgeSensitivity: settings.knoxEdgeSensitivity  ?? 4.0,
    riemersmaQueueSize:  settings.riemersmaQueueSize   ?? 16,
    dizzyDiagonalWeight: settings.dizzyDiagonalWeight  ?? 0.1,
  })

  if (workingPalette !== palette) {
    measured = remapToOriginalPalette(measured, palette)
  }

  // 7. Palette swap: measured → ideal (for export)
  const ideal = swapToIdeal(measured, palette)

  return { measured, ideal }
}

const PURE_PRIMARIES: [number, number, number][] = [
  [0, 0, 0],
  [255, 255, 255],
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255],
  [255, 255, 0],
]

function expandWithPrimaries(palette: Palette): Palette {
  const extras = PURE_PRIMARIES
    .filter(rgb => !palette.colors.some(c => c.measured[0] === rgb[0] && c.measured[1] === rgb[1] && c.measured[2] === rgb[2]))
    .map(rgb => ({ name: `primary-${rgb.join('-')}`, measured: rgb as [number, number, number], ideal: rgb as [number, number, number] }))
  if (extras.length === 0) return palette
  return { ...palette, colors: [...palette.colors, ...extras] }
}

function remapToOriginalPalette(dithered: ImageData, originalPalette: Palette): ImageData {
  const originalKeys = new Set(originalPalette.colors.map(c =>
    (c.measured[0] << 16) | (c.measured[1] << 8) | c.measured[2]
  ))

  // For each primary not already in the original palette, find its nearest original measured color
  const remapTable = new Map<number, [number, number, number]>()
  for (const rgb of PURE_PRIMARIES) {
    const key = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2]
    if (originalKeys.has(key)) continue
    let bestColor = originalPalette.colors[0].measured
    let bestDist = Infinity
    for (const c of originalPalette.colors) {
      const dr = rgb[0] - c.measured[0], dg = rgb[1] - c.measured[1], db = rgb[2] - c.measured[2]
      const d = dr * dr + dg * dg + db * db
      if (d < bestDist) { bestDist = d; bestColor = c.measured }
    }
    remapTable.set(key, bestColor)
  }

  if (remapTable.size === 0) return dithered

  const out = new ImageData(dithered.width, dithered.height)
  for (let i = 0; i < dithered.data.length; i += 4) {
    const key = (dithered.data[i] << 16) | (dithered.data[i + 1] << 8) | dithered.data[i + 2]
    const remap = remapTable.get(key)
    if (remap) {
      out.data[i] = remap[0]; out.data[i + 1] = remap[1]; out.data[i + 2] = remap[2]
    } else {
      out.data[i] = dithered.data[i]; out.data[i + 1] = dithered.data[i + 1]; out.data[i + 2] = dithered.data[i + 2]
    }
    out.data[i + 3] = 255
  }
  return out
}

function swapToIdeal(src: ImageData, palette: Palette): ImageData {
  // Build a Map from measured color key to ideal color for O(1) lookup
  const map = new Map<number, [number, number, number]>()
  for (const color of palette.colors) {
    const key = (color.measured[0] << 16) | (color.measured[1] << 8) | color.measured[2]
    map.set(key, color.ideal)
  }

  const out = new ImageData(src.width, src.height)
  for (let i = 0; i < src.data.length; i += 4) {
    const key = (src.data[i] << 16) | (src.data[i + 1] << 8) | src.data[i + 2]
    const ideal = map.get(key)
    if (ideal) {
      out.data[i] = ideal[0]; out.data[i + 1] = ideal[1]; out.data[i + 2] = ideal[2]
    } else {
      out.data[i] = src.data[i]; out.data[i + 1] = src.data[i + 1]; out.data[i + 2] = src.data[i + 2]
    }
    out.data[i + 3] = 255
  }
  return out
}
