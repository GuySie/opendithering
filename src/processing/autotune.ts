import type { PipelineInput } from './pipeline'
import { runPipeline } from './pipeline'
import { resizeImage } from './resize'
import { rgbToOklab } from './colorspace'

export interface AutoTuneDebug {
  iterationsRun: number
  converged: boolean
  refStats: { meanL: number; meanC: number; highlightFraction: number }
  initialStats: { meanL: number; meanC: number }
  finalStats: { meanL: number; meanC: number }
  initialLoss: number
  finalLoss: number
  /** Loss after each committed (improving) iteration, with baseline at index 0. */
  lossHistory: number[]
  initialSaturation: number
  finalSaturation: number
  initialExposure: number
  finalExposure: number
  initialHighlightCompress: number
  finalHighlightCompress: number
  toneMode: string
}

export interface AutoTuneResult {
  saturation: number
  exposure: number
  highlightCompress: number
  debug: AutoTuneDebug
}

export function autoTune(
  input: PipelineInput,
  initialSaturation: number,
  initialExposure: number,
  initialHighlightCompress: number,
  iterations = 8,
): AutoTuneResult {
  const { source, srcWidth, srcHeight, dstWidth, dstHeight, resizeMode, palette, settings } = input

  // Never switch tone mode — respect whatever mode the user has chosen.
  // If they want s-curve highlight protection they switch to it first, then auto-tune.
  const toneMode = settings.toneMode

  // Palette-based highlight threshold and white key (for s-curve path only)
  const sorted = palette.colors
    .map(c => ({ measured: c.measured, L: rgbToOklab(c.measured[0], c.measured[1], c.measured[2])[0] }))
    .sort((a, b) => b.L - a.L)
  const thresholdL = (sorted[0].L + (sorted[1]?.L ?? 0)) / 2
  const [wr, wg, wb] = sorted[0].measured
  const whiteKey = (wr << 16) | (wg << 8) | wb

  const reference = resizeImage(source, srcWidth, srcHeight, dstWidth, dstHeight, resizeMode)
  const refStats = imageStats(reference, (_, __, ___, L) => L >= thresholdL)
  const refHighlight = Math.max(refStats.highlightFraction, 0.02)

  const isWhite = (r: number, g: number, b: number) => ((r << 16) | (g << 8) | b) === whiteKey

  let saturation = initialSaturation
  let exposure = initialExposure
  let highlightCompress = initialHighlightCompress

  // Establish baseline loss with current settings before making any changes.
  let prevStats = imageStats(
    runPipeline({ ...input, settings: { ...settings, saturation, exposure, highlightCompress } }).measured,
    isWhite,
  )
  let prevLoss = loss(refStats, prevStats)
  let best = { saturation, exposure, highlightCompress }

  const lossHistory: number[] = [prevLoss]
  const initialStats = { meanL: prevStats.meanL, meanC: prevStats.meanC }
  let converged = true

  for (let i = 0; i < iterations; i++) {
    // Compute candidate adjustments from the previous iteration's output stats.

    // Saturation: 50% damping + ±15% per-run cap (mirrors the exposure cap).
    let nextSat = saturation
    if (prevStats.meanC > 0.001) {
      nextSat = clamp(
        clamp(
          saturation * (1 + (refStats.meanC / prevStats.meanC - 1) * 0.5),
          initialSaturation * 0.85, initialSaturation * 1.15,
        ),
        0.0, 2.0,
      )
    }

    // Exposure: 30% damping + ±15% hard cap.
    let nextExp = exposure
    if (prevStats.meanL > 0.001) {
      const adj = 1 + (refStats.meanL / prevStats.meanL - 1) * 0.3
      nextExp = clamp(
        clamp(exposure * adj, initialExposure * 0.85, initialExposure * 1.15),
        0.5, 2.0,
      )
    }

    // highlightCompress: only in s-curve mode.
    let nextHC = highlightCompress
    if (toneMode === 'scurve') {
      const ratio = prevStats.highlightFraction / refHighlight
      nextHC = clamp(highlightCompress * clamp(ratio, 0.75, 1.35), 0.5, 5.0)
    }

    const result = runPipeline({
      ...input,
      settings: { ...settings, saturation: nextSat, exposure: nextExp, highlightCompress: nextHC },
    })
    const stats = imageStats(result.measured, isWhite)
    const newLoss = loss(refStats, stats)

    // If loss didn't improve, we've overshot or plateaued — revert and stop.
    if (newLoss >= prevLoss) break

    best = { saturation: nextSat, exposure: nextExp, highlightCompress: nextHC }
    prevLoss = newLoss
    prevStats = stats
    saturation = nextSat
    exposure = nextExp
    highlightCompress = nextHC
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
      finalStats: { meanL: prevStats.meanL, meanC: prevStats.meanC },
      initialLoss: lossHistory[0],
      finalLoss: prevLoss,
      lossHistory,
      initialSaturation,
      finalSaturation: best.saturation,
      initialExposure,
      finalExposure: best.exposure,
      initialHighlightCompress,
      finalHighlightCompress: best.highlightCompress,
      toneMode,
    },
  }
}

function loss(ref: ImageStats, cur: ImageStats): number {
  return Math.abs(ref.meanL - cur.meanL) + Math.abs(ref.meanC - cur.meanC)
}

interface ImageStats { meanL: number; meanC: number; highlightFraction: number }

function imageStats(
  img: ImageData,
  isHighlight: (r: number, g: number, b: number, L: number) => boolean,
): ImageStats {
  const data = img.data
  const n = data.length / 4
  let sumL = 0, sumC = 0, highlightCount = 0

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2]
    const [L, a, bv] = rgbToOklab(r, g, b)
    sumL += L
    sumC += Math.sqrt(a * a + bv * bv)
    if (isHighlight(r, g, b, L)) highlightCount++
  }

  return { meanL: sumL / n, meanC: sumC / n, highlightFraction: highlightCount / n }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}
