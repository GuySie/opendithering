import type { PipelineInput } from './pipeline'
import { resizeImage } from './resize'
import { rgbToOklab, oklabToRgb } from './colorspace'

export interface AutoExposeDebug {
  meanL: number
  stddevL: number
  shadowMeanL: number
  highlightFraction: number
}

export interface AutoExposeResult {
  exposure: number
  saturation: number
  contrast: number
  strength: number
  shadowBoost: number
  highlightCompress: number
  midpoint: number
  redGain: number
  greenGain: number
  blueGain: number
  compressDynamicRange: boolean
  debug: AutoExposeDebug
}

const TARGET_MEAN_L    = 0.55
const TARGET_STDDEV_L  = 0.27
const SHADOW_THRESH    = 0.35
const HIGHLIGHT_THRESH = 0.85

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

export function autoExpose(input: PipelineInput): AutoExposeResult {
  const { source, srcWidth, srcHeight, dstWidth, dstHeight, resizeMode, palette, settings } = input

  const sorted = palette.colors
    .map(c => ({ L: rgbToOklab(c.measured[0], c.measured[1], c.measured[2])[0] }))
    .sort((a, b) => b.L - a.L)
  const blackL = sorted[sorted.length - 1].L
  const range  = sorted[0].L - blackL

  const img = resizeImage(source, srcWidth, srcHeight, dstWidth, dstHeight, resizeMode)
  const d = img.data

  // Apply DRC so stats reflect the display's actual tone range
  for (let i = 0; i < d.length; i += 4) {
    const [L, a, b] = rgbToOklab(d[i], d[i + 1], d[i + 2])
    const [r, g, bv] = oklabToRgb(blackL + L * range, a, b)
    d[i] = r; d[i + 1] = g; d[i + 2] = bv
  }

  const n = d.length / 4
  let sumL = 0, sumL2 = 0, shadowSum = 0, shadowCount = 0, highlightCount = 0

  for (let i = 0; i < d.length; i += 4) {
    const [L] = rgbToOklab(d[i], d[i + 1], d[i + 2])
    sumL  += L
    sumL2 += L * L
    if (L < SHADOW_THRESH) { shadowSum += L; shadowCount++ }
    if (L > HIGHLIGHT_THRESH) highlightCount++
  }

  const meanL            = sumL / n
  const stddevL          = Math.sqrt(Math.max(0, sumL2 / n - meanL * meanL))
  const shadowMeanL      = shadowCount > 0 ? shadowSum / shadowCount : SHADOW_THRESH
  const highlightFraction = highlightCount / n

  const exposure = meanL > 0.001 ? clamp(TARGET_MEAN_L / meanL, 0.5, 2.0) : 1.0

  let contrast = 1.0
  let strength = 0.0
  let shadowBoost = 0.0
  let highlightCompress = 1.0

  if (settings.toneMode === 'contrast') {
    contrast = stddevL > 0.001 ? clamp(TARGET_STDDEV_L / stddevL, 0.5, 2.0) : 1.0
  } else {
    // s-curve: strength scales with how much contrast boost is needed
    strength          = stddevL > 0.001 ? clamp(TARGET_STDDEV_L / (stddevL * 2), 0.0, 1.0) : 0.5
    shadowBoost       = shadowMeanL < 0.20 ? clamp(0.3 * (0.20 - shadowMeanL) / 0.20, 0.0, 0.3) : 0.0
    highlightCompress = highlightFraction > 0.05 ? clamp(1.0 + highlightFraction * 4, 1.0, 3.0) : 1.0
  }

  return {
    exposure,
    saturation: 1.0,
    contrast,
    strength,
    shadowBoost,
    highlightCompress,
    midpoint: 0.5,
    redGain: 1.0,
    greenGain: 1.0,
    blueGain: 1.0,
    compressDynamicRange: true,
    debug: { meanL, stddevL, shadowMeanL, highlightFraction },
  }
}
