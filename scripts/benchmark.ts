// S-CIELAB benchmark: scores every dithering algorithm (plus DBS-refined Floyd-Steinberg)
// against two references, using a model of human viewing at a given distance and pixel density.
//
//   npm run bench -- [--palette spectra6-guysie] [--preset balanced] [--ppi 127] [--distance 40]
//                    [--passes 10] [--no-synthetic] [images/*.png]
//
// PNG inputs are used as-is (no resize — the app's resize needs a browser canvas), so scale
// them to the panel resolution first. Three synthetic test images are always included unless
// --no-synthetic is given.
//
// References:
//   target — the adjusted pre-dither image (applyAdjustments): how faithfully each algorithm
//            reproduces what it was given
//   source — the source with only the tuners' DRC applied (applyTuneReferenceDrc): what
//            Color-tune/Hue-tune aim for. A DBS score that beats error diffusion on `target`
//            but not on `source` points at tuner overshoot.
//
// Caveat: DBS minimises an eye-filtered error too, so S-CIELAB is structurally inclined to
// favour it. DBS uses Kolpatzik–Bouman Gaussians and S-CIELAB its own sum-of-Gaussians, which
// reduces but doesn't remove the bias. The physical panel remains the final judge.
//
// S-CIELAB: Zhang & Wandell (1996), "A spatial extension of CIELAB for digital color image
// reproduction". Opponent transform and filter parameters as in the reference implementation.

import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { PNG } from 'pngjs'

// Minimal ImageData polyfill — the dithering code only uses data/width/height and the constructors.
class ImageDataPolyfill {
  data: Uint8ClampedArray
  width: number
  height: number
  constructor(a: Uint8ClampedArray | number, b: number, c?: number) {
    if (typeof a === 'number') { this.width = a; this.height = b; this.data = new Uint8ClampedArray(a * b * 4) }
    else { this.data = a; this.width = b; this.height = c ?? a.length / 4 / b }
  }
}
;(globalThis as unknown as { ImageData: unknown }).ImageData = ImageDataPolyfill

const { getAllAlgorithms } = await import('../src/dithering/index')
const { dbsRefine, indicesFromMeasured, measuredFromIndices } = await import('../src/dithering/dbs')
const { applyAdjustments, ditherStep } = await import('../src/processing/pipeline')
const { applyTuneReferenceDrc } = await import('../src/processing/colortune')
const { getPalette } = await import('../src/palettes/index')
const { srgbToLinear, linearToXyz } = await import('../src/processing/colorspace')
const { PRESETS } = await import('../src/types')
type Palette = import('../src/types').Palette
type ProcessingSettings = import('../src/types').ProcessingSettings

// ── CLI ──────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
function opt(name: string, def: string): string {
  const i = argv.indexOf(`--${name}`)
  if (i < 0) return def
  const v = argv[i + 1]
  argv.splice(i, 2)
  return v
}
const paletteId = opt('palette', 'spectra6-guysie')
const presetName = opt('preset', 'balanced') as keyof typeof PRESETS
const ppi = parseFloat(opt('ppi', '127'))
const distanceCm = parseFloat(opt('distance', '40'))
const maxPasses = parseInt(opt('passes', '10'))
const noSynthetic = argv.includes('--no-synthetic')
const files = argv.filter(a => !a.startsWith('--'))

const palette: Palette = getPalette(paletteId)
const settings: ProcessingSettings = { ...PRESETS[presetName] }
const W = 800, H = 480

// ── Test images ──────────────────────────────────────────────────────────────

interface TestImage { name: string; img: ImageData }

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h * 12) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)]
}

function synth(name: string, fn: (x: number, y: number) => [number, number, number]): TestImage {
  const img = new ImageData(W, H)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const [r, g, b] = fn(x, y)
    const i = (y * W + x) * 4
    img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = 255
  }
  return { name, img }
}

const images: TestImage[] = []
if (!noSynthetic) {
  images.push(synth('grey-ramp', x => { const v = Math.round(x / (W - 1) * 255); return [v, v, v] }))
  images.push(synth('hue-sweep', (x, y) => hslToRgb(x / W, 0.85, y < H / 2 ? 0.35 : 0.65)))
  images.push(synth('sky-skin', (x, y) => {
    if (y < H / 2) { // sky: deep blue at top to pale near horizon
      const t = y / (H / 2)
      return [Math.round(40 + 160 * t), Math.round(90 + 130 * t), Math.round(180 + 60 * t)]
    }
    const t = x / (W - 1) // skin tones: shadow to highlight
    return [Math.round(120 + 120 * t), Math.round(75 + 115 * t), Math.round(55 + 100 * t)]
  }))
}
for (const f of files) {
  const png = PNG.sync.read(readFileSync(f))
  images.push({ name: basename(f), img: new ImageData(new Uint8ClampedArray(png.data), png.width, png.height) })
}
if (images.length === 0) { console.error('No images.'); process.exit(1) }

// ── S-CIELAB ─────────────────────────────────────────────────────────────────

