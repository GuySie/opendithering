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
import { srgbToLinear, linearToYyCxCz, linearToXyz } from '../processing/colorspace'

export interface DbsParams {
  viewingDistanceCm: number
  ppi: number
  maxPasses: number
  /** Called after each pass with the number of accepted changes, the current E and the
   *  current palette indices (the live buffer: copy it to keep it). */
  onPass?: (pass: number, accepted: number, E: number, idx: Uint8Array) => void
  /** Use the palette's measured mixing model (if it has one): see dbsRefineMixing. */
  useMixing?: boolean
}

export interface DbsStats {
  passes: number
  acceptedPerPass: number[]
  initialE: number
  finalE: number
  sigmaLum: number
  sigmaChroma: number
  ms: number
  /** True when the palette's measured mixing model was used. */
  mixing?: boolean
}

// Kolpatzik & Bouman exponential CSF decay constants, exp(−α·f) with f in cycles/degree.
// Luminance α derives from Näsänen's model at 11 cd/m²: 1 / (0.525·ln 11 + 3.91) ≈ 0.193.
const ALPHA_LUM = 0.193
const ALPHA_CHROMA = 0.419

function toYyCxCz(r: number, g: number, b: number, out: Float64Array, o: number): void {
  const [y, cx, cz] = linearToYyCxCz(srgbToLinear(r), srgbToLinear(g), srgbToLinear(b))
  out[o] = y; out[o + 1] = cx; out[o + 2] = cz
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
  if (params.useMixing && palette.mixing) return dbsRefineMixing(target, initIdx, palette, params)
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
  // c_pe interleaved per pixel ([Yy, Cx, Cz] at m·3): a trial reads all three channels of a
  // pixel at once, and Cx/Cz share the chroma kernel, so one sweep updates both.
  const cpe = new Float64Array(N * 3)
  let E = 0
  for (let ch = 0; ch < 3; ch++) {
    const c = correlate(errs[ch], w, h, models[ch].q, models[ch].radius)
    const e = errs[ch]
    for (let i = 0; i < N; i++) { cpe[i * 3 + ch] = c[i]; E += e[i] * c[i] }
  }
  const initialE = E

  // Swap constant per channel and neighbour direction: c_pp(0) − c_pp(dx, dy)
  const swapConst = models.map((m, ch) => NEIGHBOURS.map(([dx, dy]) =>
    q0[ch] - m.q[m.radius + dx] * m.q[m.radius + dy]))

  // Add a·c_pp(· − m) into the luminance channel of c_pe, clipped to the image.
  // Walks each kernel row with running indices instead of recomputing them per element.
  const qL = lum.q, rL = lum.radius
  const addLum = (mx: number, my: number, a: number) => {
    if (a === 0) return
    const y0 = Math.max(0, my - rL), y1 = Math.min(h - 1, my + rL)
    const x0 = Math.max(0, mx - rL), x1 = Math.min(w - 1, mx + rL)
    const qx0 = rL + x0 - mx
    for (let y = y0; y <= y1; y++) {
      const fy = a * qL[rL + y - my]
      let ci = (y * w + x0) * 3
      for (let qi = qx0, qEnd = qx0 + x1 - x0; qi <= qEnd; qi++, ci += 3) cpe[ci] += fy * qL[qi]
    }
  }

  // Add a1·c_pp(· − m) and a2·c_pp(· − m) into both chrominance channels in one sweep.
  const qC = chroma.q, rC = chroma.radius
  const addChroma = (mx: number, my: number, a1: number, a2: number) => {
    if (a1 === 0 && a2 === 0) return
    const y0 = Math.max(0, my - rC), y1 = Math.min(h - 1, my + rC)
    const x0 = Math.max(0, mx - rC), x1 = Math.min(w - 1, mx + rC)
    const qx0 = rC + x0 - mx
    for (let y = y0; y <= y1; y++) {
      const qy = qC[rC + y - my]
      const f1 = a1 * qy, f2 = a2 * qy
      let ci = (y * w + x0) * 3 + 1
      for (let qi = qx0, qEnd = qx0 + x1 - x0; qi <= qEnd; qi++, ci += 3) {
        const qv = qC[qi]
        cpe[ci] += f1 * qv
        cpe[ci + 1] += f2 * qv
      }
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
        const c0 = cpe[m * 3], c1 = cpe[m * 3 + 1], c2 = cpe[m * 3 + 2]

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
            2 * a0 * a0 * swapConst[0][d] + 2 * a0 * (c0 - cpe[n * 3]) +
            2 * a1 * a1 * swapConst[1][d] + 2 * a1 * (c1 - cpe[n * 3 + 1]) +
            2 * a2 * a2 * swapConst[2][d] + 2 * a2 * (c2 - cpe[n * 3 + 2])
          if (dE < bestDE) { bestDE = dE; bestKind = 2; bestN = n; bestDir = d }
        }

        if (bestKind === 0) continue
        accepted++
        E += bestDE

        if (bestKind === 1) {
          const pj = bestJ * 3
          addLum(x, y, P[pj] - P[pk])
          addChroma(x, y, P[pj + 1] - P[pk + 1], P[pj + 2] - P[pk + 2])
          idx[m] = bestJ
        } else {
          const kn = idx[bestN]
          const pn = kn * 3
          const nx = x + NEIGHBOURS[bestDir][0], ny = y + NEIGHBOURS[bestDir][1]
          const a0 = P[pn] - P[pk], a1 = P[pn + 1] - P[pk + 1], a2 = P[pn + 2] - P[pk + 2]
          addLum(x, y, a0)
          addLum(nx, ny, -a0)
          addChroma(x, y, a1, a2)
          addChroma(nx, ny, -a1, -a2)
          idx[m] = kn
          idx[bestN] = k
        }
      }
    }
    acceptedPerPass.push(accepted)
    params.onPass?.(pass + 1, accepted, E, idx)
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

