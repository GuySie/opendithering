// Colour Direct Binary Search (DBS) — iterative refinement of an existing dithered image.
//
// Minimises perceived error E = Σ_ch Σ_m ((p_ch ∗ e_ch)(m))², where e = halftone − target in
// YyCxCz (a linear transform of XYZ, so the eye-model blur averages light correctly) and
// p_ch is a per-channel Gaussian eye model: narrow for luminance, wider for chrominance.
// Each pass visits every pixel in raster order and tries toggling it to every other palette
// colour and swapping it with each differing 8-neighbour, accepting the change with the
// largest decrease in E. ΔE for a trial is O(1) via the cached correlation c_pe = c_pp ∗ e.
//
// References: Analoui & Allebach (1992); Lieberman & Allebach (1997); Agar & Allebach (2005);
// Flohr, Kolpatzik & Allebach (YyCxCz); Kolpatzik & Bouman (1992, luminance/chrominance CSFs).
//
// Pure module (no DOM beyond ImageData) so it can run in a Web Worker and in the Node benchmark.

import type { Palette } from '../types'
import { srgbToLinear, linearToXyz } from '../processing/colorspace'

export interface DbsParams {
  viewingDistanceCm: number
  ppi: number
  maxPasses: number
  /** Called after each pass with the number of accepted changes and the current E. */
  onPass?: (pass: number, accepted: number, E: number) => void
}

export interface DbsStats {
  passes: number
  acceptedPerPass: number[]
  initialE: number
  finalE: number
  sigmaLum: number
  sigmaChroma: number
  ms: number
}

// Kolpatzik & Bouman exponential CSF decay constants, exp(−α·f) with f in cycles/degree.
// Luminance α derives from Näsänen's model at 11 cd/m²: 1 / (0.525·ln 11 + 3.91) ≈ 0.193.
const ALPHA_LUM = 0.193
const ALPHA_CHROMA = 0.419

// D65 white (matches colorspace.ts)
const XN = 0.95047, ZN = 1.08883

function toYyCxCz(r: number, g: number, b: number, out: Float64Array, o: number): void {
  const [X, Y, Z] = linearToXyz(srgbToLinear(r), srgbToLinear(g), srgbToLinear(b))
  out[o]     = 116 * Y
  out[o + 1] = 500 * (X / XN - Y)
  out[o + 2] = 200 * (Y - Z / ZN)
}

/** Eye-model Gaussian σ in pixels for a CSF decay constant at the given viewing geometry. */
export function eyeSigmaPx(alpha: number, viewingDistanceCm: number, ppi: number): number {
  const pixelDeg = (180 / Math.PI) * (2.54 / ppi) / viewingDistanceCm
  return (alpha / (2 * Math.PI)) / pixelDeg
}

/**
 * 1-D autocorrelation of a normalised, sampled Gaussian of the given σ.
 * Returns q with q[radius + d] = Σ_i k[i]·k[i+d] for d ∈ [−radius, radius] (radius = 2·ceil(3σ)).
 * The 2-D c_pp is separable: c_pp(dx, dy) = q[dx]·q[dy].
 */
function gaussianAutocorr(sigma: number): { q: Float64Array; radius: number } {
  const r = Math.max(1, Math.ceil(3 * sigma))
  const k = new Float64Array(2 * r + 1)
  let sum = 0
  for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); sum += k[i + r] }
  for (let i = 0; i < k.length; i++) k[i] /= sum

  const radius = 2 * r
  const q = new Float64Array(2 * radius + 1)
  for (let d = -radius; d <= radius; d++) {
    let s = 0
    for (let i = 0; i < k.length; i++) {
      const j = i + d
      if (j >= 0 && j < k.length) s += k[i] * k[j]
    }
    q[d + radius] = s
  }
  return { q, radius }
}

/** c = c_pp ∗ e for one channel, via two separable 1-D passes. Outside the image e is 0. */
function correlate(e: Float64Array, w: number, h: number, q: Float64Array, radius: number): Float64Array {
  const tmp = new Float64Array(w * h)
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) {
      let s = 0
      const lo = Math.max(-radius, -x), hi = Math.min(radius, w - 1 - x)
      for (let d = lo; d <= hi; d++) s += q[d + radius] * e[row + x + d]
      tmp[row + x] = s
    }
  }
  const out = new Float64Array(w * h)
  for (let y = 0; y < h; y++) {
    const lo = Math.max(-radius, -y), hi = Math.min(radius, h - 1 - y)
    for (let x = 0; x < w; x++) {
      let s = 0
      for (let d = lo; d <= hi; d++) s += q[d + radius] * tmp[(y + d) * w + x]
      out[y * w + x] = s
    }
  }
  return out
}

