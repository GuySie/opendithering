import type { PipelineInput } from './pipeline'
import { runPipeline } from './pipeline'
import { resizeImage } from './resize'
import { rgbToOklab, oklabToRgb } from './colorspace'

export interface AutoTuneDebug {
  iterationsRun: number
  converged: boolean
  refStats: { meanL: number; meanC: number; stddevL: number; meanA: number; meanBv: number; highlightFraction: number }
  initialStats: { meanL: number; meanC: number; stddevL: number; meanA: number; meanBv: number }
  finalStats: { meanL: number; meanC: number; stddevL: number; meanA: number; meanBv: number }
  initialLoss: number
  finalLoss: number
  /** Loss after each committed (improving) iteration, with baseline at index 0. */
  lossHistory: number[]
  initialSaturation: number
  finalSaturation: number
  initialExposure: number
  finalExposure: number
  initialContrast: number
  finalContrast: number
  initialStrength: number
  finalStrength: number
  initialShadowBoost: number
  finalShadowBoost: number
  initialHighlightCompress: number
  finalHighlightCompress: number
  initialRedGain: number
  finalRedGain: number
  initialGreenGain: number
  finalGreenGain: number
  initialBlueGain: number
  finalBlueGain: number
  toneMode: string
}

export interface AutoTuneResult {
  saturation: number
  exposure: number
  contrast: number
  strength: number
  shadowBoost: number
  highlightCompress: number
  redGain: number
  greenGain: number
  blueGain: number
  debug: AutoTuneDebug
}