const XYZ2OPP = [
  [ 0.2787336,  0.7218031, -0.1065520],
  [-0.4487736,  0.2898056, -0.0771569],
  [ 0.0859513, -0.5899859,  0.5011089],
]
const OPP2XYZ = invert3(XYZ2OPP)
// [spread (degrees, full width at half max), weight] per Gaussian, per opponent channel —
// separableFilters.m, weights normalised to sum 1 per channel
const SCIELAB_FILTERS: [number, number][][] = [
  [[0.05, 1.00327], [0.225, 0.114416], [7.0, -0.117686]],
  [[0.0685, 0.616725], [0.826, 0.383275]],
  [[0.0920, 0.567885], [0.6451, 0.432115]],
]
const pixelDeg = (180 / Math.PI) * (2.54 / ppi) / distanceCm
const sampPerDeg = 1 / pixelDeg

function invert3(m: number[][]): number[][] {
  const [[a, b, c], [d, e, f], [g, h, i]] = m
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g
  const det = a * A + b * B + c * C
  return [
    [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det],
  ]
}

// S-CIELAB kernels as in the reference implementation (wandell/SCIELAB-1996 separableFilters.m +
// gauss.m): each Gaussian is exp(−α²x²) with α = 2·√ln2 / (halfWidth − 1), halfWidth = spread ×
// samples-per-degree (spread = full width at half maximum, in degrees), limited to a 1° window and
// normalised to sum 1 within it. Below 224 samples/° the reference upsamples by ceil(224/spd) before
// filtering; here that's done equivalently by integrating each kernel tap over `up` sub-samples.
const MIN_SAMP_PER_DEG = 224
function scielabKernel(spreadDeg: number): { k: Float64Array; r: number } {
  const up = sampPerDeg < MIN_SAMP_PER_DEG ? Math.ceil(MIN_SAMP_PER_DEG / sampPerDeg) : 1
  const halfWidthUp = spreadDeg * sampPerDeg * up
  const alpha = 2 * Math.sqrt(Math.log(2)) / (halfWidthUp - 1)
  const r = Math.max(1, Math.floor(sampPerDeg / 2)) // 1° window
  const k = new Float64Array(2 * r + 1)
  let sum = 0
  for (let i = -r; i <= r; i++) {
    let v = 0
    for (let j = 0; j < up; j++) {
      const x = (i + (j + 0.5) / up - 0.5) * up // position in upsampled pixels
      v += Math.exp(-alpha * alpha * x * x)
    }
    k[i + r] = v; sum += v
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum
  return { k, r }
}

// Separable blur with edge renormalisation (weights outside the image are dropped).
function blur1d(src: Float64Array, w: number, h: number, horizontal: boolean, kernel: Float64Array, r: number): Float64Array {
  const out = new Float64Array(src.length)
  const len = horizontal ? w : h, lines = horizontal ? h : w
  for (let l = 0; l < lines; l++) {
    for (let p = 0; p < len; p++) {
      let s = 0, ws = 0
      const lo = Math.max(-r, -p), hi = Math.min(r, len - 1 - p)
      for (let d = lo; d <= hi; d++) {
        const q = p + d
        const k = kernel[d + r]
        s += k * src[horizontal ? l * w + q : q * w + l]; ws += k
      }
      out[horizontal ? l * w + p : p * w + l] = s / ws
    }
  }
  return out
}

const XN = 0.95047, ZN = 1.08883
const labF = (t: number) => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116

/** Per-pixel S-CIELAB-filtered CIELAB (L, a, b interleaved). */
function scielabLab(img: ImageData): Float64Array {
  const { width: w, height: h, data } = img
  const N = w * h
  const opp = [new Float64Array(N), new Float64Array(N), new Float64Array(N)]
  for (let i = 0; i < N; i++) {
    const xyz = linearToXyz(srgbToLinear(data[i * 4]), srgbToLinear(data[i * 4 + 1]), srgbToLinear(data[i * 4 + 2]))
    for (let c = 0; c < 3; c++) opp[c][i] = XYZ2OPP[c][0] * xyz[0] + XYZ2OPP[c][1] * xyz[1] + XYZ2OPP[c][2] * xyz[2]
  }
  const filtered = opp.map((ch, c) => {
    const acc = new Float64Array(N)
    for (const [spreadDeg, weight] of SCIELAB_FILTERS[c]) {
      const { k, r } = scielabKernel(spreadDeg)
      const blurred = blur1d(blur1d(ch, w, h, true, k, r), w, h, false, k, r)
      for (let i = 0; i < N; i++) acc[i] += weight * blurred[i]
    }
    return acc
  })
  const lab = new Float64Array(N * 3)
  for (let i = 0; i < N; i++) {
    const o = [filtered[0][i], filtered[1][i], filtered[2][i]]
    const X = OPP2XYZ[0][0] * o[0] + OPP2XYZ[0][1] * o[1] + OPP2XYZ[0][2] * o[2]
    const Y = OPP2XYZ[1][0] * o[0] + OPP2XYZ[1][1] * o[1] + OPP2XYZ[1][2] * o[2]
    const Z = OPP2XYZ[2][0] * o[0] + OPP2XYZ[2][1] * o[1] + OPP2XYZ[2][2] * o[2]
    const fx = labF(X / XN), fy = labF(Y), fz = labF(Z / ZN)
    lab[i * 3] = 116 * fy - 16; lab[i * 3 + 1] = 500 * (fx - fy); lab[i * 3 + 2] = 200 * (fy - fz)
  }
  return lab
}

function scoreAgainst(refLab: Float64Array, img: ImageData): { mean: number; p95: number } {
  const lab = scielabLab(img)
  const N = img.width * img.height
  const de = new Float64Array(N)
  let sum = 0
  for (let i = 0; i < N; i++) {
    const dl = lab[i * 3] - refLab[i * 3], da = lab[i * 3 + 1] - refLab[i * 3 + 1], db = lab[i * 3 + 2] - refLab[i * 3 + 2]
    de[i] = Math.sqrt(dl * dl + da * da + db * db)
    sum += de[i]
  }
  de.sort()
  return { mean: sum / N, p95: de[Math.floor(N * 0.95)] }
}

// ── Run ──────────────────────────────────────────────────────────────────────

interface Row { name: string; targetMean: number; targetP95: number; sourceMean: number; sourceP95: number; ms: number }

const cloneImg = (img: ImageData) => new ImageData(new Uint8ClampedArray(img.data), img.width, img.height)
const f2 = (n: number) => n.toFixed(2)

console.log(`# S-CIELAB benchmark\n`)
console.log(`Palette **${palette.name}** (${paletteId}) · preset **${presetName}** · ${ppi} PPI at ${distanceCm} cm (${sampPerDeg.toFixed(1)} px/°) · DBS max ${maxPasses} passes\n`)

const totals = new Map<string, Row>()

for (const { name, img } of images) {
  const target = cloneImg(img)
  applyAdjustments(target, palette, settings)
  const source = cloneImg(img)
  if (settings.compressDynamicRange) applyTuneReferenceDrc(source, palette)

  const targetLab = scielabLab(target)
  const sourceLab = scielabLab(source)

  const rows: Row[] = []
  const score = (rowName: string, out: ImageData, ms: number) => {
    const t = scoreAgainst(targetLab, out), s = scoreAgainst(sourceLab, out)
    rows.push({ name: rowName, targetMean: t.mean, targetP95: t.p95, sourceMean: s.mean, sourceP95: s.p95, ms })
  }

  let fsOut: ImageData | null = null
  for (const alg of getAllAlgorithms()) {
    const t0 = performance.now()
    const out = ditherStep(cloneImg(target), palette, { ...settings, ditherAlgorithm: alg.id })
    score(alg.name, out, performance.now() - t0)
    if (alg.id === 'floyd-steinberg') fsOut = out
  }

  // DBS refine starting from Floyd-Steinberg
  const { idx, stats } = dbsRefine(target, indicesFromMeasured(fsOut!, palette), palette, { viewingDistanceCm: distanceCm, ppi, maxPasses })
  score('DBS (from Floyd-Steinberg)', measuredFromIndices(idx, target.width, target.height, palette), stats.ms)

  rows.sort((a, b) => a.targetMean - b.targetMean)
  console.log(`## ${name} (${img.width}×${img.height})\n`)
  console.log(`DBS: ${stats.passes} passes, accepted ${stats.acceptedPerPass.join(' → ')}, E ${stats.initialE.toExponential(3)} → ${stats.finalE.toExponential(3)} (${((1 - stats.finalE / stats.initialE) * 100).toFixed(1)}% lower), σ lum ${f2(stats.sigmaLum)} px / chroma ${f2(stats.sigmaChroma)} px, ${(stats.ms / 1000).toFixed(1)} s\n`)
  printTable(rows)

  for (const r of rows) {
    const t = totals.get(r.name) ?? { name: r.name, targetMean: 0, targetP95: 0, sourceMean: 0, sourceP95: 0, ms: 0 }
    t.targetMean += r.targetMean / images.length; t.targetP95 += r.targetP95 / images.length
    t.sourceMean += r.sourceMean / images.length; t.sourceP95 += r.sourceP95 / images.length
    t.ms += r.ms / images.length
    totals.set(r.name, t)
  }
}

if (images.length > 1) {
  console.log(`## Average over ${images.length} images\n`)
  printTable([...totals.values()].sort((a, b) => a.targetMean - b.targetMean))
}

function printTable(rows: Row[]) {
  console.log('| Algorithm | ΔE vs target (mean) | p95 | ΔE vs source (mean) | p95 | ms |')
  console.log('|---|---:|---:|---:|---:|---:|')
  for (const r of rows) {
    console.log(`| ${r.name} | ${f2(r.targetMean)} | ${f2(r.targetP95)} | ${f2(r.sourceMean)} | ${f2(r.sourceP95)} | ${Math.round(r.ms)} |`)
  }
  console.log()
}