interface ChannelModel { q: Float64Array; radius: number }

/** E = Σ_ch ⟨e_ch, c_pp,ch ∗ e_ch⟩, computed from scratch. */
function totalError(errs: Float64Array[], models: ChannelModel[], w: number, h: number): number {
  let E = 0
  for (let ch = 0; ch < 3; ch++) {
    const c = correlate(errs[ch], w, h, models[ch].q, models[ch].radius)
    const e = errs[ch]
    for (let i = 0; i < e.length; i++) E += e[i] * c[i]
  }
  return E
}

const NEIGHBOURS: [number, number][] = [
  [-1, -1], [0, -1], [1, -1],
  [-1,  0],          [1,  0],
  [-1,  1], [0,  1], [1,  1],
]

export function dbsRefine(
  target: ImageData,
  initIdx: Uint8Array,
  palette: Palette,
  params: DbsParams,
): { idx: Uint8Array; stats: DbsStats } {
  const t0 = performance.now()
  const w = target.width, h = target.height, N = w * h
  const K = palette.colors.length
  const idx = new Uint8Array(initIdx)

  // Palette and target in YyCxCz
  const P = new Float64Array(K * 3)
  palette.colors.forEach((c, i) => toYyCxCz(c.measured[0], c.measured[1], c.measured[2], P, i * 3))
  const g = new Float64Array(N * 3)
  for (let i = 0; i < N; i++) toYyCxCz(target.data[i * 4], target.data[i * 4 + 1], target.data[i * 4 + 2], g, i * 3)

  // Eye model: channel 0 = luminance (Yy), channels 1–2 = chrominance (Cx, Cz)
  const sigmaLum = eyeSigmaPx(ALPHA_LUM, params.viewingDistanceCm, params.ppi)
  const sigmaChroma = eyeSigmaPx(ALPHA_CHROMA, params.viewingDistanceCm, params.ppi)
  const lum = gaussianAutocorr(sigmaLum)
  const chroma = gaussianAutocorr(sigmaChroma)
  const models: ChannelModel[] = [lum, chroma, chroma]
  const q0 = models.map(m => m.q[m.radius] * m.q[m.radius]) // c_pp(0, 0) per channel

  // Error and correlation buffers per channel
  const buildErr = (): Float64Array[] => {
    const errs = [new Float64Array(N), new Float64Array(N), new Float64Array(N)]
    for (let i = 0; i < N; i++) {
      const p = idx[i] * 3
      errs[0][i] = P[p] - g[i * 3]
      errs[1][i] = P[p + 1] - g[i * 3 + 1]
      errs[2][i] = P[p + 2] - g[i * 3 + 2]
    }
    return errs
  }
  const errs = buildErr()
  const cpe = errs.map((e, ch) => correlate(e, w, h, models[ch].q, models[ch].radius))
  let E = 0
  for (let ch = 0; ch < 3; ch++) for (let i = 0; i < N; i++) E += errs[ch][i] * cpe[ch][i]
  const initialE = E

  // Swap constant per channel and neighbour direction: c_pp(0) − c_pp(dx, dy)
  const swapConst = models.map((m, ch) => NEIGHBOURS.map(([dx, dy]) =>
    q0[ch] - m.q[m.radius + dx] * m.q[m.radius + dy]))

  // Add a·c_pp(· − m) into c_pe for one channel, clipped to the image.
  const addKernel = (ch: number, mx: number, my: number, a: number) => {
    if (a === 0) return
    const { q, radius } = models[ch]
    const c = cpe[ch]
    const y0 = Math.max(0, my - radius), y1 = Math.min(h - 1, my + radius)
    const x0 = Math.max(0, mx - radius), x1 = Math.min(w - 1, mx + radius)
    for (let y = y0; y <= y1; y++) {
      const fy = a * q[radius + y - my]
      const row = y * w
      for (let x = x0; x <= x1; x++) c[row + x] += fy * q[radius + x - mx]
    }
  }

  const acceptedPerPass: number[] = []
  const EPS = 1e-9

  for (let pass = 0; pass < params.maxPasses; pass++) {
    let accepted = 0
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const m = y * w + x
        const k = idx[m]
        const pk = k * 3
        const c0 = cpe[0][m], c1 = cpe[1][m], c2 = cpe[2][m]

        let bestDE = -EPS, bestKind = 0, bestJ = 0, bestN = 0, bestDir = 0

        // Toggles
        for (let j = 0; j < K; j++) {
          if (j === k) continue
          const pj = j * 3
          const a0 = P[pj] - P[pk], a1 = P[pj + 1] - P[pk + 1], a2 = P[pj + 2] - P[pk + 2]
          const dE = q0[0] * a0 * a0 + q0[1] * a1 * a1 + q0[2] * a2 * a2
            + 2 * (a0 * c0 + a1 * c1 + a2 * c2)
          if (dE < bestDE) { bestDE = dE; bestKind = 1; bestJ = j }
        }

        // Swaps with differing 8-neighbours
        for (let d = 0; d < 8; d++) {
          const nx = x + NEIGHBOURS[d][0], ny = y + NEIGHBOURS[d][1]
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue
          const n = ny * w + nx
          const kn = idx[n]
          if (kn === k) continue
          const pn = kn * 3
          const a0 = P[pn] - P[pk], a1 = P[pn + 1] - P[pk + 1], a2 = P[pn + 2] - P[pk + 2]
          const dE =
            2 * a0 * a0 * swapConst[0][d] + 2 * a0 * (c0 - cpe[0][n]) +
            2 * a1 * a1 * swapConst[1][d] + 2 * a1 * (c1 - cpe[1][n]) +
            2 * a2 * a2 * swapConst[2][d] + 2 * a2 * (c2 - cpe[2][n])
          if (dE < bestDE) { bestDE = dE; bestKind = 2; bestN = n; bestDir = d }
        }

        if (bestKind === 0) continue
        accepted++
        E += bestDE

        if (bestKind === 1) {
          const pj = bestJ * 3
          for (let ch = 0; ch < 3; ch++) addKernel(ch, x, y, P[pj + ch] - P[pk + ch])
          idx[m] = bestJ
        } else {
          const kn = idx[bestN]
          const pn = kn * 3
          const nx = x + NEIGHBOURS[bestDir][0], ny = y + NEIGHBOURS[bestDir][1]
          for (let ch = 0; ch < 3; ch++) {
            const a = P[pn + ch] - P[pk + ch]
            addKernel(ch, x, y, a)
            addKernel(ch, nx, ny, -a)
          }
          idx[m] = kn
          idx[bestN] = k
        }
      }
    }
    acceptedPerPass.push(accepted)
    params.onPass?.(pass + 1, accepted, E)
    if (accepted === 0) break
  }

  // Recompute E from scratch rather than trusting the running sum (also catches drift bugs)
  const finalE = totalError(buildErr(), models, w, h)

  return {
    idx,
    stats: {
      passes: acceptedPerPass.length,
      acceptedPerPass,
      initialE,
      finalE,
      sigmaLum,
      sigmaChroma,
      ms: performance.now() - t0,
    },
  }
}

