// sRGB <-> linear RGB <-> CIE L*a*b* conversions
// Used for perceptually-uniform color distance in dithering

// --- sRGB <-> linear ---

export function srgbToLinear(c: number): number {
  const v = c / 255
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
}

export function linearToSrgb(c: number): number {
  const v = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055
  return Math.round(Math.min(1, Math.max(0, v)) * 255)
}

// --- linear RGB -> XYZ (D65) ---

function linearToXyz(r: number, g: number, b: number): [number, number, number] {
  const x = r * 0.4124564 + g * 0.3575761 + b * 0.1804375
  const y = r * 0.2126729 + g * 0.7151522 + b * 0.0721750
  const z = r * 0.0193339 + g * 0.1191920 + b * 0.9503041
  return [x, y, z]
}

// --- XYZ -> L*a*b* ---

const D65 = [0.95047, 1.00000, 1.08883]

function f(t: number): number {
  return t > 0.008856 ? Math.cbrt(t) : (7.787 * t) + (16 / 116)
}

export function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const lr = srgbToLinear(r)
  const lg = srgbToLinear(g)
  const lb = srgbToLinear(b)
  const [x, y, z] = linearToXyz(lr, lg, lb)
  const fx = f(x / D65[0])
  const fy = f(y / D65[1])
  const fz = f(z / D65[2])
  const L = 116 * fy - 16
  const a = 500 * (fx - fy)
  const bStar = 200 * (fy - fz)
  return [L, a, bStar]
}

// --- linear RGB -> OKLab ---

export function rgbToOklab(r: number, g: number, b: number): [number, number, number] {
  const lr = srgbToLinear(r)
  const lg = srgbToLinear(g)
  const lb = srgbToLinear(b)
  let l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb
  let m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb
  let s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb
  l = Math.cbrt(l); m = Math.cbrt(m); s = Math.cbrt(s)
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ]
}

// --- Color distance ---

export function deltaE_rgb(
  r1: number, g1: number, b1: number,
  r2: number, g2: number, b2: number,
): number {
  const dr = r1 - r2, dg = g1 - g2, db = b1 - b2
  return dr * dr + dg * dg + db * db // squared — no sqrt needed for comparison
}

export function deltaE_lab(
  r1: number, g1: number, b1: number,
  r2: number, g2: number, b2: number,
): number {
  const [L1, a1, b1s] = rgbToLab(r1, g1, b1)
  const [L2, a2, b2s] = rgbToLab(r2, g2, b2)
  const dL = L1 - L2, da = a1 - a2, db = b1s - b2s
  return 2 * dL * dL + da * da + db * db
}

export function deltaE_oklab(
  r1: number, g1: number, b1: number,
  r2: number, g2: number, b2: number,
): number {
  const [L1, a1, b1s] = rgbToOklab(r1, g1, b1)
  const [L2, a2, b2s] = rgbToOklab(r2, g2, b2)
  const dL = L1 - L2, da = a1 - a2, db = b1s - b2s
  return dL * dL + da * da + db * db
}

// --- Rec. 709 luminance (linear) ---

export function rec709Luminance(r: number, g: number, b: number): number {
  return 0.2126729 * srgbToLinear(r) +
         0.7151522 * srgbToLinear(g) +
         0.0721750 * srgbToLinear(b)
}
