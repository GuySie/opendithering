import type { DitheringAlgorithm, Palette, ColorSpace } from '../types'
import { rgbToLab, rgbToOklab } from '../processing/colorspace'
import { buildVarianceMap } from './error-diffusion'

type Triple = [number, number, number]

function toSpace(r: number, g: number, b: number, space: ColorSpace): Triple {
  if (space === 'cielab') return rgbToLab(r, g, b)
  if (space === 'oklab') return rgbToOklab(r, g, b)
  return [r, g, b]
}

const WAB2 = 2.25

function spaceDist(p: Triple, c: Triple, space: ColorSpace, weighted = false): number {
  const d0 = p[0] - c[0], d1 = p[1] - c[1], d2 = p[2] - c[2]
  if (space === 'cielab') return 2 * d0 * d0 + d1 * d1 + d2 * d2
  if (space === 'oklab' && weighted) return d0 * d0 + WAB2 * (d1 * d1 + d2 * d2)
  return d0 * d0 + d1 * d1 + d2 * d2
}

export const dizzy: DitheringAlgorithm = {
  id: 'dizzy',
  name: 'Dizzy',
  dither(src: ImageData, palette: Palette, errorSpace: ColorSpace, distSpace: ColorSpace, strength: number, localVariance?: boolean, extraParams?: Record<string, number>): ImageData {
    const diagWeight = Math.max(0, Math.min(1, extraParams?.dizzyDiagonalWeight ?? 0.1))
    const oklabWeighted = !!extraParams?.oklabWeighted
    // [dx, dy, weight]: orthogonal neighbours always weight 1, diagonal weight is configurable
    const DIRS: [number, number, number][] = [
      [-1, 0, 1], [1, 0, 1], [0, -1, 1], [0, 1, 1],
      [-1, -1, diagWeight], [1, -1, diagWeight], [-1, 1, diagWeight], [1, 1, diagWeight],
    ]
    const w = src.width, h = src.height
    const N = w * h

    const errPalette: Triple[] = palette.colors.map(c =>
      toSpace(c.measured[0], c.measured[1], c.measured[2], errorSpace))
    const distPalette: Triple[] = errorSpace === distSpace
      ? errPalette
      : palette.colors.map(c => toSpace(c.measured[0], c.measured[1], c.measured[2], distSpace))

    const errBuf = new Float32Array(N * 3)
    for (let i = 0; i < N; i++) {
      const s = i * 4
      const [e0, e1, e2] = toSpace(src.data[s], src.data[s + 1], src.data[s + 2], errorSpace)
      errBuf[i * 3] = e0; errBuf[i * 3 + 1] = e1; errBuf[i * 3 + 2] = e2
    }

    // Fisher-Yates shuffle
    const order = new Int32Array(N)
    for (let i = 0; i < N; i++) order[i] = i
    for (let i = N - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      const tmp = order[i]; order[i] = order[j]; order[j] = tmp
    }

    const varMap = localVariance ? buildVarianceMap(src) : null

    const processed = new Uint8Array(N)
    const out = new ImageData(w, h)

    for (let oi = 0; oi < N; oi++) {
      const idx = order[oi]
      const x = idx % w, y = (idx / w) | 0
      const bufIdx = idx * 3

      let e0 = errBuf[bufIdx], e1 = errBuf[bufIdx + 1], e2 = errBuf[bufIdx + 2]

      if (errorSpace === 'rgb') {
        e0 = Math.min(255, Math.max(0, e0))
        e1 = Math.min(255, Math.max(0, e1))
        e2 = Math.min(255, Math.max(0, e2))
      } else if (errorSpace === 'oklab') {
        e0 = Math.min(1,    Math.max(0,    e0))
        e1 = Math.min(0.5,  Math.max(-0.5, e1))
        e2 = Math.min(0.5,  Math.max(-0.5, e2))
      } else if (errorSpace === 'cielab') {
        e0 = Math.min(100,  Math.max(0,    e0))
        e1 = Math.min(128,  Math.max(-128, e1))
        e2 = Math.min(128,  Math.max(-128, e2))
      }

      let dp: Triple
      if (errorSpace === distSpace) {
        dp = [e0, e1, e2]
      } else if (errorSpace === 'rgb') {
        dp = toSpace(e0, e1, e2, distSpace)
      } else {
        dp = [e0, e1, e2]
      }

      let bestIdx = 0, bestDist = Infinity
      for (let ci = 0; ci < distPalette.length; ci++) {
        const d = spaceDist(dp, distPalette[ci], distSpace, oklabWeighted)
        if (d < bestDist) { bestDist = d; bestIdx = ci }
      }

      const outIdx = idx * 4
      const [mr, mg, mb] = palette.colors[bestIdx].measured
      out.data[outIdx] = mr; out.data[outIdx + 1] = mg; out.data[outIdx + 2] = mb; out.data[outIdx + 3] = 255

      const effectiveStrength = varMap ? strength * varMap[idx] : strength
      if (effectiveStrength > 0) {
        const ec = errPalette[bestIdx]
        const err0 = (e0 - ec[0]) * effectiveStrength
        const err1 = (e1 - ec[1]) * effectiveStrength
        const err2 = (e2 - ec[2]) * effectiveStrength

        // Accumulate weights of unprocessed neighbors to compute denom
        let denom = 0
        for (const [dx, dy, wt] of DIRS) {
          const nx = x + dx, ny = y + dy
          if (nx >= 0 && nx < w && ny >= 0 && ny < h && !processed[ny * w + nx]) {
            denom += wt
          }
        }

        if (denom > 0) {
          for (const [dx, dy, wt] of DIRS) {
            const nx = x + dx, ny = y + dy
            if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue
            const ni = ny * w + nx
            if (processed[ni]) continue
            const f = wt / denom
            errBuf[ni * 3]     += err0 * f
            errBuf[ni * 3 + 1] += err1 * f
            errBuf[ni * 3 + 2] += err2 * f
          }
        }
      }

      processed[idx] = 1
    }

    return out
  },
}
