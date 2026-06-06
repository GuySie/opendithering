import type { DisplayPreset } from '../types'

export const DISPLAY_PRESETS: DisplayPreset[] = [
  { id: 'seeed-reterminal-e1001',     name: 'reTerminal E1001',         manufacturer: 'Seeed Studio',  width: 800,  height: 480,  paletteGroupId: 'bw' },
  { id: 'seeed-reterminal-e1002',     name: 'reTerminal E1002',         manufacturer: 'Seeed Studio',  width: 800,  height: 480,  paletteGroupId: 'spectra6' },
  { id: 'seeed-reterminal-e1003',     name: 'reTerminal E1003',         manufacturer: 'Seeed Studio',  width: 1872, height: 1404, paletteGroupId: 'grayscale16' },
  { id: 'seeed-reterminal-e1004',     name: 'reTerminal E1004',         manufacturer: 'Seeed Studio',  width: 1600, height: 1200, paletteGroupId: 'spectra6' },
  { id: 'trmnl-og',                    name: 'TRMNL OG',                  manufacturer: 'TRMNL',         width: 800,  height: 480,  paletteGroupId: 'bw' },
  { id: 'trmnl-og-2bpp',              name: 'TRMNL OG (2bpp)',           manufacturer: 'TRMNL',         width: 800,  height: 480,  paletteGroupId: 'grayscale4' },
  { id: 'trmnl-x',                    name: 'TRMNL X',                   manufacturer: 'TRMNL',         width: 1872, height: 1404, paletteGroupId: 'grayscale16' },
  { id: 'xteink-x4',                   name: 'X4',                        manufacturer: 'Xteink',        width: 800,  height: 480,  paletteGroupId: 'grayscale4' },
  { id: 'waveshare-photopainter-e6',   name: 'PhotoPainter (E6)',         manufacturer: 'Waveshare',     width: 800, height: 480, paletteGroupId: 'spectra6' },
  { id: 'waveshare-photopainter-acep', name: 'PhotoPainter (ACeP)',       manufacturer: 'Waveshare',     width: 800, height: 480, paletteGroupId: 'acep' },
  { id: 'pimoroni-impression-40-acep', name: 'Inky Impression 4.0" (ACeP)', manufacturer: 'Pimoroni', width: 640, height: 400, paletteGroupId: 'acep' },
  { id: 'pimoroni-impression-40-s6',   name: 'Inky Impression 4.0" (E6)', manufacturer: 'Pimoroni', width: 640, height: 400, paletteGroupId: 'spectra6' },
  { id: 'pimoroni-impression-565',    name: 'Inky Impression 5.7"',      manufacturer: 'Pimoroni',      width: 600, height: 448, paletteGroupId: 'acep' },
  { id: 'pimoroni-impression-73',     name: 'Inky Impression 7.3"',      manufacturer: 'Pimoroni',      width: 800, height: 480, paletteGroupId: 'spectra6' },
  { id: 'pimoroni-impression-133',    name: 'Inky Impression 13.3"',     manufacturer: 'Pimoroni',      width: 1600, height: 1200, paletteGroupId: 'spectra6' },
  { id: 'm5stack-paper',                name: 'M5Paper',                   manufacturer: 'M5Stack',       width: 960,  height: 540,  paletteGroupId: 'grayscale16' },
  { id: 'inkplate-6',                  name: 'Inkplate 6',                manufacturer: 'Soldered',      width: 800,  height: 600,  paletteGroupId: 'bw' },
  { id: 'inkplate-6-3bpp',             name: 'Inkplate 6 (3bpp)',         manufacturer: 'Soldered',      width: 800,  height: 600,  paletteGroupId: 'grayscale8' },
  { id: 'inkplate-10',                 name: 'Inkplate 10',               manufacturer: 'Soldered',      width: 1200, height: 825,  paletteGroupId: 'bw' },
  { id: 'inkplate-10-3bpp',            name: 'Inkplate 10 (3bpp)',        manufacturer: 'Soldered',      width: 1200, height: 825,  paletteGroupId: 'grayscale8' },
  { id: 'inkplate-6color',             name: 'Inkplate 6COLOR',           manufacturer: 'Soldered',      width: 600,  height: 448,  paletteGroupId: 'acep' },
  { id: 'gicisky-esl-21',              name: 'ESL 2.1"',                  manufacturer: 'Gicisky',       width: 128,  height: 250,  paletteGroupId: 'bwr' },
  { id: 'gicisky-esl-29',              name: 'ESL 2.9" BWR',              manufacturer: 'Gicisky',       width: 128,  height: 296,  paletteGroupId: 'bwr' },
  { id: 'gicisky-esl-29-bwry',         name: 'ESL 2.9" BWRY',             manufacturer: 'Gicisky',       width: 128,  height: 296,  paletteGroupId: 'bwry' },
  { id: 'gicisky-esl-37',              name: 'ESL 3.7"',                  manufacturer: 'Gicisky',       width: 240,  height: 416,  paletteGroupId: 'bwr' },
  { id: 'gicisky-esl-42',              name: 'ESL 4.2" BWR',              manufacturer: 'Gicisky',       width: 400,  height: 300,  paletteGroupId: 'bwr' },
  { id: 'gicisky-esl-42-bwry',         name: 'ESL 4.2" BWRY',             manufacturer: 'Gicisky',       width: 400,  height: 300,  paletteGroupId: 'bwry' },
  { id: 'gicisky-esl-75',              name: 'ESL 7.5"',                  manufacturer: 'Gicisky',       width: 800,  height: 480,  paletteGroupId: 'bwr' },
  { id: 'gicisky-esl-102',             name: 'ESL 10.2"',                 manufacturer: 'Gicisky',       width: 960,  height: 640,  paletteGroupId: 'bwr' },
  { id: 'solum-m3-16-bwr',             name: 'M3 1.6" BWR',               manufacturer: 'Solum',         width: 200,  height: 200,  paletteGroupId: 'bwr' },
  { id: 'solum-m3-27-bwr',             name: 'M3 2.7" BWR',               manufacturer: 'Solum',         width: 200,  height: 300,  paletteGroupId: 'bwr' },
  { id: 'solum-m3-29-bwr',             name: 'M3 2.9" BWR',               manufacturer: 'Solum',         width: 168,  height: 384,  paletteGroupId: 'bwr' },
  { id: 'solum-m3-26-bwry',            name: 'M3 2.6" BWRY',              manufacturer: 'Solum',         width: 184,  height: 360,  paletteGroupId: 'bwry' },
  { id: 'solum-m3-35-bwry',            name: 'M3 3.5" BWRY',              manufacturer: 'Solum',         width: 184,  height: 384,  paletteGroupId: 'bwry' },
  { id: 'solum-m3-42-bwry',            name: 'M3 4.2" BWRY',              manufacturer: 'Solum',         width: 400,  height: 300,  paletteGroupId: 'bwry' },
  { id: 'custom',                     name: 'Custom',                    manufacturer: '',              width: 800, height: 480, paletteGroupId: 'spectra6' },
]

export function getPreset(id: string): DisplayPreset | undefined {
  return DISPLAY_PRESETS.find(p => p.id === id)
}
