import type { ProcessingSettings } from '../types'

// All functions operate on a packed Float32Array of OKLab values:
// layout: [L0, a0, b0, L1, a1, b1, …], 3 floats per pixel.

// --- Dynamic range compression ---
// Maps L into the display's actual [blackL, whiteL] range.

export function compressDynamicRange(buf: Float32Array, blackL: number, whiteL: number): void {
  const range = whiteL - blackL
  for (let i = 0; i < buf.length; i += 3) {
    buf[i] = blackL + buf[i] * range
  }
}

// --- Tone mapping ---
// Applies contrast or S-curve to L only; a and b are unchanged (chroma-neutral).

function sCurveL(t: number, strength: number, shadowBoost: number, highlightCompress: number, midpoint: number): number {
  const shadow = t < midpoint
    ? t + shadowBoost * Math.pow(1 - t / midpoint, 2) * midpoint
    : t

  const highlight = shadow > midpoint
    ? midpoint + Math.pow((shadow - midpoint) / (1 - midpoint), highlightCompress) * (1 - midpoint)
    : shadow

  return Math.min(1, Math.max(0, t * (1 - strength) + highlight * strength))
}

export function applyToneMapping(buf: Float32Array, s: ProcessingSettings): void {
  if (s.toneMode === 'contrast') {
    for (let i = 0; i < buf.length; i += 3) {
      buf[i] = Math.min(1, Math.max(0, (buf[i] - s.midpoint) * s.contrast + s.midpoint))
    }
  } else {
    for (let i = 0; i < buf.length; i += 3) {
      buf[i] = sCurveL(buf[i], s.strength, s.shadowBoost, s.highlightCompress, s.midpoint)
    }
  }
}

// --- Saturation ---
// Scales chroma uniformly: holds hue angle (atan2(b, a)), changes magnitude.

export function applySaturation(buf: Float32Array, saturation: number): void {
  for (let i = 0; i < buf.length; i += 3) {
    buf[i + 1] *= saturation
    buf[i + 2] *= saturation
  }
}

// --- Exposure ---
// Scales L only.

export function applyExposure(buf: Float32Array, exposure: number): void {
  for (let i = 0; i < buf.length; i += 3) {
    buf[i] = Math.min(1, buf[i] * exposure)
  }
}

// --- Color balance ---
// Adds OKLab a/b offsets: shifts all pixels along the green↔magenta (a) and
// blue↔yellow (b) axes without affecting luminance.

export function applyColorBalance(buf: Float32Array, aOffset: number, bOffset: number): void {
  for (let i = 0; i < buf.length; i += 3) {
    buf[i + 1] += aOffset
    buf[i + 2] += bOffset
  }
}
