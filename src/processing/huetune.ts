import type { PipelineInput } from './pipeline'
import { runPipeline } from './pipeline'
import { resizeImage } from './resize'
import { rgbToOklab, oklabToRgb } from './colorspace'
import { boxBlur } from './tone'

const BLUR_RADIUS = 4
const FLOOR = 0.25
const CEILING = 4.0

export interface HueTuneBandDebug {
  name: string
  pixelCount: number
  refMeanC: number
  initialMeanC: number
  finalMeanC: number
  initialBandValue: number
  finalBandValue: number
}

export interface HueTuneDebug {
  iterationsRun: number
  converged: boolean
  bands: HueTuneBandDebug[]
  initialLoss: number
  finalLoss: number
  lossHistory: number[]
}

export interface HueTuneResult {
  hueSatBands: [number, number, number, number, number, number]
  debug: HueTuneDebug
}

const BAND_NAMES = ['Red', 'Yellow', 'Green', 'Cyan', 'Blue', 'Magenta'] as const

export function hueTune(input: PipelineInput, iterations = 20): HueTuneResult {
  const { source, srcWidth, srcHeight, dstWidth, dstHeight, resizeMode, palette, settings } = input

  const reference = resizeImage(source, srcWidth, srcHeight, dstWidth, dstHeight, resizeMode)

  // Apply DRC to reference so band stats reflect the same fixed transform the pipeline applies.
  if (settings.compressDynamicRange) {
    const sorted = palette.colors
      .map(c => ({ L: rgbToOklab(c.measured[0], c.measured[1], c.measured[2])[0] }))
      .sort((a, b) => b.L - a.L)
    const blackL = sorted[sorted.length - 1].L
    const range  = sorted[0].L - blackL
    const d = reference.data
    for (let i = 0; i < d.length; i += 4) {
      const [L, a, b] = rgbToOklab(d[i], d[i + 1], d[i + 2])
      const [r, g, bv] = oklabToRgb(blackL + L * range, a, b)
      d[i] = r; d[i + 1] = g; d[i + 2] = bv
    }
  }

  const minPixels = Math.max(50, Math.round((reference.data.length / 4) * 0.001))
  const resetBands: [number, number, number, number, number, number] = [1, 1, 1, 1, 1, 1]
  let bands: [number, number, number, number, number, number] = [...resetBands]

  let dithered = runPipeline({ ...input, settings: { ...settings, hueSatBands: bands } }).measured
  let prevStats = computeBandStats(reference.data, boxBlur(dithered.data, dithered.width, dithered.height, BLUR_RADIUS))
  let prevLoss = hueLoss(prevStats, minPixels)

  const lossHistory: number[] = [prevLoss]
  const initialStats = prevStats.map(s => ({ ...s }))
  let best: typeof bands = [...bands]
  let converged = true

  for (let i = 0; i < iterations; i++) {
    // Early exit: every active band is already pressing against its absolute bound
    const allActiveCapped = prevStats.every((s, idx) => {
      if (s.count < minPixels || s.dithMeanC < 0.001) return true
      const v = bands[idx]
      const ratio = s.refMeanC / s.dithMeanC
      return (ratio > 1.01 && v >= CEILING) || (ratio < 0.99 && v <= FLOOR)
    })
    if (allActiveCapped) { converged = true; break }

    const nextBands = bands.map((v, idx) => {
      const s = prevStats[idx]
      if (s.count < minPixels || s.dithMeanC < 0.001) return v
      const candidate = v * (1 + (s.refMeanC / s.dithMeanC - 1) * 0.3)
      const capped = clamp(candidate, v * 0.75, v * 1.25)
      return clamp(capped, FLOOR, CEILING)
    }) as typeof bands

    dithered = runPipeline({ ...input, settings: { ...settings, hueSatBands: nextBands } }).measured
    const newStats = computeBandStats(reference.data, boxBlur(dithered.data, dithered.width, dithered.height, BLUR_RADIUS))
    const newLoss = hueLoss(newStats, minPixels)

    if (!isFinite(newLoss) || newLoss >= prevLoss - 1e-4) break

    best = [...nextBands]
    prevLoss = newLoss
    prevStats = newStats
    bands = nextBands
    lossHistory.push(newLoss)

    if (i === iterations - 1) converged = false
  }

  return {
    hueSatBands: best,
    debug: {
      iterationsRun: lossHistory.length - 1,
      converged,
      bands: BAND_NAMES.map((name, idx) => ({
        name,
        pixelCount: prevStats[idx].count,
        refMeanC:     initialStats[idx].refMeanC,
        initialMeanC: initialStats[idx].dithMeanC,
        finalMeanC:   prevStats[idx].dithMeanC,
        initialBandValue: resetBands[idx],
        finalBandValue:   best[idx],
      })),
      initialLoss: lossHistory[0],
      finalLoss: prevLoss,
      lossHistory,
    },
  }
}

