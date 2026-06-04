import type { DitheringAlgorithm, Palette, ColorSpace } from '../types'
import { rgbToLab, rgbToOklab } from '../processing/colorspace'
import { buildVarianceMap } from './error-diffusion'

type Triple = [number, number, number]

function toSpace(r: number, g: number, b: number, space: ColorSpace): Triple {
  if (space === 'cielab') return rgbToLab(r, g, b)
  if (space === 'oklab') return rgbToOklab(r, g, b)
  return [r, g, b]
}

function spaceDist(p: Triple, c: Triple, space: ColorSpace): number {
  const d0 = p[0] - c[0], d1 = p[1] - c[1], d2 = p[2] - c[2]
  if (space === 'cielab') return 2 * d0 * d0 + d1 * d1 + d2 * d2
  return d0 * d0 + d1 * d1 + d2 * d2
}

// Convert Hilbert curve index d to (x, y) in an n×n grid (n must be power of 2)
function hilbertD2XY(n: number, d: number): [number, number] {
  let x = 0, y = 0
  for (let s = 1; s < n; s <<= 1) {
    const rx = 1 & (d >> 1)
    const ry = 1 & (d ^ rx)
    if (ry === 0) {
      if (rx === 1) { x = s - 1 - x; y = s - 1 - y }
      const t = x; x = y; y = t
    }
    x += s * rx
    y += s * ry
    d >>= 2
  }
  return [x, y]
}

function buildWeights(queueSize: number): Float32Array {
  const raw = Array.from({ length: queueSize }, (_, i) => Math.pow(queueSize, i / (queueSize - 1)))
  const sum = raw.reduce((a, b) => a + b, 0)
  return new Float32Array(raw.map(w => w / sum))
}

export const riemersma: DitheringAlgorithm = {
  id: 'riemersma',
  name: 'Riemersma',
  dither(src: ImageData, palette: Palette, errorSpace: ColorSpace, distSpace: ColorSpace, strength: number, localVariance?: boolean, extraParams?: Record<string, number>): ImageData {
    const QUEUE_SIZE = Math.max(2, Math.round(extraParams?.riemersmaQueueSize ?? 16))
    const WEIGHTS = buildWeights(QUEUE_SIZE)
    const w = src.width, h = src.height

    const errPalette: Triple[] = palette.colors.map(c =>
      toSpace(c.measured[0], c.measured[1], c.measured[2], errorSpace))
    const distPalette: Triple[] = errorSpace === distSpace
      ? errPalette
      : palette.colors.map(c => toSpace(c.measured[0], c.measured[1], c.measured[2], distSpace))

    const errBuf = new Float32Array(w * h * 3)
    for (let i = 0; i < w * h; i++) {
      const s = i * 4
      const [e0, e1, e2] = toSpace(src.data[s], src.data[s + 1], src.data[s + 2], errorSpace)
      errBuf[i * 3] = e0; errBuf[i * 3 + 1] = e1; errBuf[i * 3 + 2] = e2
    }

    const varMap = localVariance ? buildVarianceMap(src) : null

    const out = new ImageData(w, h)

    // Circular error history queue, 3 channels
    const histE0 = new Float32Array(QUEUE_SIZE)
    const histE1 = new Float32Array(QUEUE_SIZE)
    const histE2 = new Float32Array(QUEUE_SIZE)
    let qHead = 0

    // Smallest power-of-2 grid that covers the image
    let gridSize = 1
    while (gridSize < Math.max(w, h)) gridSize <<= 1

    for (let d = 0; d < gridSize * gridSize; d++) {
      const [px, py] = hilbertD2XY(gridSize, d)
      if (px >= w || py >= h) continue

      const bufIdx = (py * w + px) * 3
      let e0 = errBuf[bufIdx], e1 = errBuf[bufIdx + 1], e2 = errBuf[bufIdx + 2]

      // Accumulate weighted error history: oldest entry uses WEIGHTS[0], newest WEIGHTS[N-1]
      for (let i = 0; i < QUEUE_SIZE; i++) {
        const qi = (qHead + i) % QUEUE_SIZE
        e0 += WEIGHTS[i] * histE0[qi]
        e1 += WEIGHTS[i] * histE1[qi]
        e2 += WEIGHTS[i] * histE2[qi]
      }

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
        const d2 = spaceDist(dp, distPalette[ci], distSpace)
        if (d2 < bestDist) { bestDist = d2; bestIdx = ci }
      }

      const outIdx = (py * w + px) * 4
      const [mr, mg, mb] = palette.colors[bestIdx].measured
      out.data[outIdx] = mr; out.data[outIdx + 1] = mg; out.data[outIdx + 2] = mb; out.data[outIdx + 3] = 255

      // Push quantization error into history queue, replacing oldest entry.
      // Clamp per-channel error to prevent a single bad palette match from
      // dominating the queue and causing chroma oscillation in subsequent pixels.
      const effectiveStrength = varMap ? strength * varMap[py * w + px] : strength
      const ec = errPalette[bestIdx]
      let err0 = (e0 - ec[0]) * effectiveStrength
      let err1 = (e1 - ec[1]) * effectiveStrength
      let err2 = (e2 - ec[2]) * effectiveStrength
      if (errorSpace === 'oklab') {
        err0 = Math.min(0.5,  Math.max(-0.5,  err0))
        err1 = Math.min(0.25, Math.max(-0.25, err1))
        err2 = Math.min(0.25, Math.max(-0.25, err2))
      } else if (errorSpace === 'cielab') {
        err0 = Math.min(50,  Math.max(-50,  err0))
        err1 = Math.min(25,  Math.max(-25,  err1))
        err2 = Math.min(25,  Math.max(-25,  err2))
      }
      histE0[qHead] = err0
      histE1[qHead] = err1
      histE2[qHead] = err2
      qHead = (qHead + 1) % QUEUE_SIZE
    }

    return out
  },
}
