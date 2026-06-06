import type { DitheringAlgorithm, Palette, ColorSpace } from '../types'
import { deltaE_rgb, deltaE_lab, deltaE_oklab, rgbToOklab, rec709Luminance } from '../processing/colorspace'

const BAYER8: number[][] = [
  [ 0, 32,  8, 40,  2, 34, 10, 42],
  [48, 16, 56, 24, 50, 18, 58, 26],
  [12, 44,  4, 36, 14, 46,  6, 38],
  [60, 28, 52, 20, 62, 30, 54, 22],
  [ 3, 35, 11, 43,  1, 33,  9, 41],
  [51, 19, 59, 27, 49, 17, 57, 25],
  [15, 47,  7, 39, 13, 45,  5, 37],
  [63, 31, 55, 23, 61, 29, 53, 21],
]

const WAB2 = 2.25

function deltaE(
  r1: number, g1: number, b1: number,
  r2: number, g2: number, b2: number,
  space: ColorSpace,
  weighted = false,
): number {
  if (space === 'cielab') return deltaE_lab(r1, g1, b1, r2, g2, b2)
  if (space === 'oklab') {
    if (!weighted) return deltaE_oklab(r1, g1, b1, r2, g2, b2)
    const [oL1, oa1, ob1] = rgbToOklab(r1, g1, b1)
    const [oL2, oa2, ob2] = rgbToOklab(r2, g2, b2)
    const dL = oL1 - oL2, da = oa1 - oa2, db = ob1 - ob2
    return dL * dL + WAB2 * (da * da + db * db)
  }
  return deltaE_rgb(r1, g1, b1, r2, g2, b2)
}

function buildCandidateList(
  tr: number, tg: number, tb: number,
  palette: Palette,
  distSpace: ColorSpace,
  oklabWeighted = false,
): number[] {
  const colors = palette.colors
  const n = colors.length
  let sumR = 0, sumG = 0, sumB = 0
  const list: number[] = []

  for (let i = 0; i < 64; i++) {
    let best = 0
    let bestDist = Infinity
    const denom = i + 1

    for (let p = 0; p < n; p++) {
      const [mr, mg, mb] = colors[p].measured
      const avgR = (sumR + mr) / denom
      const avgG = (sumG + mg) / denom
      const avgB = (sumB + mb) / denom
      const d = deltaE(tr, tg, tb, avgR, avgG, avgB, distSpace, oklabWeighted)
      if (d < bestDist) { bestDist = d; best = p }
    }

    list.push(best)
    const [mr, mg, mb] = colors[best].measured
    sumR += mr; sumG += mg; sumB += mb
  }

  // Sort darkest→brightest so the Bayer thresholds produce a smooth luminance ramp
  list.sort((a, b) => {
    const [ar, ag, ab2] = colors[a].measured
    const [br, bg, bb] = colors[b].measured
    return rec709Luminance(ar, ag, ab2) - rec709Luminance(br, bg, bb)
  })

  return list
}

function ign(x: number, y: number): number {
  return (52.9829189 * ((0.06711056 * x + 0.00583715 * y) % 1)) % 1
}

function yliluoma2Dither(src: ImageData, palette: Palette, distSpace: ColorSpace, oklabWeighted = false): ImageData {
  const { width: w, height: h } = src
  const out = new ImageData(w, h)
  const cache = new Map<string, number[]>()

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4
      const r = src.data[idx]
      const g = src.data[idx + 1]
      const b = src.data[idx + 2]

      const key = `${r >> 2},${g >> 2},${b >> 2}`
      let candidates = cache.get(key)
      if (!candidates) {
        candidates = buildCandidateList(r, g, b, palette, distSpace, oklabWeighted)
        cache.set(key, candidates)
      }

      const chosen = candidates[BAYER8[y % 8][x % 8]]
      const [mr, mg, mb] = palette.colors[chosen].measured
      out.data[idx]     = mr
      out.data[idx + 1] = mg
      out.data[idx + 2] = mb
      out.data[idx + 3] = 255
    }
  }

  return out
}

function yliluoma2BlueNoiseDither(src: ImageData, palette: Palette, distSpace: ColorSpace, oklabWeighted = false): ImageData {
  const { width: w, height: h } = src
  const out = new ImageData(w, h)
  const cache = new Map<string, number[]>()

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4
      const r = src.data[idx]
      const g = src.data[idx + 1]
      const b = src.data[idx + 2]

      const key = `${r >> 2},${g >> 2},${b >> 2}`
      let candidates = cache.get(key)
      if (!candidates) {
        candidates = buildCandidateList(r, g, b, palette, distSpace, oklabWeighted)
        cache.set(key, candidates)
      }

      const chosen = candidates[Math.floor(ign(x, y) * 64)]
      const [mr, mg, mb] = palette.colors[chosen].measured
      out.data[idx]     = mr
      out.data[idx + 1] = mg
      out.data[idx + 2] = mb
      out.data[idx + 3] = 255
    }
  }

  return out
}

export const yliluoma2: DitheringAlgorithm = {
  id: 'yliluoma2',
  name: 'Yliluoma 2',
  dither(src, palette, _errorSpace, distSpace, _strength, _localVariance, extraParams) {
    return yliluoma2Dither(src, palette, distSpace, !!extraParams?.oklabWeighted)
  },
}

export const yliluoma2BlueNoise: DitheringAlgorithm = {
  id: 'yliluoma2-blue-noise',
  name: 'Yliluoma 2 + Blue Noise',
  dither(src, palette, _errorSpace, distSpace, _strength, _localVariance, extraParams) {
    return yliluoma2BlueNoiseDither(src, palette, distSpace, !!extraParams?.oklabWeighted)
  },
}
