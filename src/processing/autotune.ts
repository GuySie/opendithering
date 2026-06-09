import type { PipelineInput } from './pipeline'
import { runPipeline } from './pipeline'
import { resizeImage } from './resize'
import { rgbToOklab } from './colorspace'

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
  initialAOffset: number
  finalAOffset: number
  initialBOffset: number
  finalBOffset: number
  toneMode: string
}

export interface AutoTuneResult {
  saturation: number
  exposure: number
  contrast: number
  strength: number
  shadowBoost: number
  highlightCompress: number
  aOffset: number
  bOffset: number
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
  const whitePaletteL = sorted[0].L

  // Apply the same DRC the pipeline applies so refStats are in the palette's
  // [blackL, whiteL] L space — otherwise the optimizer fights a systematic gap
  // it can never close and overcorrects exposure.
  let drcBlackL = 0, drcWhiteL = 1
  if (settings.compressDynamicRange) {
    const drcSorted = palette.colors
      .map(c => ({ L: rgbToOklab(c.measured[0], c.measured[1], c.measured[2])[0] }))
      .sort((a, b) => a.L - b.L)
    drcBlackL = drcSorted[0].L
    drcWhiteL = drcSorted[drcSorted.length - 1].L
  }

  const reference = resizeImage(source, srcWidth, srcHeight, dstWidth, dstHeight, resizeMode)
  const refBuf = imageDataToOklabBuf(reference)
  if (settings.compressDynamicRange) {
    const drcRange = drcWhiteL - drcBlackL
    for (let i = 0; i < refBuf.length; i += 3) refBuf[i] = drcBlackL + refBuf[i] * drcRange
  }
  const refStats = imageStats(refBuf, L => L >= thresholdL)
  const refHighlight = Math.max(refStats.highlightFraction, 0.02)

  // Read all initial values from settings.
  const initial = {
    saturation: settings.saturation,
    exposure: settings.exposure,
    contrast: settings.contrast,
    strength: settings.strength,
    shadowBoost: settings.shadowBoost,
    highlightCompress: settings.highlightCompress,
    aOffset: settings.aOffset,
    bOffset: settings.bOffset,
  }

  let { saturation, exposure, contrast, strength, shadowBoost, highlightCompress, aOffset, bOffset } = initial

  // Establish baseline with current settings before making any changes.
  let prevStats = imageStats(
    imageDataToOklabBuf(runPipeline({ ...input, settings: { ...settings, saturation, exposure, contrast, strength, shadowBoost, highlightCompress, aOffset, bOffset } }).measured),
    L => L >= whitePaletteL,
  )
  let prevLoss = loss(refStats, prevStats)
  let best = { saturation, exposure, contrast, strength, shadowBoost, highlightCompress, aOffset, bOffset }

  const lossHistory: number[] = [prevLoss]
  const initialStats = { meanL: prevStats.meanL, meanC: prevStats.meanC, stddevL: prevStats.stddevL, meanA: prevStats.meanA, meanBv: prevStats.meanBv }
  let converged = true

