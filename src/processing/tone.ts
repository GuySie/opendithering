import type { ProcessingSettings, Palette } from '../types'
import { srgbToLinear, linearToSrgb, rec709Luminance, rgbToOklab, oklabToRgb } from './colorspace'

// --- Dynamic range compression ---
// Maps pixel luminance into the display's actual [black, white] luminance range
// so that pure black pixels map to the display's real black level, not 0,0,0.

export function compressDynamicRange(data: Uint8ClampedArray, palette: Palette): void {
  // Find the black and white palette entries by name
  const blackColor = palette.colors.find(c => c.name === 'black') ?? palette.colors[0]
  const whiteColor = palette.colors.find(c => c.name === 'white') ?? palette.colors[palette.colors.length - 1]

  const blackY = rec709Luminance(...blackColor.measured)
  const whiteY = rec709Luminance(...whiteColor.measured)
  const range = whiteY - blackY

  for (let i = 0; i < data.length; i += 4) {
    const lr = srgbToLinear(data[i])
    const lg = srgbToLinear(data[i + 1])
    const lb = srgbToLinear(data[i + 2])

    const Y = 0.2126729 * lr + 0.7151522 * lg + 0.0721750 * lb
    if (Y < 1e-6) continue

    const newY = blackY + Y * range
    const scale = newY / Y

    data[i]     = linearToSrgb(lr * scale)
    data[i + 1] = linearToSrgb(lg * scale)
    data[i + 2] = linearToSrgb(lb * scale)
  }
}

// --- Panel white point mapping ---
// Alternative to plain compressDynamicRange (settings.drcMode === 'whitepoint'). compressDynamicRange only
// scales brightness and keeps the source's colour balance, so pure white becomes a *neutral* grey at the
// panel's white luminance — a colour the panel can't show when its white is tinted (measured Spectra 6
// whites are slightly green), which DBS then fakes with dots of other colours (a pink cast on white).
// Here the colour balance is first adapted to the panel's white (Bradford chromatic adaptation from D65 to
// the panel white's chromaticity), then brightness is compressed exactly as compressDynamicRange does.
// Source white lands exactly on the panel's measured white; greys keep the panel white's tint.
// The panel's *black* point is deliberately not mapped: black point compensation adds the panel black's
// (purplish) tint to every colour and visibly desaturates dark saturated colours (hair chroma 0.095 → 0.074
// on the test illustration), while the brightness-only scaling keeps them saturated.
// Runs after tone mapping (see applyAdjustments) so the curve can't dim white.

type Mat3 = number[][]
const BRADFORD: Mat3 = [[0.8951, 0.2664, -0.1614], [-0.7502, 1.7135, 0.0367], [0.0389, -0.0685, 1.0296]]
const RGB_TO_XYZ: Mat3 = [[0.4124564, 0.3575761, 0.1804375], [0.2126729, 0.7151522, 0.0721750], [0.0193339, 0.1191920, 0.9503041]]

const mul3 = (a: Mat3, b: Mat3): Mat3 => a.map(row => [0, 1, 2].map(j => row[0] * b[0][j] + row[1] * b[1][j] + row[2] * b[2][j]))
const apply3 = (m: Mat3, v: number[]) => m.map(row => row[0] * v[0] + row[1] * v[1] + row[2] * v[2])
function inv3(m: Mat3): Mat3 {
  const [[a, b, c], [d, e, f], [g, h, i]] = m
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g
  const det = a * A + b * B + c * C
  return [
    [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det],
  ]
}

/** Chromatic adaptation (linear RGB matrix) from D65 white to the panel white's chromaticity, at Y = 1. */
export function panelWhiteAdaptation(palette: Palette): Mat3 {
  const whiteColor = palette.colors.find(c => c.name === 'white') ?? palette.colors[palette.colors.length - 1]
  const wl = whiteColor.measured.map(srgbToLinear)
  const Yw = 0.2126729 * wl[0] + 0.7151522 * wl[1] + 0.0721750 * wl[2]
  const toLms = mul3(BRADFORD, RGB_TO_XYZ)
  const ls = apply3(toLms, [1, 1, 1])
  const lw = apply3(toLms, wl.map(v => v / Yw))
  const diag: Mat3 = [0, 1, 2].map(i => [0, 1, 2].map(j => (i === j ? lw[i] / ls[i] : 0)))
  return mul3(inv3(toLms), mul3(diag, toLms))
}

