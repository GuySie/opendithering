import type { ProcessingSettings, Palette } from '../types'
import { srgbToLinear, linearToSrgb, rec709Luminance } from './colorspace'

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

export function applyChannelGains(data: Uint8ClampedArray, redGain: number, greenGain: number, blueGain: number): void {
  for (let i = 0; i < data.length; i += 4) {
    data[i]     = Math.min(255, Math.round(data[i]     * redGain))
    data[i + 1] = Math.min(255, Math.round(data[i + 1] * greenGain))
    data[i + 2] = Math.min(255, Math.round(data[i + 2] * blueGain))
  }
}