/** Map each pixel of a measured-colour dithered image back to its palette index. */
export function indicesFromMeasured(img: ImageData, palette: Palette): Uint8Array {
  const map = new Map<number, number>()
  palette.colors.forEach((c, i) => map.set((c.measured[0] << 16) | (c.measured[1] << 8) | c.measured[2], i))
  const N = img.width * img.height
  const out = new Uint8Array(N)
  for (let i = 0; i < N; i++) {
    const r = img.data[i * 4], g = img.data[i * 4 + 1], b = img.data[i * 4 + 2]
    const hit = map.get((r << 16) | (g << 8) | b)
    if (hit !== undefined) { out[i] = hit; continue }
    // Not an exact palette colour (shouldn't happen for pipeline output) — fall back to nearest
    let best = 0, bestD = Infinity
    palette.colors.forEach((c, j) => {
      const dr = r - c.measured[0], dg = g - c.measured[1], db = b - c.measured[2]
      const d = dr * dr + dg * dg + db * db
      if (d < bestD) { bestD = d; best = j }
    })
    out[i] = best
  }
  return out
}

/** Render palette indices as a measured-colour ImageData. */
export function measuredFromIndices(idx: Uint8Array, width: number, height: number, palette: Palette): ImageData {
  const out = new ImageData(width, height)
  for (let i = 0; i < idx.length; i++) {
    const [r, g, b] = palette.colors[idx[i]].measured
    out.data[i * 4] = r; out.data[i * 4 + 1] = g; out.data[i * 4 + 2] = b; out.data[i * 4 + 3] = 255
  }
  return out
}