export function autoTune(input: PipelineInput, iterations = 12): AutoTuneResult {
  const { source, srcWidth, srcHeight, dstWidth, dstHeight, resizeMode, palette, settings } = input

  // Never switch tone mode — respect whatever mode the user has chosen.
  const toneMode = settings.toneMode

  // Palette-based highlight threshold and white key (for s-curve path only)
  const sorted = palette.colors
    .map(c => ({ measured: c.measured, L: rgbToOklab(c.measured[0], c.measured[1], c.measured[2])[0] }))
    .sort((a, b) => b.L - a.L)
  const thresholdL = (sorted[0].L + (sorted[1]?.L ?? 0)) / 2
  const [wr, wg, wb] = sorted[0].measured
  const whiteKey = (wr << 16) | (wg << 8) | wb

  const reference = resizeImage(source, srcWidth, srcHeight, dstWidth, dstHeight, resizeMode)

  // Apply DRC to the reference so refStats reflects the same fixed transform the pipeline applies.
  if (settings.compressDynamicRange) {
    const blackL = sorted[sorted.length - 1].L
    const range  = sorted[0].L - blackL
    const d = reference.data
    for (let i = 0; i < d.length; i += 4) {
      const [L, a, b] = rgbToOklab(d[i], d[i + 1], d[i + 2])
      const [r, g, bv] = oklabToRgb(blackL + L * range, a, b)
      d[i] = r; d[i + 1] = g; d[i + 2] = bv
    }
  }

  const refStats = imageStats(reference, (_, __, ___, L) => L >= thresholdL)
  const refHighlight = Math.max(refStats.highlightFraction, 0.02)

  const isWhite = (r: number, g: number, b: number) => ((r << 16) | (g << 8) | b) === whiteKey

  // Read all initial values from settings.
  const initial = {
    saturation: settings.saturation,
    exposure: settings.exposure,
    contrast: settings.contrast,
    strength: settings.strength,
    shadowBoost: settings.shadowBoost,
    highlightCompress: settings.highlightCompress,
    redGain: settings.redGain,
    greenGain: settings.greenGain,
    blueGain: settings.blueGain,
  }

  let { saturation, exposure, contrast, strength, shadowBoost, highlightCompress, redGain, greenGain, blueGain } = initial

  // Establish baseline loss with current settings before making any changes.
  let prevStats = imageStats(
    runPipeline({ ...input, settings: { ...settings, saturation, exposure, contrast, strength, shadowBoost, highlightCompress, redGain, greenGain, blueGain } }).measured,
    isWhite,
  )
  let prevLoss = loss(refStats, prevStats)
  let best = { saturation, exposure, contrast, strength, shadowBoost, highlightCompress, redGain, greenGain, blueGain }

  const lossHistory: number[] = [prevLoss]
  const initialStats = { meanL: prevStats.meanL, meanC: prevStats.meanC, stddevL: prevStats.stddevL, meanA: prevStats.meanA, meanBv: prevStats.meanBv }
  let converged = true

  for (let i = 0; i < iterations; i++) {
    // Pass A: compute gain candidates from prevStats and run an interim pipeline
    // (tone params unchanged) so saturation/exposure see the post-gain image.
    // Gains are normalized to geometric mean = 1 so they only affect color balance,
    // not overall brightness — exposure handles brightness separately.
    const rawRed   = adjustGain(redGain,   refStats.meanR,    prevStats.meanR,    initial.redGain)
    const rawGreen = adjustGain(greenGain, refStats.meanG,    prevStats.meanG,    initial.greenGain)
    const rawBlue  = adjustGain(blueGain,  refStats.meanBlue, prevStats.meanBlue, initial.blueGain)
    const geoMean  = Math.cbrt(rawRed * rawGreen * rawBlue)
    const nextRedGain   = rawRed   / geoMean
    const nextGreenGain = rawGreen / geoMean
    const nextBlueGain  = rawBlue  / geoMean

    const interimStats = imageStats(
      runPipeline({ ...input, settings: { ...settings, saturation, exposure, contrast, strength, shadowBoost, highlightCompress, redGain: nextRedGain, greenGain: nextGreenGain, blueGain: nextBlueGain } }).measured,
      isWhite,
    )

    // Pass B: compute tone/saturation candidates from interimStats so they
    // compensate for any chroma or luminance shift the gains introduced.

    // Saturation: 50% damping + ±15% per-run cap.
    let nextSat = saturation
    if (interimStats.meanC > 0.001) {
      nextSat = clamp(
        clamp(
          saturation * (1 + (refStats.meanC / interimStats.meanC - 1) * 0.5),
          initial.saturation * 0.85, initial.saturation * 1.15,
        ),
        0.0, 2.0,
      )
    }

    // Exposure: 30% damping + ±15% hard cap.
    let nextExp = exposure
    if (interimStats.meanL > 0.001) {
      const adj = 1 + (refStats.meanL / interimStats.meanL - 1) * 0.3
      nextExp = clamp(
        clamp(exposure * adj, initial.exposure * 0.85, initial.exposure * 1.15),
        0.5, 2.0,
      )
    }

    // Contrast (contrast mode only): no relative cap — just hard absolute bounds.
    // stddevL can be far enough from target that a relative cap prevents convergence.
    let nextContrast = contrast
    if (toneMode === 'contrast' && interimStats.stddevL > 0.001) {
      const adj = 1 + (refStats.stddevL / interimStats.stddevL - 1) * 0.3
      nextContrast = clamp(contrast * adj, 0.5, 2.0)
    }

    // Strength (s-curve mode only): ±20% cap, additive-delta fallback from zero.
    let nextStrength = strength
    if (toneMode === 'scurve' && interimStats.stddevL > 0.001) {
      const lo = initial.strength > 0.001 ? initial.strength * 0.80 : 0
      const hi = initial.strength > 0.001 ? initial.strength * 1.20 : 0.15
      const candidate = strength > 0.001
        ? strength * (1 + (refStats.stddevL / interimStats.stddevL - 1) * 0.3)
        : (refStats.stddevL - interimStats.stddevL) * 0.3
      nextStrength = clamp(clamp(candidate, lo, hi), 0.0, 1.0)
    }

    // ShadowBoost (s-curve mode only): additive-delta fallback from zero.
    let nextShadowBoost = shadowBoost
    if (toneMode === 'scurve' && interimStats.shadowMeanL > 0.001) {
      const lo = initial.shadowBoost > 0.001 ? initial.shadowBoost * 0.85 : 0
      const hi = initial.shadowBoost > 0.001 ? initial.shadowBoost * 1.15 : 0.15
      const candidate = shadowBoost > 0.001
        ? shadowBoost * (1 + (refStats.shadowMeanL / interimStats.shadowMeanL - 1) * 0.3)
        : (refStats.shadowMeanL - interimStats.shadowMeanL) * 0.3
      nextShadowBoost = clamp(clamp(candidate, lo, hi), 0.0, 1.0)
    }

    // highlightCompress (s-curve mode only).
    let nextHC = highlightCompress
    if (toneMode === 'scurve') {
      const ratio = interimStats.highlightFraction / refHighlight
      nextHC = clamp(highlightCompress * clamp(ratio, 0.75, 1.35), 0.5, 5.0)
    }

    const result = runPipeline({
      ...input,
      settings: { ...settings, saturation: nextSat, exposure: nextExp, contrast: nextContrast, strength: nextStrength, shadowBoost: nextShadowBoost, highlightCompress: nextHC, redGain: nextRedGain, greenGain: nextGreenGain, blueGain: nextBlueGain },
    })
    const stats = imageStats(result.measured, isWhite)
    const newLoss = loss(refStats, stats)

    // If loss didn't improve, we've overshot or plateaued — revert and stop.
    if (newLoss >= prevLoss - 1e-4) break

    best = { saturation: nextSat, exposure: nextExp, contrast: nextContrast, strength: nextStrength, shadowBoost: nextShadowBoost, highlightCompress: nextHC, redGain: nextRedGain, greenGain: nextGreenGain, blueGain: nextBlueGain }
    prevLoss = newLoss
    prevStats = stats
    saturation = nextSat
    exposure = nextExp
    contrast = nextContrast
    strength = nextStrength
    shadowBoost = nextShadowBoost
    highlightCompress = nextHC
    redGain = nextRedGain
    greenGain = nextGreenGain
    blueGain = nextBlueGain
    lossHistory.push(newLoss)

    if (i === iterations - 1) converged = false
  }

  return {
    ...best,
    debug: {
      iterationsRun: lossHistory.length - 1,
      converged,
      refStats,
      initialStats,
      finalStats: { meanL: prevStats.meanL, meanC: prevStats.meanC, stddevL: prevStats.stddevL, meanA: prevStats.meanA, meanBv: prevStats.meanBv },
      initialLoss: lossHistory[0],
      finalLoss: prevLoss,
      lossHistory,
      initialSaturation: initial.saturation,
      finalSaturation: best.saturation,
      initialExposure: initial.exposure,
      finalExposure: best.exposure,
      initialContrast: initial.contrast,
      finalContrast: best.contrast,
      initialStrength: initial.strength,
      finalStrength: best.strength,
      initialShadowBoost: initial.shadowBoost,
      finalShadowBoost: best.shadowBoost,
      initialHighlightCompress: initial.highlightCompress,
      finalHighlightCompress: best.highlightCompress,
      initialRedGain: initial.redGain,
      finalRedGain: best.redGain,
      initialGreenGain: initial.greenGain,
      finalGreenGain: best.greenGain,
      initialBlueGain: initial.blueGain,
      finalBlueGain: best.blueGain,
      toneMode,
    },
  }
}

