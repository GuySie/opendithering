import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const { PNG } = createRequire(new URL('../../package.json', import.meta.url).pathname)('pngjs')
class ID { data: Uint8ClampedArray; width: number; height: number; constructor(a: any, b?: number, c?: number) { if (typeof a === 'number') { this.width = a; this.height = b!; this.data = new Uint8ClampedArray(a * b! * 4) } else { this.data = a; this.width = b!; this.height = c ?? a.length / 4 / b! } } }
;(globalThis as any).ImageData = ID
let rs = 1; Math.random = () => { rs = (rs * 1664525 + 1013904223) >>> 0; return rs / 4294967296 }
const { getPaletteVariant } = await import('../../src/palettes/index')
const { applyAdjustments, ditherStep } = await import('../../src/processing/pipeline')
const { PRE_DBS_PRESET } = await import('../../src/types')
const dbs = await import('../../src/dithering/dbs')
// Usage: npx tsx scripts/mixing/gen-flat.mts <out dir> <name> <r> <g> <b>
// A flat source colour through Pre-DBS + DBS refine (guysie 7.09", 282 PPI, 40 cm, 10 passes), saved full-screen in nominal ink colours.
// MIXING=1 uses the palette's measured mixing model (model-based DBS).
const [, , OUT, name, r, g, b] = process.argv
const W = 1200, H = 1600
const pal = getPaletteVariant('spectra6', 'spectra6-guysie-7in09')
const img = new ID(W, H) as any as ImageData
for (let i = 0; i < W * H; i++) img.data.set([+r, +g, +b, 255], i * 4)
applyAdjustments(img, pal, PRE_DBS_PRESET)
const target = [img.data[0], img.data[1], img.data[2]]
const d = ditherStep(img, pal, PRE_DBS_PRESET)
const res = dbs.dbsRefine(img, dbs.indicesFromMeasured(d, pal), pal, { viewingDistanceCm: 40, ppi: Math.hypot(W, H) / 7.09, maxPasses: 10, useMixing: process.env.MIXING === '1' })
const o = new PNG({ width: W, height: H })
for (let i = 0; i < W * H; i++) { const c = pal.colors[res.idx[i]].ideal; o.data[i * 4] = c[0]; o.data[i * 4 + 1] = c[1]; o.data[i * 4 + 2] = c[2]; o.data[i * 4 + 3] = 255 }
writeFileSync(OUT + '/' + name + '.png', PNG.sync.write(o))
const counts: Record<string, number> = {}; for (const k of res.idx) counts[pal.colors[k].name] = (counts[pal.colors[k].name] ?? 0) + 1
writeFileSync(OUT + '/' + name + '.json', JSON.stringify({ source: [+r, +g, +b], target, inks: Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, v / (W * H)])) }))
console.log(name, 'target', target.join(','), Object.entries(counts).map(([k, v]) => k + ' ' + (100 * v / (W * H)).toFixed(0) + '%').join(' '))