// --- DBS with the panel's measured mixing model ---
// Linear mixing (the path above) assumes a pixel looks like its ink whatever surrounds it. Measured on a real
// Spectra 6 panel it doesn't: a pixel's XYZ light is multiplied by exp(−k) for every directly adjacent pixel of
// a different ink, with k specific to the ink pair and channel (Palette.mixing; CLAUDE.md "Panel mixing
// measurements"). So a pixel's *effective* colour depends on its ink and its 4 neighbours' inks: precomputed for
// every combination (6⁵ for Spectra 6) as YyCxCz. The error is effective colour − target. Changing one pixel
// changes the effective colour of itself and its 4 neighbours (a swap: up to 8 pixels), so a trial's
// ΔE = Σ_ch [ Σ_i 2·a_i·c_pe(i) + Σ_i Σ_j a_i·a_j·c_pp(i−j) ] over that small set, a_i being the change in
// pixel i's effective colour. The pairwise c_pp terms are fixed per set geometry and precomputed.

const N4: [number, number][] = [[0, -1], [0, 1], [-1, 0], [1, 0]]  // up, down, left, right

/** YyCxCz of a pixel of ink a with neighbours u, d, l, r (a missing neighbour counts as ink a), flat: index ((((a·K+u)·K+d)·K+l)·K+r)·3. */
export function buildMixingLut(palette: Palette): Float64Array {
  const K = palette.colors.length
  const xyz = palette.colors.map(c => linearToXyz(srgbToLinear(c.measured[0]), srgbToLinear(c.measured[1]), srgbToLinear(c.measured[2])))
  const att = new Float64Array(K * K * 3).fill(1)
  const byName = new Map(palette.colors.map((c, i) => [c.name, i]))
  for (const [pair, k] of Object.entries(palette.mixing!.neighbourAttenuation)) {
    const [a, b] = pair.split('/').map(n => byName.get(n))
    if (a === undefined || b === undefined) continue
    for (let ch = 0; ch < 3; ch++) att[(a * K + b) * 3 + ch] = att[(b * K + a) * 3 + ch] = Math.exp(-k[ch])
  }
  const lut = new Float64Array(K ** 5 * 3)
  for (let a = 0; a < K; a++) for (let u = 0; u < K; u++) for (let d = 0; d < K; d++) for (let l = 0; l < K; l++) for (let r = 0; r < K; r++) {
    const f = [0, 1, 2].map(ch => att[(a * K + u) * 3 + ch] * att[(a * K + d) * 3 + ch] * att[(a * K + l) * 3 + ch] * att[(a * K + r) * 3 + ch])
    const X = xyz[a][0] * f[0], Y = xyz[a][1] * f[1], Z = xyz[a][2] * f[2]
    const o = ((((a * K + u) * K + d) * K + l) * K + r) * 3
    lut[o] = 116 * Y; lut[o + 1] = 500 * (X / D65_X - Y); lut[o + 2] = 200 * (Y - Z / D65_Z)
  }
  return lut
}
const D65_X = 0.95047, D65_Z = 1.08883

