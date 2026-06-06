import type { ProcessingSettings, Palette, ColorSpace } from '../types'
import { srgbToLinear, linearToSrgb, rec709Luminance, rgbToLab, rgbToOklab, labToRgb, oklabToRgb } from './colorspace'

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

// --- Exposure ---

export function applyExposure(data: Uint8ClampedArray, exposure: number): void {
  for (let i = 0; i < data.length; i += 4) {
    data[i]     = Math.min(255, Math.round(data[i]     * exposure))
    data[i + 1] = Math.min(255, Math.round(data[i + 1] * exposure))
    data[i + 2] = Math.min(255, Math.round(data[i + 2] * exposure))
  }
}

// --- Gamut compression ---
// Pulls out-of-gamut pixels toward the nearest point on any palette edge in the
// working color space. Thresholds are expressed as fractions of the palette's own
// gamut diameter so the same strength value works across OKLab, CIELAB, and RGB.

type Triple = [number, number, number]

function toSpace(r: number, g: number, b: number, space: ColorSpace): Triple {
  if (space === 'oklab')  return rgbToOklab(r, g, b)
  if (space === 'cielab') return rgbToLab(r, g, b)
  return [r, g, b]
}

function fromSpace(c0: number, c1: number, c2: number, space: ColorSpace): Triple {
  if (space === 'oklab')  return oklabToRgb(c0, c1, c2)
  if (space === 'cielab') return labToRgb(c0, c1, c2)
  return [Math.min(255, Math.max(0, Math.round(c0))), Math.min(255, Math.max(0, Math.round(c1))), Math.min(255, Math.max(0, Math.round(c2)))]
}

function nearestOnSegment(P: Triple, A: Triple, B: Triple): Triple {
  const ab0 = B[0]-A[0], ab1 = B[1]-A[1], ab2 = B[2]-A[2]
  const len2 = ab0*ab0 + ab1*ab1 + ab2*ab2
  if (len2 < 1e-12) return A
  const t = Math.max(0, Math.min(1, ((P[0]-A[0])*ab0 + (P[1]-A[1])*ab1 + (P[2]-A[2])*ab2) / len2))
  return [A[0]+t*ab0, A[1]+t*ab1, A[2]+t*ab2]
}

function dist3(A: Triple, B: Triple): number {
  const d0=A[0]-B[0], d1=A[1]-B[1], d2=A[2]-B[2]
  return Math.sqrt(d0*d0 + d1*d1 + d2*d2)
}

function smoothstep(lo: number, hi: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - lo) / (hi - lo)))
  return t * t * (3 - 2 * t)
}

export function gamutCompress(data: Uint8ClampedArray, palette: Palette, space: ColorSpace, strength: number): void {
  if (strength <= 0) return

  const pal: Triple[] = palette.colors.map(c => toSpace(c.measured[0], c.measured[1], c.measured[2], space))

  let diameter = 0
  for (let i = 0; i < pal.length; i++)
    for (let j = i + 1; j < pal.length; j++)
      diameter = Math.max(diameter, dist3(pal[i], pal[j]))
  if (diameter < 1e-10) return

  const lo = 0.15 * diameter
  const hi = 0.45 * diameter

  for (let i = 0; i < data.length; i += 4) {
    const P = toSpace(data[i], data[i+1], data[i+2], space)

    let nearestDist = Infinity
    let nearest: Triple = P
    for (let a = 0; a < pal.length; a++) {
      for (let b = a + 1; b < pal.length; b++) {
        const n = nearestOnSegment(P, pal[a], pal[b])
        const d = dist3(P, n)
        if (d < nearestDist) { nearestDist = d; nearest = n }
      }
    }

    const pull = strength * smoothstep(lo, hi, nearestDist)
    if (pull <= 0) continue

    const Q: Triple = [
      P[0] + pull * (nearest[0] - P[0]),
      P[1] + pull * (nearest[1] - P[1]),
      P[2] + pull * (nearest[2] - P[2]),
    ]
    const [r, g, b] = fromSpace(Q[0], Q[1], Q[2], space)
    data[i] = r; data[i+1] = g; data[i+2] = b
  }
}
