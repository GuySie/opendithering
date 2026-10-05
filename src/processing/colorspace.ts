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

export function linearToXyz(r: number, g: number, b: number): [number, number, number] {
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

// --- L*a*b* -> sRGB (absolute, D65/2°, no white normalisation) ---
// Inverse of rgbToLab. Out-of-gamut components clamp to [0, 255].

function fInv(t: number): number {
  const t3 = t * t * t
  return t3 > 0.008856 ? t3 : (t - 16 / 116) / 7.787
}

export function labToRgb(L: number, a: number, b: number): [number, number, number] {
  const fy = (L + 16) / 116
  const fx = fy + a / 500
  const fz = fy - b / 200
  const x = D65[0] * fInv(fx)
  const y = D65[1] * fInv(fy)
  const z = D65[2] * fInv(fz)
  const lr =  3.2404542 * x - 1.5371385 * y - 0.4985314 * z
  const lg = -0.9692660 * x + 1.8760108 * y + 0.0415560 * z
  const lb =  0.0556434 * x - 0.2040259 * y + 1.0572252 * z
  return [linearToSrgb(lr), linearToSrgb(lg), linearToSrgb(lb)]
}

// --- linear RGB -> OKLab ---

export function rgbToOklab(r: number, g: number, b: number): [number, number, number] {
  return linearToOklab(srgbToLinear(r), srgbToLinear(g), srgbToLinear(b))
}

export function linearToOklab(lr: number, lg: number, lb: number): [number, number, number] {
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

// --- OKLab -> sRGB ---

export function oklabToRgb(L: number, a: number, b: number): [number, number, number] {
  const [lr, lg, lb] = oklabToLinear(L, a, b)
  return [linearToSrgb(lr), linearToSrgb(lg), linearToSrgb(lb)]
}

/** OKLab → linear RGB, unclamped (out-of-gamut values may be negative or > 1). */
export function oklabToLinear(L: number, a: number, b: number): [number, number, number] {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b
  const l = l_ * l_ * l_
  const m = m_ * m_ * m_
  const s = s_ * s_ * s_
  return [
     4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ]
}

// --- Rec. 709 luminance (linear) ---

export function rec709Luminance(r: number, g: number, b: number): number {
  return 0.2126729 * srgbToLinear(r) +
         0.7151522 * srgbToLinear(g) +
         0.0721750 * srgbToLinear(b)
}

// --- linear RGB <-> YyCxCz (Flohr, Kolpatzik & Allebach) ---
// A linear transform of XYZ (linearised CIELAB): Yy = 116·Y, Cx = 500·(X/Xn − Y), Cz = 200·(Y − Z/Zn).
// The colour space DBS refine measures error in; gamut mapping's nearest-colour clip uses it too so both
// agree on which reproducible colour is "closest".

const YCC_FROM_LINEAR: number[][] = (() => {
  const cols = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map(([r, g, b]) => {
    const [X, Y, Z] = linearToXyz(r, g, b)
    return [116 * Y, 500 * (X / D65[0] - Y), 200 * (Y - Z / D65[2])]
  })
  return [0, 1, 2].map(i => [cols[0][i], cols[1][i], cols[2][i]])
})()
const LINEAR_FROM_YCC: number[][] = (() => {
  const [[a, b, c], [d, e, f], [g, h, i]] = YCC_FROM_LINEAR
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C
  return [
    [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det],
  ]
})()

export function linearToYyCxCz(r: number, g: number, b: number): [number, number, number] {
  const m = YCC_FROM_LINEAR
  return [m[0][0] * r + m[0][1] * g + m[0][2] * b, m[1][0] * r + m[1][1] * g + m[1][2] * b, m[2][0] * r + m[2][1] * g + m[2][2] * b]
}

export function yyCxCzToLinear(y: number, cx: number, cz: number): [number, number, number] {
  const m = LINEAR_FROM_YCC
  return [m[0][0] * y + m[0][1] * cx + m[0][2] * cz, m[1][0] * y + m[1][1] * cx + m[1][2] * cz, m[2][0] * y + m[2][1] * cx + m[2][2] * cz]
}
