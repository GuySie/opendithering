import type { HueGap, Palette } from '../types'
import { rgbToHsl, hslToRgb } from './tone'
import { deltaE_oklab } from './colorspace'

export function applyHueRemap(
  data: Uint8ClampedArray,
  palette: Palette,
  gaps: HueGap[],
  strengths: Record<string, number>
): void {
  const activeGaps = gaps.filter(g => (strengths[g.id] ?? 0) > 0)
  if (activeGaps.length === 0) return

  const lut = buildHueLut(palette)

  for (let i = 0; i < data.length; i += 4) {
    const [h, s, l] = rgbToHsl(data[i], data[i + 1], data[i + 2])
    const hDeg = h * 360

    let newH = h
    for (const gap of activeGaps) {
      if (hDeg >= gap.hueMin && hDeg <= gap.hueMax) {
        const targetH = lut[Math.round(hDeg) % 360] / 360
        newH = lerpHue(h, targetH, strengths[gap.id]!)
        break
      }
    }

    if (newH !== h) {
      const [r, g, b] = hslToRgb(newH, s, l)
      data[i] = r; data[i + 1] = g; data[i + 2] = b
    }
  }
}

// For each integer hue degree, find the nearest palette measured color in OKLab
// (at reference S=0.7, L=0.5) and store that color's hue in degrees.
function buildHueLut(palette: Palette): Float32Array {
  const lut = new Float32Array(360)
  for (let hDeg = 0; hDeg < 360; hDeg++) {
    const [r, g, b] = hslToRgb(hDeg / 360, 0.7, 0.5)
    let bestHue = 0, bestDist = Infinity
    for (const color of palette.colors) {
      const d = deltaE_oklab(r, g, b, color.measured[0], color.measured[1], color.measured[2])
      if (d < bestDist) {
        bestDist = d
        const [ph] = rgbToHsl(color.measured[0], color.measured[1], color.measured[2])
        bestHue = ph * 360
      }
    }
    lut[hDeg] = bestHue
  }
  return lut
}

// Shortest-arc hue lerp; a and b are in 0–1 range.
function lerpHue(a: number, b: number, t: number): number {
  let diff = b - a
  if (diff > 0.5) diff -= 1
  if (diff < -0.5) diff += 1
  return (a + diff * t + 1) % 1
}
