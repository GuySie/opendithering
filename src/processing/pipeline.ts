import type { ProcessingSettings, Palette, ResizeMode } from '../types'
import { resizeImage } from './resize'
import { compressDynamicRange, applyToneMapping, applySaturation, applyExposure, applyColorBalance } from './tone'
import { rgbToOklab, oklabToRgb } from './colorspace'
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
}

export interface PipelineResult {
  /** Dithered image with measured palette colors (for preview — realistic device appearance) */
  measured: ImageData
  /** Dithered image with ideal palette colors (for export — correct for firmware) */
  ideal: ImageData
}

// Pack sRGB ImageData into a Float32Array of [L, a, b] triples.
function toOklab(data: Uint8ClampedArray): Float32Array {
  const n = data.length / 4
  const buf = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    const [L, a, b] = rgbToOklab(data[i * 4], data[i * 4 + 1], data[i * 4 + 2])
    buf[i * 3]     = L
    buf[i * 3 + 1] = a
    buf[i * 3 + 2] = b
  }
  return buf
}

// Write OKLab float buffer back into sRGB ImageData (alpha unchanged).
function fromOklab(buf: Float32Array, data: Uint8ClampedArray): void {
  const n = buf.length / 3
  for (let i = 0; i < n; i++) {
    const [r, g, b] = oklabToRgb(buf[i * 3], buf[i * 3 + 1], buf[i * 3 + 2])
    data[i * 4]     = r
    data[i * 4 + 1] = g
    data[i * 4 + 2] = b
  }
}

export function runPipeline(input: PipelineInput): PipelineResult {
  const { source, srcWidth, srcHeight, dstWidth, dstHeight, resizeMode, palette, settings } = input

  // 1. Resize
  const resized = resizeImage(source, srcWidth, srcHeight, dstWidth, dstHeight, resizeMode)

  // 2. Convert to OKLab (single conversion in)
  const buf = toOklab(resized.data)

  // 3. Dynamic range compression — scale L into palette's [blackL, whiteL]
  if (settings.compressDynamicRange) {
    const sorted = palette.colors
      .map(c => ({ L: rgbToOklab(c.measured[0], c.measured[1], c.measured[2])[0] }))
      .sort((a, b) => a.L - b.L)
    const blackL = sorted[0].L
    const whiteL = sorted[sorted.length - 1].L
    compressDynamicRange(buf, blackL, whiteL)
  }

  // 4. Tone mapping (L only — chroma-neutral)
  applyToneMapping(buf, settings)

  // 5. Saturation (scale a and b uniformly)
  applySaturation(buf, settings.saturation)

  // 6. Exposure (scale L)
  applyExposure(buf, settings.exposure)

  // 7. Color balance (add aOffset/bOffset to a/b)
  applyColorBalance(buf, settings.aOffset, settings.bOffset)

  // 8. Convert back to sRGB (single conversion out)
  fromOklab(buf, resized.data)

  // 9. Dithering — produces output with measured palette colors
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

  // 10. Palette swap: measured → ideal (for export)
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
