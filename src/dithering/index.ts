import type { DitheringAlgorithm } from '../types'
import { floydSteinberg } from './floyd-steinberg'
import { atkinson } from './atkinson'
import { jarvis } from './jarvis'
import { stucki } from './stucki'
import { burkes } from './burkes'
import { sierra } from './sierra'
import { bayer4, bayer8 } from './bayer'
import { blueNoise } from './blue-noise'
import { yliluoma2, yliluoma2BlueNoise } from './yliluoma2'
import { riemersma } from './riemersma'
import { dizzy } from './dizzy'
import { knoxDithering } from './knox'

const registry = new Map<string, DitheringAlgorithm>()

function register(a: DitheringAlgorithm) { registry.set(a.id, a) }

register(bayer4)
register(bayer8)
register(floydSteinberg)
register(jarvis)
register(stucki)
register(atkinson)
register(burkes)
register(sierra)
register(knoxDithering)
register(blueNoise)
register(riemersma)
register(yliluoma2)
register(yliluoma2BlueNoise)
register(dizzy)

export function getAlgorithm(id: string): DitheringAlgorithm {
  const a = registry.get(id)
  if (!a) throw new Error(`Unknown dithering algorithm: ${id}`)
  return a
}

export function getAllAlgorithms(): DitheringAlgorithm[] {
  return Array.from(registry.values())
}
