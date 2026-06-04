import type { PipelineInput } from './pipeline'
import { runPipeline } from './pipeline'
import { resizeImage } from './resize'
import { rgbToOklab } from './colorspace'

export function autoTune(
  input: PipelineInput,
  initialSaturation: number,
  initialExposure: number,
  iterations = 3,
): { saturation: number; exposure: number } {
  const { source, srcWidth, srcHeight, dstWidth, dstHeight, resizeMode } = input
  const reference = resizeImage(source, srcWidth, srcHeight, dstWidth, dstHeight, resizeMode)
  const refStats = imageStats(reference)

  let saturation = initialSaturation
  let exposure = initialExposure

  for (let i = 0; i < iterations; i++) {
    const result = runPipeline({ ...input, settings: { ...input.settings, saturation, exposure } })
    const previewStats = imageStats(result.measured)

    if (previewStats.meanL > 0.001) {
      exposure = clamp(exposure * (refStats.meanL / previewStats.meanL), 0.5, 2.0)
    }
    if (previewStats.meanC > 0.001) {
      saturation = clamp(saturation * (refStats.meanC / previewStats.meanC), 0.0, 2.0)
    }
  }

  return { saturation, exposure }
}

function imageStats(img: ImageData): { meanL: number; meanC: number } {
  const data = img.data
  const n = data.length / 4
  let sumL = 0
  let sumC = 0
  for (let i = 0; i < data.length; i += 4) {
    const [L, a, b] = rgbToOklab(data[i], data[i + 1], data[i + 2])
    sumL += L
    sumC += Math.sqrt(a * a + b * b)
  }
  return { meanL: sumL / n, meanC: sumC / n }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}
