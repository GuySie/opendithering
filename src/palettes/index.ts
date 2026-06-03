import type { Palette, PaletteGroup } from '../types'
import { bwGroup } from './bw'
import { bwrGroup } from './bwr'
import { bwryGroup } from './bwry'
import { spectra6Group } from './spectra6'
import { acepGroup } from './acep'
import { grayscale4Group, grayscale8Group, grayscale16Group } from './grayscale'

const PALETTE_GROUPS = new Map<string, PaletteGroup>()
const VARIANT_MAP    = new Map<string, Palette>()

function makeIdealVariant(group: PaletteGroup): Palette {
  return {
    id: `${group.id}-ideal`,
    name: 'Ideal',
    colors: group.variants[0].colors.map(c => ({
      name: c.name,
      measured: c.ideal,
      ideal:    c.ideal,
    })),
  }
}

function registerPaletteGroup(group: PaletteGroup): void {
  const withIdeal: PaletteGroup = { ...group, variants: [...group.variants, makeIdealVariant(group)] }
  PALETTE_GROUPS.set(group.id, withIdeal)
  for (const v of withIdeal.variants) VARIANT_MAP.set(v.id, v)
}

registerPaletteGroup(bwGroup)
registerPaletteGroup(bwrGroup)
registerPaletteGroup(bwryGroup)
registerPaletteGroup(spectra6Group)
registerPaletteGroup(acepGroup)
registerPaletteGroup(grayscale4Group)
registerPaletteGroup(grayscale8Group)
registerPaletteGroup(grayscale16Group)

export function getPaletteGroup(id: string): PaletteGroup {
  const g = PALETTE_GROUPS.get(id)
  if (!g) throw new Error(`Unknown palette group: ${id}`)
  return g
}

export function getAllPaletteGroups(): PaletteGroup[] {
  return Array.from(PALETTE_GROUPS.values())
}

export function getPaletteVariant(groupId: string, variantId: string): Palette {
  const p = VARIANT_MAP.get(variantId)
  if (!p) throw new Error(`Unknown palette variant: ${variantId} (group: ${groupId})`)
  return p
}

export function getPalette(variantId: string): Palette {
  const p = VARIANT_MAP.get(variantId)
  if (!p) throw new Error(`Unknown palette: ${variantId}`)
  return p
}