export function mapToPanelWhitePoint(data: Uint8ClampedArray, palette: Palette): void {
  const A = panelWhiteAdaptation(palette)
  // Brightness compression as in compressDynamicRange, but on the adapted float values: the adapted white
  // exceeds 1.0 in some channels before compression, so an 8-bit round-trip in between would clip its hue.
  const blackColor = palette.colors.find(c => c.name === 'black') ?? palette.colors[0]
  const whiteColor = palette.colors.find(c => c.name === 'white') ?? palette.colors[palette.colors.length - 1]
  const blackY = rec709Luminance(...blackColor.measured)
  const range = rec709Luminance(...whiteColor.measured) - blackY
  const cache = new Map<number, number>()
  for (let i = 0; i < data.length; i += 4) {
    const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2]
    let v = cache.get(key)
    if (v === undefined) {
      const o = apply3(A, [srgbToLinear(data[i]), srgbToLinear(data[i + 1]), srgbToLinear(data[i + 2])])
      const Y = 0.2126729 * o[0] + 0.7151522 * o[1] + 0.0721750 * o[2]
      const scale = Y < 1e-6 ? 0 : (blackY + Y * range) / Y
      v = (linearToSrgb(o[0] * scale) << 16) | (linearToSrgb(o[1] * scale) << 8) | linearToSrgb(o[2] * scale)
      cache.set(key, v)
    }
    data[i] = v >> 16; data[i + 1] = (v >> 8) & 255; data[i + 2] = v & 255
  }
}

// --- Highlight lift (DBS refine target only) ---
// Near-white colours usually land below the panel's white after DRC + tone mapping, and DBS — which
// mixes in linear light, as the eye does — reproduces that faithfully with a sprinkling of dark dots,
// making light areas look dim and noisy (error diffusion in OKLab overshoots towards white instead).
// This knee blends colours in the top of the panel's lightness range towards the panel's measured
// white, in OKLab: lightness rises and faint tints fade together, like printing near-white as paper
// white. Only near-whites are affected: colours below HIGHLIGHT_KNEE of the black→white OKLab L range,
// and clearly coloured ones, are untouched, so light colours with a real tint (skin, a pale blue sky, a
// sunlit green hill) keep their colour. `tintTolerance` is the OKLab chroma at which the lift has faded out
// completely; it starts fading at 60% of that. Whites are ~0.000, faintly tinted off-whites ~0.01, while
// skin (~0.04) and pale blues (~0.03) need to stay above the tolerance.

export const HIGHLIGHT_KNEE = 0.65
export const HIGHLIGHT_TINT_TOLERANCE = 0.025

export function applyHighlightLift(data: Uint8ClampedArray, palette: Palette, strength: number, tintTolerance = HIGHLIGHT_TINT_TOLERANCE): void {
  if (strength <= 0) return
  const hi = Math.max(tintTolerance, 1e-4), lo = 0.6 * hi
  const labs = palette.colors.map(c => ({ c, L: rgbToOklab(...c.measured)[0] })).sort((a, b) => a.L - b.L)
  const Lb = labs[0].L
  const white = labs[labs.length - 1]
  const [Lw, aw, bw] = rgbToOklab(...white.c.measured)
  const cache = new Map<number, number>()
  for (let i = 0; i < data.length; i += 4) {
    const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2]
    let v = cache.get(key)
    if (v === undefined) {
      const [L, a, b] = rgbToOklab(data[i], data[i + 1], data[i + 2])
      const t = Math.min(1, Math.max(0, ((L - Lb) / (Lw - Lb) - HIGHLIGHT_KNEE) / (1 - HIGHLIGHT_KNEE)))
      const c = Math.min(1, Math.max(0, (Math.hypot(a, b) - lo) / (hi - lo)))
      const u = strength * t * t * (3 - 2 * t) * (1 - c * c * (3 - 2 * c))
      if (u <= 0) {
        v = key
      } else {
        const [r, g, bl] = oklabToRgb(L + (Lw - L) * u, a + (aw - a) * u, b + (bw - b) * u)
        v = (r << 16) | (g << 8) | bl
      }
      cache.set(key, v)
    }
    data[i] = v >> 16; data[i + 1] = (v >> 8) & 255; data[i + 2] = v & 255
  }
}