function dbsRefineMixing(target: ImageData, initIdx: Uint8Array, palette: Palette, params: DbsParams): { idx: Uint8Array; stats: DbsStats } {
  const t0 = performance.now()
  const w = target.width, h = target.height, N = w * h
  const K = palette.colors.length
  const idx = new Uint8Array(initIdx)
  const lut = buildMixingLut(palette)

  const g = new Float64Array(N * 3)
  for (let i = 0; i < N; i++) toYyCxCz(target.data[i * 4], target.data[i * 4 + 1], target.data[i * 4 + 2], g, i * 3)

  const sigmaLum = eyeSigmaPx(ALPHA_LUM, params.viewingDistanceCm, params.ppi)
  const sigmaChroma = eyeSigmaPx(ALPHA_CHROMA, params.viewingDistanceCm, params.ppi)
  const lum = gaussianAutocorr(sigmaLum)
  const chroma = gaussianAutocorr(sigmaChroma)
  const models: ChannelModel[] = [lum, chroma, chroma]
  const cpp = (ch: number, dx: number, dy: number): number => {
    const { q, radius } = models[ch]
    return Math.abs(dx) > radius || Math.abs(dy) > radius ? 0 : q[radius + dx] * q[radius + dy]
  }

  // lut offset of pixel (x, y) under the current idx
  const codeAt = (x: number, y: number): number => {
    const p = y * w + x, a = idx[p]
    const u = y > 0 ? idx[p - w] : a, d = y < h - 1 ? idx[p + w] : a
    const l = x > 0 ? idx[p - 1] : a, r = x < w - 1 ? idx[p + 1] : a
    return ((((a * K + u) * K + d) * K + l) * K + r) * 3
  }

  const eff = new Float64Array(N * 3)
  const effectiveAll = (): void => {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const o = codeAt(x, y), p = (y * w + x) * 3
      eff[p] = lut[o]; eff[p + 1] = lut[o + 1]; eff[p + 2] = lut[o + 2]
    }
  }
  const errorsFromEff = (): Float64Array[] => {
    const errs = [new Float64Array(N), new Float64Array(N), new Float64Array(N)]
    for (let i = 0; i < N; i++) for (let ch = 0; ch < 3; ch++) errs[ch][i] = eff[i * 3 + ch] - g[i * 3 + ch]
    return errs
  }
  effectiveAll()
  const errs = errorsFromEff()
  const cpe = new Float64Array(N * 3)
  let E = 0
  for (let ch = 0; ch < 3; ch++) {
    const c = correlate(errs[ch], w, h, models[ch].q, models[ch].radius)
    const e = errs[ch]
    for (let i = 0; i < N; i++) { cpe[i * 3 + ch] = c[i]; E += e[i] * c[i] }
  }
  const initialE = E

  const qL = lum.q, rL = lum.radius, qC = chroma.q, rC = chroma.radius
  const addLum = (mx: number, my: number, a: number) => {
    if (a === 0) return
    const y0 = Math.max(0, my - rL), y1 = Math.min(h - 1, my + rL), x0 = Math.max(0, mx - rL), x1 = Math.min(w - 1, mx + rL)
    const qx0 = rL + x0 - mx
    for (let y = y0; y <= y1; y++) {
      const fy = a * qL[rL + y - my]
      let ci = (y * w + x0) * 3
      for (let qi = qx0, qEnd = qx0 + x1 - x0; qi <= qEnd; qi++, ci += 3) cpe[ci] += fy * qL[qi]
    }
  }
  const addChroma = (mx: number, my: number, a1: number, a2: number) => {
    if (a1 === 0 && a2 === 0) return
    const y0 = Math.max(0, my - rC), y1 = Math.min(h - 1, my + rC), x0 = Math.max(0, mx - rC), x1 = Math.min(w - 1, mx + rC)
    const qx0 = rC + x0 - mx
    for (let y = y0; y <= y1; y++) {
      const qy = qC[rC + y - my], f1 = a1 * qy, f2 = a2 * qy
      let ci = (y * w + x0) * 3 + 1
      for (let qi = qx0, qEnd = qx0 + x1 - x0; qi <= qEnd; qi++, ci += 3) { const qv = qC[qi]; cpe[ci] += f1 * qv; cpe[ci + 1] += f2 * qv }
    }
  }

  // Affected-set geometries (offsets from the visited pixel m) and their pairwise c_pp, per channel.
  interface Geometry { dx: Int8Array; dy: Int8Array; C: Float64Array[] }
  const makeGeometry = (offs: [number, number][]): Geometry => {
    const n = offs.length
    const C = [0, 1, 2].map(ch => {
      const c = new Float64Array(n * n)
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) c[i * n + j] = cpp(ch, offs[i][0] - offs[j][0], offs[i][1] - offs[j][1])
      return c
    })
    return { dx: Int8Array.from(offs.map(o => o[0])), dy: Int8Array.from(offs.map(o => o[1])), C }
  }
  const toggleGeom = makeGeometry([[0, 0], ...N4])
  const swapGeoms = NEIGHBOURS.map(([sx, sy]) => {
    const set: [number, number][] = [[0, 0], [sx, sy]]
    for (const [bx, by] of [[0, 0], [sx, sy]]) for (const [ox, oy] of N4) {
      const o: [number, number] = [bx + ox, by + oy]
      if (!set.some(s => s[0] === o[0] && s[1] === o[1])) set.push(o)
    }
    return makeGeometry(set)
  })

  // Scratch for one trial: per affected slot, the pixel index (−1 = outside the image) and the change a.
  const MAXS = 10
  const sp = new Int32Array(MAXS), sa = new Float64Array(MAXS * 3)
  /** ΔE of the trial already written into idx, over geometry G around (x, y); fills sp/sa. */
  const trialDE = (G: Geometry, x: number, y: number): number => {
    const n = G.dx.length
    let dE = 0
    for (let i = 0; i < n; i++) {
      const px = x + G.dx[i], py = y + G.dy[i]
      if (px < 0 || px >= w || py < 0 || py >= h) { sp[i] = -1; sa[i * 3] = sa[i * 3 + 1] = sa[i * 3 + 2] = 0; continue }
      const p = py * w + px, o = codeAt(px, py)
      sp[i] = p
      for (let ch = 0; ch < 3; ch++) {
        const a = lut[o + ch] - eff[p * 3 + ch]
        sa[i * 3 + ch] = a
        dE += 2 * a * cpe[p * 3 + ch]
      }
    }
    for (let ch = 0; ch < 3; ch++) {
      const C = G.C[ch]
      for (let i = 0; i < n; i++) {
        const ai = sa[i * 3 + ch]
        if (ai === 0) continue
        let s = 0
        for (let j = 0; j < n; j++) s += C[i * n + j] * sa[j * 3 + ch]
        dE += ai * s
      }
    }
    return dE
  }
  const commit = (G: Geometry): void => {
    for (let i = 0; i < G.dx.length; i++) {
      const p = sp[i]
      if (p < 0) continue
      const a0 = sa[i * 3], a1 = sa[i * 3 + 1], a2 = sa[i * 3 + 2]
      if (a0 === 0 && a1 === 0 && a2 === 0) continue
      const px = p % w, py = (p - px) / w
      addLum(px, py, a0); addChroma(px, py, a1, a2)
      eff[p * 3] += a0; eff[p * 3 + 1] += a1; eff[p * 3 + 2] += a2
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
        let bestDE = -EPS, bestKind = 0, bestJ = 0, bestD = 0
        for (let j = 0; j < K; j++) {
          if (j === k) continue
          idx[m] = j
          const dE = trialDE(toggleGeom, x, y)
          if (dE < bestDE) { bestDE = dE; bestKind = 1; bestJ = j }
        }
        idx[m] = k
        for (let d = 0; d < 8; d++) {
          const nx = x + NEIGHBOURS[d][0], ny = y + NEIGHBOURS[d][1]
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue
          const n = ny * w + nx, kn = idx[n]
          if (kn === k) continue
          idx[m] = kn; idx[n] = k
          const dE = trialDE(swapGeoms[d], x, y)
          idx[m] = k; idx[n] = kn
          if (dE < bestDE) { bestDE = dE; bestKind = 2; bestD = d }
        }
        if (bestKind === 0) continue
        accepted++
        E += bestDE
        if (bestKind === 1) {
          idx[m] = bestJ
          trialDE(toggleGeom, x, y); commit(toggleGeom)
        } else {
          const n = (y + NEIGHBOURS[bestD][1]) * w + x + NEIGHBOURS[bestD][0], kn = idx[n]
          idx[m] = kn; idx[n] = k
          trialDE(swapGeoms[bestD], x, y); commit(swapGeoms[bestD])
        }
      }
    }
    acceptedPerPass.push(accepted)
    params.onPass?.(pass + 1, accepted, E, idx)
    if (accepted === 0) break
  }

  // Recompute E from scratch (also catches drift in the incremental bookkeeping)
  effectiveAll()
  const finalE = totalError(errorsFromEff(), models, w, h)
  return {
    idx,
    stats: { passes: acceptedPerPass.length, acceptedPerPass, initialE, finalE, sigmaLum, sigmaChroma, ms: performance.now() - t0, mixing: true },
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