function adjustGain(current: number, refMean: number, prevMean: number, initialVal: number): number {
  if (prevMean < 0.001) return current
  const lo = initialVal > 0.001 ? initialVal * 0.85 : 0
  const hi = initialVal > 0.001 ? initialVal * 1.15 : 0.15
  const candidate = current > 0.001
    ? current * (1 + (refMean / prevMean - 1) * 0.3)
    : (refMean - prevMean) * 0.3
  return clamp(clamp(candidate, lo, hi), 0.5, 2.0)
}

function loss(ref: ImageStats, cur: ImageStats): number {
  return (
    Math.abs(ref.meanL   - cur.meanL)   +
    Math.abs(ref.meanC   - cur.meanC)   +
    Math.abs(ref.stddevL - cur.stddevL) +
    Math.abs(ref.meanA   - cur.meanA)   +
    Math.abs(ref.meanBv  - cur.meanBv)
  )
}

interface ImageStats {
  meanL: number
  meanC: number
  highlightFraction: number
  stddevL: number
  shadowMeanL: number
  meanA: number
  meanBv: number
  meanR: number
  meanG: number
  meanBlue: number
}

function imageStats(
  img: ImageData,
  isHighlight: (r: number, g: number, b: number, L: number) => boolean,
): ImageStats {
  const data = img.data
  const n = data.length / 4
  const SHADOW_THRESH = 0.4
  let sumL = 0, sumL2 = 0, sumC = 0, highlightCount = 0
  let sumShadowL = 0, shadowCount = 0
  let sumA = 0, sumBv = 0
  let sumR = 0, sumG = 0, sumBlue = 0

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2]
    const [L, a, bv] = rgbToOklab(r, g, b)
    sumL += L
    sumL2 += L * L
    sumC += Math.sqrt(a * a + bv * bv)
    sumA += a
    sumBv += bv
    sumR += r / 255
    sumG += g / 255
    sumBlue += b / 255
    if (isHighlight(r, g, b, L)) highlightCount++
    if (L < SHADOW_THRESH) { sumShadowL += L; shadowCount++ }
  }

  const meanL = sumL / n
  return {
    meanL,
    meanC: sumC / n,
    highlightFraction: highlightCount / n,
    stddevL: Math.sqrt(Math.max(0, sumL2 / n - meanL * meanL)),
    shadowMeanL: shadowCount > 0 ? sumShadowL / shadowCount : 0,
    meanA: sumA / n,
    meanBv: sumBv / n,
    meanR: sumR / n,
    meanG: sumG / n,
    meanBlue: sumBlue / n,
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}