// --- Tone mapping ---

function applyContrast(v: number, contrast: number): number {
  return Math.min(255, Math.max(0, Math.round((v - 128) * contrast + 128)))
}

// Parametric S-curve: compresses highlights, lifts shadows, strength controls blend
function sCurve(v: number, strength: number, shadowBoost: number, highlightCompress: number, midpoint: number): number {
  const t = v / 255

  // Shadows: lift
  const shadow = t < midpoint
    ? t + shadowBoost * Math.pow(1 - t / midpoint, 2) * midpoint
    : t

  // Highlights: compress
  const highlight = shadow > midpoint
    ? midpoint + Math.pow((shadow - midpoint) / (1 - midpoint), highlightCompress) * (1 - midpoint)
    : shadow

  // Blend between identity and shaped curve by strength
  const result = t * (1 - strength) + highlight * strength
  return Math.min(255, Math.max(0, Math.round(result * 255)))
}

export function applyToneMapping(data: Uint8ClampedArray, s: ProcessingSettings): void {
  if (s.toneMode === 'contrast') {
    for (let i = 0; i < data.length; i += 4) {
      data[i]     = applyContrast(data[i],     s.contrast)
      data[i + 1] = applyContrast(data[i + 1], s.contrast)
      data[i + 2] = applyContrast(data[i + 2], s.contrast)
    }
  } else {
    for (let i = 0; i < data.length; i += 4) {
      data[i]     = sCurve(data[i],     s.strength, s.shadowBoost, s.highlightCompress, s.midpoint)
      data[i + 1] = sCurve(data[i + 1], s.strength, s.shadowBoost, s.highlightCompress, s.midpoint)
      data[i + 2] = sCurve(data[i + 2], s.strength, s.shadowBoost, s.highlightCompress, s.midpoint)
    }
  }
}

// --- Saturation (HSL) ---

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255, gn = g / 255, bn = b / 255
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h = 0
  if (max === rn)      h = (gn - bn) / d + (gn < bn ? 6 : 0)
  else if (max === gn) h = (bn - rn) / d + 2
  else                 h = (rn - gn) / d + 4
  return [h / 6, s, l]
}

function hue2rgb(p: number, q: number, t: number): number {
  if (t < 0) t += 1
  if (t > 1) t -= 1
  if (t < 1/6) return p + (q - p) * 6 * t
  if (t < 1/2) return q
  if (t < 2/3) return p + (q - p) * (2/3 - t) * 6
  return p
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) {
    const v = Math.round(l * 255)
    return [v, v, v]
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  return [
    Math.round(hue2rgb(p, q, h + 1/3) * 255),
    Math.round(hue2rgb(p, q, h) * 255),
    Math.round(hue2rgb(p, q, h - 1/3) * 255),
  ]
}

export function applySaturation(data: Uint8ClampedArray, saturation: number): void {
  for (let i = 0; i < data.length; i += 4) {
    const [h, s, l] = rgbToHsl(data[i], data[i + 1], data[i + 2])
    const [r, g, b] = hslToRgb(h, Math.min(1, s * saturation), l)
    data[i] = r; data[i + 1] = g; data[i + 2] = b
  }
}

export function applyHueSatBands(data: Uint8ClampedArray, bands: readonly number[]): void {
  for (let i = 0; i < data.length; i += 4) {
    const [h, s, l] = rgbToHsl(data[i], data[i + 1], data[i + 2])
    if (s === 0) continue
    const hDeg = h * 360
    const bandIdx = Math.floor(hDeg / 60) % 6
    const nextBand = (bandIdx + 1) % 6
    const t = (hDeg % 60) / 60
    const multiplier = (1 - t) * bands[bandIdx] + t * bands[nextBand]
    const [r, g, b] = hslToRgb(h, Math.min(1, s * multiplier), l)
    data[i] = r; data[i + 1] = g; data[i + 2] = b
  }
}

