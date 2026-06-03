import type { DisplayPreset } from '../types'

export const DISPLAY_PRESETS: DisplayPreset[] = [
  { id: 'seeed-reterminal-e1002',     name: 'reTerminal E1002',         manufacturer: 'Seeed Studio',  width: 800,  height: 480,  paletteGroupId: 'spectra6' },
  { id: 'seeed-reterminal-e1003',     name: 'reTerminal E1003',         manufacturer: 'Seeed Studio',  width: 1404, height: 1872, paletteGroupId: 'grayscale16' },
  { id: 'waveshare-73-acep',          name: '7.3" Gallery (ACeP)',       manufacturer: 'Waveshare',     width: 800, height: 480, paletteGroupId: 'acep' },
  { id: 'waveshare-565-acep',         name: '5.65" Gallery (ACeP)',      manufacturer: 'Waveshare',     width: 600, height: 448, paletteGroupId: 'acep' },
  { id: 'pimoroni-impression-73',     name: 'Inky Impression 7.3"',      manufacturer: 'Pimoroni',      width: 800, height: 480, paletteGroupId: 'acep' },
  { id: 'pimoroni-impression-565',    name: 'Inky Impression 5.7"',      manufacturer: 'Pimoroni',      width: 600, height: 448, paletteGroupId: 'acep' },
  { id: 'waveshare-27-bwr',           name: '2.7" BWR',                  manufacturer: 'Waveshare',     width: 264, height: 176, paletteGroupId: 'bwr' },
  { id: 'waveshare-42-bw',            name: '4.2" BW',                   manufacturer: 'Waveshare',     width: 400, height: 300, paletteGroupId: 'bw' },
  { id: 'waveshare-213-bw',           name: '2.13" BW',                  manufacturer: 'Waveshare',     width: 250, height: 122, paletteGroupId: 'bw' },
  { id: 'custom',                     name: 'Custom',                    manufacturer: '',              width: 800, height: 480, paletteGroupId: 'spectra6' },
]

export function getPreset(id: string): DisplayPreset | undefined {
  return DISPLAY_PRESETS.find(p => p.id === id)
}
