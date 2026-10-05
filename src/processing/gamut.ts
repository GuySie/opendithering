// Gamut mapping: pull target colours inside the colour range the panel can actually show.
//
// Viewed from a distance the eye averages neighbouring pixels as light, so the colours a panel
// can reproduce on average are all mixes of its measured palette colours — the convex hull of
// the measured colours in linear RGB. Any target inside the hull can be matched exactly by some
// proportion of palette colours; anything outside can't be matched by any dot arrangement.
// Dithering such colours leaves irreducible error, which error diffusion smears forward and DBS
// pushes across edges as halos. Mapping every out-of-gamut colour to the hull boundary first
// removes that leftover error.
//
// Method: for an out-of-gamut colour p, pick an anchor on the panel's own neutral axis (the line
// between its measured black and white) and move from the anchor towards p along a straight line
// in OKLab (constant hue), keeping the furthest point still inside the hull (bisection). The
// anchor's lightness sets the trade-off: balance 0 = same lightness as p (keep lightness, lose
// saturation); balance 1 = the panel's mid lightness (keep more saturation, lose lightness).
//
// Palettes whose hull is flat (fewer than 4 non-coplanar colours: BW, BWR, grayscale) are left
// unchanged — lightness is already handled by dynamic range compression there.

import type { Palette } from '../types'
import { srgbToLinear, linearToSrgb, linearToOklab, oklabToLinear } from './colorspace'

type Vec3 = [number, number, number]

interface Face { n: Vec3; d: number } // inside ⇔ n·x ≤ d (n unit length)

export interface Gamut {
  faces: Face[]
  black: Vec3        // linear RGB of the darkest palette colour
  white: Vec3        // linear RGB of the lightest palette colour
  axisL: Float64Array // OKLab L along black→white, sampled at AXIS_STEPS + 1 points
}

const EPS = 1e-9
const AXIS_STEPS = 256
const BISECT_STEPS = 20

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]

/** Convex hull of the measured palette in linear RGB, or null if it's flat (no volume). */
export function buildGamut(palette: Palette): Gamut | null {
  const pts: Vec3[] = palette.colors.map(c => [srgbToLinear(c.measured[0]), srgbToLinear(c.measured[1]), srgbToLinear(c.measured[2])])
  const faces: Face[] = []
  let hasVolume = false

  // Brute force: a triple of points spans a hull face iff all other points lie on one side of
  // its plane. Palettes are tiny (≤ 16 colours), so O(n⁴) is irrelevant.
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) for (let k = j + 1; k < pts.length; k++) {
    const c = cross(sub(pts[j], pts[i]), sub(pts[k], pts[i]))
    const len = Math.hypot(...c)
    if (len < EPS) continue // collinear
    const n: Vec3 = [c[0] / len, c[1] / len, c[2] / len]
    const d = dot(n, pts[i])
    let above = 0, below = 0
    for (let m = 0; m < pts.length; m++) {
      const s = dot(n, pts[m]) - d
      if (s > EPS) above++
      else if (s < -EPS) below++
    }
    if (above && below) continue
    if (above || below) hasVolume = true
    faces.push(above ? { n: [-n[0], -n[1], -n[2]], d: -d } : { n, d })
  }
  if (!hasVolume) return null

  const byL = pts.map(p => ({ p, L: linearToOklab(...p)[0] })).sort((a, b) => a.L - b.L)
  const black = byL[0].p, white = byL[byL.length - 1].p
  const axisL = new Float64Array(AXIS_STEPS + 1)
  for (let i = 0; i <= AXIS_STEPS; i++) axisL[i] = linearToOklab(...mix(black, white, i / AXIS_STEPS))[0]
  return { faces, black, white, axisL }
}

function mix(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

export function inGamut(g: Gamut, x: Vec3): boolean {
  for (const f of g.faces) if (dot(f.n, x) - f.d > 1e-7) return false
  return true
}

/** Point on the panel's black→white axis whose OKLab L is closest to L. */
function neutralAt(g: Gamut, L: number): Vec3 {
  const a = g.axisL
  if (L <= a[0]) return g.black
  if (L >= a[AXIS_STEPS]) return g.white
  let lo = 0, hi = AXIS_STEPS
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (a[m] < L) lo = m; else hi = m }
  const t = (lo + (L - a[lo]) / (a[hi] - a[lo])) / AXIS_STEPS
  return mix(g.black, g.white, t)
}

/** Map one sRGB colour into the gamut. Returns the input unchanged when already inside. */
export function mapColor(g: Gamut, r: number, gr: number, b: number, balance: number): Vec3 {
  const lin: Vec3 = [srgbToLinear(r), srgbToLinear(gr), srgbToLinear(b)]
  if (inGamut(g, lin)) return [r, gr, b]

  const p = linearToOklab(...lin)
  const Lb = g.axisL[0], Lw = g.axisL[AXIS_STEPS]
  const anchorL = (1 - balance) * Math.min(Lw, Math.max(Lb, p[0])) + balance * (Lb + Lw) / 2
  const anchor = linearToOklab(...neutralAt(g, anchorL))

  // Bisect along the OKLab line anchor → p for the last point inside the hull.
  let lo = 0, hi = 1
  for (let i = 0; i < BISECT_STEPS; i++) {
    const t = (lo + hi) / 2
    const q = oklabToLinear(anchor[0] + (p[0] - anchor[0]) * t, anchor[1] + (p[1] - anchor[1]) * t, anchor[2] + (p[2] - anchor[2]) * t)
    if (inGamut(g, q)) lo = t; else hi = t
  }
  // Rounding to 8-bit sRGB can nudge the boundary point just outside the hull, which would leave
  // a sliver of irreducible error; step back towards the anchor until the rounded colour is inside.
  let rgb: Vec3 = [0, 0, 0]
  for (let t = lo; t >= 0; t -= 0.002) {
    const out = oklabToLinear(anchor[0] + (p[0] - anchor[0]) * t, anchor[1] + (p[1] - anchor[1]) * t, anchor[2] + (p[2] - anchor[2]) * t)
    rgb = [linearToSrgb(out[0]), linearToSrgb(out[1]), linearToSrgb(out[2])]
    if (inGamut(g, [srgbToLinear(rgb[0]), srgbToLinear(rgb[1]), srgbToLinear(rgb[2])])) break
  }
  return rgb
}

/** Map every pixel of an RGBA buffer into the palette's gamut, in place. No-op for flat gamuts. */
export function applyGamutMapping(data: Uint8ClampedArray, palette: Palette, balance: number): void {
  const g = buildGamut(palette)
  if (!g) return
  const cache = new Map<number, number>()
  for (let i = 0; i < data.length; i += 4) {
    const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2]
    let v = cache.get(key)
    if (v === undefined) {
      const [r, gr, b] = mapColor(g, data[i], data[i + 1], data[i + 2], balance)
      v = (r << 16) | (gr << 8) | b
      cache.set(key, v)
    }
    data[i] = v >> 16; data[i + 1] = (v >> 8) & 255; data[i + 2] = v & 255
  }
}
