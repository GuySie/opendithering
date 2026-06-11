import type { PipelineInput } from './pipeline'
import { runPipeline } from './pipeline'
import { resizeImage } from './resize'
import { rgbToOklab, oklabToRgb } from './colorspace'

export interface ColorTuneDebug {
  iterationsRun: number
  converged: boolean
  refStats: { meanC: number; meanA: number; meanBv: number }
  initialStats: { meanC: number; meanA: number; meanBv: number }
  finalStats: { meanC: number; meanA: number; meanBv: number }
  initialLoss: number
  finalLoss: number
  /** Loss after each committed (improving) iteration, with baseline at index 0. */
  lossHistory: number[]
  initialSaturation: number
  finalSaturation: number
  initialRedGain: number
  finalRedGain: number
  initialGreenGain: number
  finalGreenGain: number
  initialBlueGain: number
  finalBlueGain: number
}

export interface ColorTuneResult {
  saturation: number
  redGain: number
  greenGain: number
  blueGain: number
  debug: ColorTuneDebug
}

export function colorTune(input: PipelineInput, iterations = 12): ColorTuneResult {
  const { source, srcWidth, srcHeight, dstWidth, dstHeight, resizeMode, palette, settings } = input

  const sorted = palette.colors
    .map(c => ({ measured: c.measured, L: rgbToOklab(c.measured[0], c.measured[1], c.measured[2])[0] }))
    .sort((a, b) => b.L - a.L)

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

  const refStats = imageStats(reference)

  const initial = {
    saturation: settings.saturation,
    redGain: 1.0,
    greenGain: 1.0,
    blueGain: 1.0,
  }

  let { saturation, redGain, greenGain, blueGain } = initial

  // Establish baseline loss with current settings before making any changes.
  let prevStats = imageStats(
    runPipeline({ ...input, settings: { ...settings, saturation, redGain, greenGain, blueGain } }).measured,
  )
  let prevLoss = loss(refStats, prevStats)
  let best = { saturation, redGain, greenGain, blueGain }

  const lossHistory: number[] = [prevLoss]
  const initialStats = { meanC: prevStats.meanC, meanA: prevStats.meanA, meanBv: prevStats.meanBv }
  let converged = true

  for (let i = 0; i < iterations; i++) {
    // Pass A: adjust channel gains (normalized to geo mean = 1 so they only
    // affect color balance, not overall brightness).
    const nextRedGain   = adjustGain(redGain,   refStats.meanR,    prevStats.meanR,    initial.redGain)
    const nextGreenGain = adjustGain(greenGain, refStats.meanG,    prevStats.meanG,    initial.greenGain)
    const nextBlueGain  = adjustGain(blueGain,  refStats.meanBlue, prevStats.meanBlue, initial.blueGain)

    const nextSat = saturation

    const result = runPipeline({
      ...input,
      settings: { ...settings, saturation: nextSat, redGain: nextRedGain, greenGain: nextGreenGain, blueGain: nextBlueGain },
    })
    const stats = imageStats(result.measured)
    const newLoss = loss(refStats, stats)

    // If loss didn't improve, we've overshot or plateaued — revert and stop.
    if (newLoss >= prevLoss - 1e-4) break

    best = { saturation: nextSat, redGain: nextRedGain, greenGain: nextGreenGain, blueGain: nextBlueGain }
    prevLoss = newLoss
    prevStats = stats
    saturation = nextSat
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
      finalStats: { meanC: prevStats.meanC, meanA: prevStats.meanA, meanBv: prevStats.meanBv },
      initialLoss: lossHistory[0],
      finalLoss: prevLoss,
      lossHistory,
      initialSaturation: initial.saturation,
      finalSaturation: best.saturation,
      initialRedGain: initial.redGain,
      finalRedGain: best.redGain,
      initialGreenGain: initial.greenGain,
      finalGreenGain: best.greenGain,
      initialBlueGain: initial.blueGain,
      finalBlueGain: best.blueGain,
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
    Math.abs(ref.meanC  - cur.meanC)  +
    Math.abs(ref.meanA  - cur.meanA)  +
    Math.abs(ref.meanBv - cur.meanBv)
  )
}

interface ImageStats {
  meanC: number
  meanA: number
  meanBv: number
  meanR: number
  meanG: number
  meanBlue: number
}

function imageStats(img: ImageData): ImageStats {
  const data = img.data
  const n = data.length / 4
  let sumC = 0, sumA = 0, sumBv = 0
  let sumR = 0, sumG = 0, sumBlue = 0

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2]
    const [, a, bv] = rgbToOklab(r, g, b)
    sumC += Math.sqrt(a * a + bv * bv)
    sumA += a
    sumBv += bv
    sumR += r / 255
    sumG += g / 255
    sumBlue += b / 255
  }

  return {
    meanC: sumC / n,
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