  for (let i = 0; i < iterations; i++) {
    // Two sequential sub-passes per iteration: L then C.
    // Each is accepted/rejected against total loss — independent progress
    // without the non-monotonic oscillation that partial-loss acceptance caused.
    // C runs after L so it can correct any chroma drift L introduced.

    // ── L sub-pass: exposure, contrast/strength, shadowBoost, highlightCompress ──

    // Exposure: 30% damping + ±15% hard cap.
    let nextExp = exposure
    if (prevStats.meanL > 0.001) {
      const adj = 1 + (refStats.meanL / prevStats.meanL - 1) * 0.3
      nextExp = clamp(
        clamp(exposure * adj, exposure * 0.85, exposure * 1.15),
        0.5, 2.0,
      )
    }

    // Contrast (contrast mode only): no relative cap — just hard absolute bounds.
    let nextContrast = contrast
    if (toneMode === 'contrast' && prevStats.stddevL > 0.001) {
      const adj = 1 + (refStats.stddevL / prevStats.stddevL - 1) * 0.3
      nextContrast = clamp(contrast * adj, 0.5, 2.0)
    }

    // Strength (s-curve mode only): ±20% cap, additive-delta fallback from zero.
    let nextStrength = strength
    if (toneMode === 'scurve' && prevStats.stddevL > 0.001) {
      const lo = initial.strength > 0.001 ? initial.strength * 0.80 : 0
      const hi = initial.strength > 0.001 ? initial.strength * 1.20 : 0.15
      const candidate = strength > 0.001
        ? strength * (1 + (refStats.stddevL / prevStats.stddevL - 1) * 0.3)
        : (refStats.stddevL - prevStats.stddevL) * 0.3
      nextStrength = clamp(clamp(candidate, lo, hi), 0.0, 1.0)
    }

    // ShadowBoost (s-curve mode only): additive-delta fallback from zero.
    let nextShadowBoost = shadowBoost
    if (toneMode === 'scurve' && prevStats.shadowMeanL > 0.001) {
      const lo = initial.shadowBoost > 0.001 ? initial.shadowBoost * 0.85 : 0
      const hi = initial.shadowBoost > 0.001 ? initial.shadowBoost * 1.15 : 0.15
      const candidate = shadowBoost > 0.001
        ? shadowBoost * (1 + (refStats.shadowMeanL / prevStats.shadowMeanL - 1) * 0.3)
        : (refStats.shadowMeanL - prevStats.shadowMeanL) * 0.3
      nextShadowBoost = clamp(clamp(candidate, lo, hi), 0.0, 1.0)
    }

    // highlightCompress (s-curve mode only).
    let nextHC = highlightCompress
    if (toneMode === 'scurve') {
      const ratio = prevStats.highlightFraction / refHighlight
      nextHC = clamp(highlightCompress * clamp(ratio, 0.75, 1.35), 0.5, 5.0)
    }

    const lResult = runPipeline({
      ...input,
      settings: { ...settings, saturation, exposure: nextExp, contrast: nextContrast, strength: nextStrength, shadowBoost: nextShadowBoost, highlightCompress: nextHC, aOffset, bOffset },
    })
    const statsAfterL = imageStats(imageDataToOklabBuf(lResult.measured), L => L >= whitePaletteL)
    const lossAfterL = loss(refStats, statsAfterL)
    const lImproved = lossAfterL < prevLoss - 1e-4
    if (lImproved) {
      exposure = nextExp; contrast = nextContrast; strength = nextStrength
      shadowBoost = nextShadowBoost; highlightCompress = nextHC
      prevStats = statsAfterL
      prevLoss = lossAfterL
      best = { saturation, exposure, contrast, strength, shadowBoost, highlightCompress, aOffset, bOffset }
    }

    // ── C sub-pass: saturation, aOffset, bOffset ──
    // Uses prevStats from L pass (if committed) so chroma corrects against post-L output.

    // Saturation: 50% damping + ±15% per-run cap.
    let nextSat = saturation
    if (prevStats.meanC > 0.001) {
      nextSat = clamp(
        clamp(
          saturation * (1 + (refStats.meanC / prevStats.meanC - 1) * 0.5),
          initial.saturation * 0.85, saturation * 1.15,
        ),
        0.0, 2.0,
      )
    }

    // Color balance: direct additive correction from meanA/meanBv mismatch.
    const nextAOffset = clamp(aOffset + (refStats.meanA  - prevStats.meanA)  * 0.3, -0.15, 0.15)
    const nextBOffset = clamp(bOffset + (refStats.meanBv - prevStats.meanBv) * 0.3, -0.15, 0.15)

    const cResult = runPipeline({
      ...input,
      settings: { ...settings, saturation: nextSat, exposure, contrast, strength, shadowBoost, highlightCompress, aOffset: nextAOffset, bOffset: nextBOffset },
    })
    const statsAfterC = imageStats(imageDataToOklabBuf(cResult.measured), L => L >= whitePaletteL)
    const lossAfterC = loss(refStats, statsAfterC)
    const cImproved = lossAfterC < prevLoss - 1e-4
    if (cImproved) {
      saturation = nextSat; aOffset = nextAOffset; bOffset = nextBOffset
      prevStats = statsAfterC
      prevLoss = lossAfterC
      best = { saturation, exposure, contrast, strength, shadowBoost, highlightCompress, aOffset, bOffset }
    }

    if (!lImproved && !cImproved) break

    lossHistory.push(prevLoss)
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
      finalLoss: lossHistory[lossHistory.length - 1],
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
      initialAOffset: initial.aOffset,
      finalAOffset: best.aOffset,
      initialBOffset: initial.bOffset,
      finalBOffset: best.bOffset,
      toneMode,
    },
  }
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
}

function imageDataToOklabBuf(img: ImageData): Float32Array {
  const n = img.data.length / 4
  const buf = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    const [L, a, b] = rgbToOklab(img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2])
    buf[i * 3] = L; buf[i * 3 + 1] = a; buf[i * 3 + 2] = b
  }
  return buf
}

function imageStats(buf: Float32Array, isHighlight: (L: number) => boolean): ImageStats {
  const n = buf.length / 3
  const SHADOW_THRESH = 0.4
  let sumL = 0, sumL2 = 0, sumC = 0, highlightCount = 0
  let sumShadowL = 0, shadowCount = 0
  let sumA = 0, sumBv = 0

  for (let i = 0; i < n; i++) {
    const L = buf[i * 3], a = buf[i * 3 + 1], bv = buf[i * 3 + 2]
    sumL += L; sumL2 += L * L
    sumC += Math.sqrt(a * a + bv * bv)
    sumA += a; sumBv += bv
    if (isHighlight(L)) highlightCount++
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
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}
