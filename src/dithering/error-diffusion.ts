import type { Palette, ColorSpace } from '../types'
import { rgbToLab, rgbToOklab } from '../processing/colorspace'

// Precompute a per-pixel strength map [0,1] based on local luminance std dev.
// std dev >= 15 (0-255 scale) maps to 1.0 (full diffusion); flat areas map toward 0.
export function buildVarianceMap(src: ImageData): Float32Array {
  const { width: w, height: h, data } = src
  const map = new Float32Array(w * h)
  const r = 2 // 5×5 window
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0, sumSq = 0, count = 0
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const nx = Math.min(w - 1, Math.max(0, x + dx))
          const ny = Math.min(h - 1, Math.max(0, y + dy))
          const i = (ny * w + nx) * 4
          const lum = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]
          sum += lum; sumSq += lum * lum; count++
        }
      }
      const mean = sum / count
      map[y * w + x] = Math.min(1, Math.sqrt(Math.max(0, sumSq / count - mean * mean)) / 15)
    }
  }
  return map
}

export interface KernelEntry { dx: number; dy: number; weight: number }

type Triple = [number, number, number]

function convertToSpace(r: number, g: number, b: number, space: ColorSpace): Triple {
  if (space === 'cielab') return rgbToLab(r, g, b)
  if (space === 'oklab')  return rgbToOklab(r, g, b)
  return [r, g, b]
}

function distanceInSpace(p: Triple, c: Triple, space: ColorSpace): number {
  const d0 = p[0] - c[0], d1 = p[1] - c[1], d2 = p[2] - c[2]
  // Weight L channel double for CIELAB to compensate for its non-linearity
  if (space === 'cielab') return 2 * d0 * d0 + d1 * d1 + d2 * d2
  return d0 * d0 + d1 * d1 + d2 * d2
}

// Used by bayer.ts: takes raw RGB and a distSpace, converts internally
export function findNearestColor(
  r: number, g: number, b: number,
  palette: Palette,
  distSpace: ColorSpace,
): number {
  const pixel = convertToSpace(r, g, b, distSpace)
  let bestIdx = 0, bestDist = Infinity
  for (let i = 0; i < palette.colors.length; i++) {
    const [mr, mg, mb] = palette.colors[i].measured
    const c = convertToSpace(mr, mg, mb, distSpace)
    const d = distanceInSpace(pixel, c, distSpace)
    if (d < bestDist) { bestDist = d; bestIdx = i }
  }
  return bestIdx
}

export function errorDiffuse(
  src: ImageData,
  palette: Palette,
  errorSpace: ColorSpace,
  distSpace: ColorSpace,
  strength: number,
  kernel: KernelEntry[],
  divisor: number,
  localVariance?: boolean,
  serpentine = true,
): ImageData {
  const w = src.width, h = src.height

  // Pre-convert palette colors to errSpace (for error computation) and distSpace (for lookup)
  const errPalette: Triple[] = palette.colors.map(c =>
    convertToSpace(c.measured[0], c.measured[1], c.measured[2], errorSpace))
  const distPalette: Triple[] = errorSpace === distSpace
    ? errPalette
    : palette.colors.map(c => convertToSpace(c.measured[0], c.measured[1], c.measured[2], distSpace))

  // Float buffer storing each pixel in errSpace (3 channels, no alpha)
  const errBuf = new Float32Array(w * h * 3)
  for (let i = 0; i < w * h; i++) {
    const s = i * 4
    const [e0, e1, e2] = convertToSpace(src.data[s], src.data[s + 1], src.data[s + 2], errorSpace)
    errBuf[i * 3]     = e0
    errBuf[i * 3 + 1] = e1
    errBuf[i * 3 + 2] = e2
  }

  const varMap = localVariance ? buildVarianceMap(src) : null

  const out = new ImageData(w, h)

  for (let y = 0; y < h; y++) {
    const leftToRight = !serpentine || y % 2 === 0
    const xStart = leftToRight ? 0 : w - 1
    const xEnd   = leftToRight ? w : -1
    const xStep  = leftToRight ? 1 : -1

    for (let x = xStart; x !== xEnd; x += xStep) {
      const bufIdx = (y * w + x) * 3

      // Pixel in errSpace with accumulated error
      let e0 = errBuf[bufIdx], e1 = errBuf[bufIdx + 1], e2 = errBuf[bufIdx + 2]

      // Clamp before nearest-color lookup to prevent runaway error accumulation
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

      // Convert to distSpace for nearest-color lookup (only if spaces differ)
      let dp: Triple
      if (errorSpace === distSpace) {
        dp = [e0, e1, e2]
      } else if (errorSpace === 'rgb') {
        dp = convertToSpace(e0, e1, e2, distSpace)
      } else {
        // Cross-perceptual-space conversion not supported; compare in errSpace
        dp = [e0, e1, e2]
      }

      // Find nearest palette color
      let bestIdx = 0, bestDist = Infinity
      for (let i = 0; i < distPalette.length; i++) {
        const d = distanceInSpace(dp, distPalette[i], distSpace)
        if (d < bestDist) { bestDist = d; bestIdx = i }
      }

      // Write measured RGB to output
      const outIdx = (y * w + x) * 4
      const [mr, mg, mb] = palette.colors[bestIdx].measured
      out.data[outIdx]     = mr
      out.data[outIdx + 1] = mg
      out.data[outIdx + 2] = mb
      out.data[outIdx + 3] = 255

      // Diffuse quantization error in errSpace
      const effectiveStrength = varMap ? strength * varMap[y * w + x] : strength
      if (effectiveStrength > 0) {
        const ec = errPalette[bestIdx]
        const err0 = (e0 - ec[0]) * effectiveStrength
        const err1 = (e1 - ec[1]) * effectiveStrength
        const err2 = (e2 - ec[2]) * effectiveStrength

        for (const { dx, dy, weight } of kernel) {
          const nx = x + (leftToRight ? dx : -dx)
          const ny = y + dy
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue
          const nIdx = (ny * w + nx) * 3
          const f = weight / divisor
          errBuf[nIdx]     += err0 * f
          errBuf[nIdx + 1] += err1 * f
          errBuf[nIdx + 2] += err2 * f
        }
      }
    }
  }

  return out
}