interface BandStat {
  refMeanC: number
  dithMeanC: number
  count: number
}

function computeBandStats(refData: Uint8ClampedArray, dithData: ArrayLike<number>): BandStat[] {
  // Accumulate OKLab a and b separately so we compute chroma of the mean vector,
  // not the mean of per-pixel chromas. This makes the metric hue-sensitive: pixels
  // that dither to the wrong hue cancel out in the vector sum, reducing effective
  // chroma even when individual pixel chromas are high.
  const refSumA  = new Float64Array(6), refSumB  = new Float64Array(6)
  const dithSumA = new Float64Array(6), dithSumB = new Float64Array(6)
  const counts   = new Float64Array(6)

  for (let i = 0; i < refData.length; i += 4) {
    const rr = refData[i], rg = refData[i + 1], rb = refData[i + 2]
    const rn = rr / 255, gn = rg / 255, bn = rb / 255
    const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn)
    const d = max - min
    if (d < 0.05) continue // achromatic — hue undefined, skip

    let h: number
    if (max === rn)      h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6
    else if (max === gn) h = ((bn - rn) / d + 2) / 6
    else                 h = ((rn - gn) / d + 4) / 6

    // Mirror applyHueSatBands: Math.floor bands + linear interpolation to next band.
    const hx = h * 6
    const bandIdx = Math.floor(hx) % 6
    const nextBand = (bandIdx + 1) % 6
    const t = hx - Math.floor(hx)

    const [, ra, rbv] = rgbToOklab(rr, rg, rb)
    refSumA[bandIdx] += (1 - t) * ra;  refSumB[bandIdx] += (1 - t) * rbv
    refSumA[nextBand] += t * ra;       refSumB[nextBand] += t * rbv

    const dr = dithData[i], dg = dithData[i + 1], db = dithData[i + 2]
    const [, da, dbv] = rgbToOklab(dr, dg, db)
    dithSumA[bandIdx] += (1 - t) * da;  dithSumB[bandIdx] += (1 - t) * dbv
    dithSumA[nextBand] += t * da;       dithSumB[nextBand] += t * dbv

    counts[bandIdx] += (1 - t)
    counts[nextBand] += t
  }

  return Array.from({ length: 6 }, (_, i) => {
    if (counts[i] === 0) return { refMeanC: 0, dithMeanC: 0, count: 0 }
    const rA = refSumA[i] / counts[i],  rB = refSumB[i] / counts[i]
    const dA = dithSumA[i] / counts[i], dB = dithSumB[i] / counts[i]
    return {
      refMeanC:  Math.sqrt(rA * rA + rB * rB),
      dithMeanC: Math.sqrt(dA * dA + dB * dB),
      count: counts[i],
    }
  })
}

function hueLoss(stats: BandStat[], minPixels: number): number {
  let total = 0
  for (const s of stats) {
    if (s.count >= minPixels) total += Math.abs(s.refMeanC - s.dithMeanC)
  }
  return total
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}
