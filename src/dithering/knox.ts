import type { DitheringAlgorithm, Palette, ColorSpace } from '../types'
import { rgbToOklab } from '../processing/colorspace'

type Triple = [number, number, number]

// Floyd-Steinberg kernel
const FS_KERNEL = [
  { dx:  1, dy: 0, weight: 7 },
  { dx: -1, dy: 1, weight: 3 },
  { dx:  0, dy: 1, weight: 5 },
  { dx:  1, dy: 1, weight: 1 },
] as const

export const knoxDithering: DitheringAlgorithm = {
  id: 'knox',
  name: 'Eschbach & Knox',

  // errorSpace and distSpace are ignored: Knox always operates in OKLab.
  // localVariance is ignored: tone-dependent scaling serves the same purpose.
  // extraParams.knoxAlpha (0–1) controls how strongly tone suppresses diffusion at
  // highlights/shadows vs. midtones (α=0 → uniform, α=1 → full Knox scaling).
  dither(
    src: ImageData,
    palette: Palette,
    _errorSpace: ColorSpace,
    _distSpace: ColorSpace,
    strength: number,
    _localVariance?: boolean,
    extraParams?: Record<string, number>,
  ): ImageData {
    const alpha           = Math.max(0,   Math.min(1,   extraParams?.knoxAlpha          ?? 0.5))
    const fringeMagnitude = Math.max(0,   Math.min(0.5, extraParams?.knoxFringe         ?? 0.04))
    const edgeSensitivity = Math.max(0.5, Math.min(16,  extraParams?.knoxEdgeSensitivity ?? 4.0))
    const w = src.width, h = src.height

    // Convert source pixels to OKLab once
    const srcOklab = new Float32Array(w * h * 3)
    for (let i = 0; i < w * h; i++) {
      const s = i * 4
      const [L, a, b] = rgbToOklab(src.data[s], src.data[s + 1], src.data[s + 2])
      srcOklab[i * 3]     = L
      srcOklab[i * 3 + 1] = a
      srcOklab[i * 3 + 2] = b
    }

    // Convert palette measured colors to OKLab once
    const palOklab: Triple[] = palette.colors.map(c =>
      rgbToOklab(c.measured[0], c.measured[1], c.measured[2]))

    // Gradient map: g = clamp((|dL/dx| + |dL/dy|) * edgeSensitivity, 0, 1)
    const gradMap = new Float32Array(w * h)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const L  = srcOklab[(y * w + x) * 3]
        const Lx = x + 1 < w ? srcOklab[(y * w + x + 1) * 3] : L
        const Ly = y + 1 < h ? srcOklab[((y + 1) * w + x) * 3] : L
        gradMap[y * w + x] = Math.min(1, (Math.abs(Lx - L) + Math.abs(Ly - L)) * edgeSensitivity)
      }
    }

    // Error buffer in OKLab (copy of source; accumulates diffused error in-place)
    const errBuf = new Float32Array(srcOklab)

    // Fringe buffer: accumulated L-threshold raise from fired neighbours
    const fringeBuf = new Float32Array(w * h)

    const out = new ImageData(w, h)

    for (let y = 0; y < h; y++) {
      // Serpentine scan
      const ltr = y % 2 === 0
      const xStart = ltr ? 0 : w - 1
      const xEnd   = ltr ? w : -1
      const xStep  = ltr ? 1 : -1

      for (let x = xStart; x !== xEnd; x += xStep) {
        const bufIdx = (y * w + x) * 3

        // Corrected value in OKLab (source + accumulated error), clamped to valid range
        let cL = Math.min(1,   Math.max(0,    errBuf[bufIdx]))
        const ca = Math.min(0.5, Math.max(-0.5, errBuf[bufIdx + 1]))
        const cb = Math.min(0.5, Math.max(-0.5, errBuf[bufIdx + 2]))

        // Apply fringe-field threshold raise to L channel
        cL = Math.min(1, cL + fringeBuf[y * w + x])

        // Nearest palette color in OKLab (Euclidean)
        let bestIdx = 0, bestDist = Infinity
        for (let ci = 0; ci < palOklab.length; ci++) {
          const [pL, pa, pb] = palOklab[ci]
          const dL = cL - pL, da = ca - pa, db = cb - pb
          const d = dL * dL + da * da + db * db
          if (d < bestDist) { bestDist = d; bestIdx = ci }
        }

        const outIdx = (y * w + x) * 4
        const [mr, mg, mb] = palette.colors[bestIdx].measured
        out.data[outIdx]     = mr
        out.data[outIdx + 1] = mg
        out.data[outIdx + 2] = mb
        out.data[outIdx + 3] = 255

        // Quantization error
        const [qL, qa, qb] = palOklab[bestIdx]
        const errL = cL - qL
        const errA = ca - qa
        const errB = cb - qb

        // Knox tone-dependent scale: lerp(1, 4t(1-t), alpha)
        // peaks at t=0.5 (midtone), falls to (1-alpha) at t=0 or t=1
        const t = Math.max(0, Math.min(1, cL))
        const toneScale = 1 + alpha * (4 * t * (1 - t) - 1)

        // Cross-edge suppression: reduce diffusion proportionally to gradient magnitude
        const edgeScale = 1 - gradMap[y * w + x]

        const diffuseScale = toneScale * edgeScale * strength

        if (diffuseScale > 0) {
          for (const { dx, dy, weight } of FS_KERNEL) {
            const nx = x + (ltr ? dx : -dx)
            const ny = y + dy
            if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue
            const f = weight / 16 * diffuseScale
            const nIdx = (ny * w + nx) * 3
            errBuf[nIdx]     += errL * f
            errBuf[nIdx + 1] += errA * f
            errBuf[nIdx + 2] += errB * f
          }
        }

        // Fringe field: raise L threshold of unprocessed 4-connected neighbours
        const neighbours = [
          { nx: x + 1, ny: y },
          { nx: x - 1, ny: y },
          { nx: x,     ny: y + 1 },
          { nx: x,     ny: y - 1 },
        ]
        for (const { nx, ny } of neighbours) {
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue
          const processed = ny < y || (ny === y && (ltr ? nx < x : nx > x))
          if (!processed) fringeBuf[ny * w + nx] += fringeMagnitude
        }
      }
    }

    return out
  },
}