// --- Exposure ---

export function applyExposure(data: Uint8ClampedArray, exposure: number): void {
  for (let i = 0; i < data.length; i += 4) {
    data[i]     = Math.min(255, Math.round(data[i]     * exposure))
    data[i + 1] = Math.min(255, Math.round(data[i + 1] * exposure))
    data[i + 2] = Math.min(255, Math.round(data[i + 2] * exposure))
  }
}

export function applyChannelGains(data: Uint8ClampedArray, redGain: number, greenGain: number, blueGain: number): void {
  for (let i = 0; i < data.length; i += 4) {
    data[i]     = Math.min(255, Math.round(data[i]     * redGain))
    data[i + 1] = Math.min(255, Math.round(data[i + 1] * greenGain))
    data[i + 2] = Math.min(255, Math.round(data[i + 2] * blueGain))
  }
}

// --- Clarity (midtone-weighted unsharp mask) ---
// Sharpens or softens the image before dithering. The effect is weighted by
// 4·L·(1−L), peaking at 50% grey and fading to zero at pure black/white, so
// quantised shadows/highlights are unaffected while midtone edges are enhanced.

// Two-pass separable box blur. Returns a new Float32Array (n*4, RGBA stride) of blurred RGB values.
// Alpha channel is left as 0; only R/G/B are meaningful.
export function boxBlur(data: Uint8ClampedArray, width: number, height: number, radius: number): Float32Array {
  const n = width * height
  const r = Math.max(1, Math.round(radius))
  const tmp = new Float32Array(n * 3)
  const out = new Float32Array(n * 4)

  // Horizontal pass: data (stride 4) → tmp (stride 3)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sr = 0, sg = 0, sb = 0, count = 0
      for (let dx = -r; dx <= r; dx++) {
        const nx = Math.min(width - 1, Math.max(0, x + dx))
        const i = (y * width + nx) * 4
        sr += data[i]; sg += data[i + 1]; sb += data[i + 2]; count++
      }
      const t = (y * width + x) * 3
      tmp[t] = sr / count; tmp[t + 1] = sg / count; tmp[t + 2] = sb / count
    }
  }

  // Vertical pass: tmp (stride 3) → out (stride 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sr = 0, sg = 0, sb = 0, count = 0
      for (let dy = -r; dy <= r; dy++) {
        const ny = Math.min(height - 1, Math.max(0, y + dy))
        const t = (ny * width + x) * 3
        sr += tmp[t]; sg += tmp[t + 1]; sb += tmp[t + 2]; count++
      }
      const b = (y * width + x) * 4
      out[b] = sr / count; out[b + 1] = sg / count; out[b + 2] = sb / count
    }
  }

  return out
}

export function applyClarity(data: Uint8ClampedArray, width: number, height: number, amount: number, radius = 2): void {
  if (amount === 0) return

  const n = width * height
  const r = Math.max(1, Math.min(4, Math.round(radius)))
  const blurred = boxBlur(data, width, height, r)

  // Apply unsharp mask with midtone weighting
  for (let i = 0; i < n; i++) {
    const pi = i * 4
    const bi = i * 4
    const origR = data[pi], origG = data[pi + 1], origB = data[pi + 2]
    const L = rec709Luminance(origR / 255, origG / 255, origB / 255)
    const midtoneWeight = 4 * L * (1 - L)
    const blend = amount * midtoneWeight
    data[pi]     = Math.min(255, Math.max(0, Math.round(origR + (origR - blurred[bi])     * blend)))
    data[pi + 1] = Math.min(255, Math.max(0, Math.round(origG + (origG - blurred[bi + 1]) * blend)))
    data[pi + 2] = Math.min(255, Math.max(0, Math.round(origB + (origB - blurred[bi + 2]) * blend)))
  }
}
