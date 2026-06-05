import type { PipelineInput } from './pipeline'
import { runPipeline } from './pipeline'
import { resizeImage } from './resize'
import { rgbToOklab } from './colorspace'

export function autoTune(
  input: PipelineInput,
  initialSaturation: number,
  initialExposure: number,
  initialHighlightCompress: number,
  iterations = 3,
): { saturation: number; exposure: number; highlightCompress: number } {
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

  let saturation = initialSaturation
  let exposure = initialExposure
  let highlightCompress = initialHighlightCompress

  for (let i = 0; i < iterations; i++) {
    const result = runPipeline({
      ...input,
      settings: { ...settings, saturation, exposure, highlightCompress },
    })
    const stats = imageStats(result.measured, (r, g, b) =>
      ((r << 16) | (g << 8) | b) === whiteKey
    )

    // Saturation: 50% damping prevents over-correction from white pixels pulling
    // mean chroma down.
    if (stats.meanC > 0.001) {
      saturation = clamp(
        saturation * (1 + (refStats.meanC / stats.meanC - 1) * 0.5),
        0.0, 2.0,
      )
    }

    // Exposure: 30% damping + ±15% hard cap. The cap is the main guard against
    // auto-tune introducing blowout that wasn't in the original settings.
    if (stats.meanL > 0.001) {
      const adj = 1 + (refStats.meanL / stats.meanL - 1) * 0.3
      exposure = clamp(
        clamp(exposure * adj, initialExposure * 0.85, initialExposure * 1.15),
        0.5, 2.0,
      )
    }

    // highlightCompress: only when the user is already in s-curve mode.
    // Conservative per-iteration range [0.75, 1.35] so it can't overshoot in 3 passes.
    if (toneMode === 'scurve') {
      const ratio = stats.highlightFraction / refHighlight
      highlightCompress = clamp(
        highlightCompress * clamp(ratio, 0.75, 1.35),
        0.5, 5.0,
      )
    }
  }

  return { saturation, exposure, highlightCompress }
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
