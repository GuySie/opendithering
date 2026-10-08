// Downscaling for the fit-to-window preview.
//
// A dithered image only looks like its target once the eye averages
// neighbouring dots, and the eye averages light: linear RGB, not sRGB codes.
// Shrinking the preview with nearest neighbour (`image-rendering: pixelated`)
// instead shows one arbitrary pixel per screen pixel, which turns the dot
// pattern into coarse speckle and moiré that the panel never shows, worst for
// high-contrast dot mixes like DBS's. The browser's smooth scaling isn't
// enough either: it averages too few pixels at large reductions and averages
// sRGB codes, which weighs dark dots too heavily.
//
// So the preview gets an exact area average (each output pixel is the mean of
// the source area it covers, fractional edges weighted by overlap) in linear
// light, at the screen's device-pixel resolution.

const TO_LINEAR = new Float32Array(256)
for (let i = 0; i < 256; i++) {
  const v = i / 255
  TO_LINEAR[i] = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
}

// Linear → sRGB code, sampled finely enough that rounding matches the exact
// conversion for all but the darkest few codes (off by at most 1 there).
const SRGB_STEPS = 4096
const TO_SRGB = new Uint8Array(SRGB_STEPS + 1)
for (let i = 0; i <= SRGB_STEPS; i++) {
  const v = i / SRGB_STEPS
  const s = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055
  TO_SRGB[i] = Math.round(s * 255)
}

/**
 * For each output index along one axis, the source indices it covers and
 * their weights (overlap with the output pixel's footprint), summing to 1.
 */
function axisWeights(srcLen: number, outLen: number): { start: Int32Array; count: Int32Array; weights: Float32Array[] } {
  const scale = srcLen / outLen
  const start = new Int32Array(outLen)
  const count = new Int32Array(outLen)
  const weights: Float32Array[] = []
  for (let o = 0; o < outLen; o++) {
    const a = o * scale, b = Math.min(srcLen, (o + 1) * scale)
    const j0 = Math.floor(a), j1 = Math.min(srcLen, Math.ceil(b))
    const w = new Float32Array(j1 - j0)
    for (let j = j0; j < j1; j++) w[j - j0] = (Math.min(j + 1, b) - Math.max(j, a)) / (b - a)
    start[o] = j0
    count[o] = j1 - j0
    weights.push(w)
  }
  return { start, count, weights }
}

/** Area-average `src` down to `outW`×`outH` in linear light. Alpha is set opaque. */
export function downscaleLinear(src: ImageData, outW: number, outH: number): ImageData {
  const { width: w, height: h, data } = src
  const xw = axisWeights(w, outW)
  const yw = axisWeights(h, outH)

  // Horizontal pass: h rows × outW columns, linear RGB.
  const tmp = new Float32Array(outW * h * 3)
  for (let y = 0; y < h; y++) {
    const row = y * w * 4
    for (let o = 0; o < outW; o++) {
      const j0 = xw.start[o], n = xw.count[o], wt = xw.weights[o]
      let r = 0, g = 0, b = 0
      for (let k = 0; k < n; k++) {
        const p = row + (j0 + k) * 4, f = wt[k]
        r += TO_LINEAR[data[p]] * f
        g += TO_LINEAR[data[p + 1]] * f
        b += TO_LINEAR[data[p + 2]] * f
      }
      const t = (y * outW + o) * 3
      tmp[t] = r; tmp[t + 1] = g; tmp[t + 2] = b
    }
  }

  // Vertical pass, then back to sRGB.
  const out = new ImageData(outW, outH)
  const od = out.data
  for (let o = 0; o < outH; o++) {
    const j0 = yw.start[o], n = yw.count[o], wt = yw.weights[o]
    for (let x = 0; x < outW; x++) {
      let r = 0, g = 0, b = 0
      for (let k = 0; k < n; k++) {
        const t = ((j0 + k) * outW + x) * 3, f = wt[k]
        r += tmp[t] * f
        g += tmp[t + 1] * f
        b += tmp[t + 2] * f
      }
      const p = (o * outW + x) * 4
      od[p] = TO_SRGB[Math.round(Math.min(1, r) * SRGB_STEPS)]
      od[p + 1] = TO_SRGB[Math.round(Math.min(1, g) * SRGB_STEPS)]
      od[p + 2] = TO_SRGB[Math.round(Math.min(1, b) * SRGB_STEPS)]
      od[p + 3] = 255
    }
  }
  return out
}
