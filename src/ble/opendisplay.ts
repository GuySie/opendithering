const SERVICE_UUID = 0x2446
const CHUNK_SIZE = 230

// Palette groups that have no matching OpenDisplay color scheme
const UNSUPPORTED_PALETTES = new Set(['acep'])

export function isSupported(paletteGroupId: string): boolean {
  return !UNSUPPORTED_PALETTES.has(paletteGroupId)
}

// Encode ideal ImageData pixels into OpenDisplay wire format.
// Pixels must already be quantized to the ideal palette (exact RGB matches).
export function encodeImage(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  paletteGroupId: string
): Uint8Array {
  const total = width * height
  const out: number[] = []

  if (paletteGroupId === 'spectra6') {
    // Scheme 4: 4 bits/pixel, 2 pixels per byte (high nibble = left pixel)
    // Color codes: black=0, white=1, yellow=2, red=3, blue=5, green=6
    let cur = 0
    let hi = true
    for (let i = 0; i < total; i++) {
      const p = i * 4
      const code = spectra6Code(pixels[p], pixels[p + 1], pixels[p + 2])
      if (hi) {
        cur = code << 4
      } else {
        out.push(cur | code)
        cur = 0
      }
      hi = !hi
    }
    if (!hi) out.push(cur)

  } else if (paletteGroupId === 'bw') {
    // Scheme 0: 1 bit/pixel, 8 pixels per byte, MSB = leftmost, white=1 black=0
    let cur = 0
    let bit = 7
    for (let i = 0; i < total; i++) {
      const p = i * 4
      if ((pixels[p] + pixels[p + 1] + pixels[p + 2]) > 382) cur |= (1 << bit)
      if (--bit < 0) { out.push(cur); cur = 0; bit = 7 }
    }
    if (bit !== 7) out.push(cur)

  } else if (paletteGroupId === 'bwr') {
    // Scheme 1: 2 bitplanes, plane1 then plane2
    // Plane1 bit=1 for white or red; plane2 bit=1 for red only
    const plane1: number[] = []
    const plane2: number[] = []
    let b1 = 0, b2 = 0, bit = 7
    for (let i = 0; i < total; i++) {
      const p = i * 4
      const r = pixels[p], g = pixels[p + 1], b = pixels[p + 2]
      const isRed = r > 200 && g < 50 && b < 50
      const isWhite = r > 200 && g > 200 && b > 200
      if (isWhite || isRed) b1 |= (1 << bit)
      if (isRed) b2 |= (1 << bit)
      if (--bit < 0) { plane1.push(b1); plane2.push(b2); b1 = 0; b2 = 0; bit = 7 }
    }
    if (bit !== 7) { plane1.push(b1); plane2.push(b2) }
    out.push(...plane1, ...plane2)

  } else if (paletteGroupId === 'bwry') {
    // Scheme 3: 2 bits/pixel, 4 pixels per byte, MSB first
    // black=0, white=1, yellow=2, red=3
    let cur = 0, pos = 0
    for (let i = 0; i < total; i++) {
      const p = i * 4
      const code = bwryCode(pixels[p], pixels[p + 1], pixels[p + 2])
      cur |= (code << (6 - pos * 2))
      if (++pos >= 4) { out.push(cur); cur = 0; pos = 0 }
    }
    if (pos > 0) out.push(cur)

  } else if (paletteGroupId === 'grayscale4') {
    // Scheme 5: 2 bits/pixel, 4 pixels per byte, MSB first
    // gray levels: 0→0, ~85→1, ~170→2, 255→3
    let cur = 0, pos = 0
    for (let i = 0; i < total; i++) {
      const p = i * 4
      const gray = (pixels[p] + pixels[p + 1] + pixels[p + 2]) / 3
      const level = Math.min(3, Math.round(gray / 85))
      cur |= (level << (6 - pos * 2))
      if (++pos >= 4) { out.push(cur); cur = 0; pos = 0 }
    }
    if (pos > 0) out.push(cur)

  } else {
    // Scheme 6: 4 bits/pixel nibble-packed (grayscale8, grayscale16)
    // Uses Rec.709 luminance → 0..15
    let cur = 0
    let hi = true
    for (let i = 0; i < total; i++) {
      const p = i * 4
      const y = 0.299 * pixels[p] + 0.587 * pixels[p + 1] + 0.114 * pixels[p + 2]
      const level = Math.min(15, Math.max(0, Math.round((y * 15) / 255)))
      if (hi) {
        cur = level << 4
      } else {
        out.push(cur | level)
        cur = 0
      }
      hi = !hi
    }
    if (!hi) out.push(cur)
  }

  return new Uint8Array(out)
}

function spectra6Code(r: number, g: number, b: number): number {
  // Ideal palette colors are exact primaries
  if (r < 10 && g < 10 && b < 10) return 0        // black
  if (r > 245 && g > 245 && b > 245) return 1     // white
  if (r > 245 && g > 245 && b < 10) return 2      // yellow
  if (r > 245 && g < 10 && b < 10) return 3       // red
  if (r < 10 && g < 10 && b > 245) return 5       // blue
  if (r < 10 && g > 245 && b < 10) return 6       // green
  // Fallback: nearest by RGB distance
  const candidates: [number, number, number, number][] = [
    [0, 0, 0, 0], [255, 255, 255, 1], [255, 255, 0, 2],
    [255, 0, 0, 3], [0, 0, 255, 5], [0, 255, 0, 6],
  ]
  let best = 0, bestDist = Infinity
  for (const [cr, cg, cb, code] of candidates) {
    const d = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2
    if (d < bestDist) { bestDist = d; best = code }
  }
  return best
}

function bwryCode(r: number, g: number, b: number): number {
  if (r < 10 && g < 10 && b < 10) return 0        // black
  if (r > 245 && g > 245 && b > 245) return 1     // white
  if (r > 245 && g > 245 && b < 10) return 2      // yellow
  if (r > 245 && g < 10 && b < 10) return 3       // red
  // Fallback: nearest
  const gray = (r + g + b) / 3
  return gray > 128 ? 1 : 0
}

// ── BLE transport ─────────────────────────────────────────────────────────────

export async function connectDevice(): Promise<BluetoothRemoteGATTCharacteristic> {
  const device = await navigator.bluetooth.requestDevice({
    filters: [{ namePrefix: 'OD' }],
    optionalServices: [SERVICE_UUID],
  })
  const server = await device.gatt!.connect()
  const service = await server.getPrimaryService(SERVICE_UUID)
  const characteristic = await service.getCharacteristic(SERVICE_UUID)
  await characteristic.startNotifications()
  return characteristic
}

export function sendImage(
  characteristic: BluetoothRemoteGATTCharacteristic,
  imageBytes: Uint8Array,
  onProgress?: (sent: number, total: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = []
    for (let i = 0; i < imageBytes.length; i += CHUNK_SIZE) {
      chunks.push(imageBytes.slice(i, i + CHUNK_SIZE))
    }

    let chunkIndex = 0
    let done = false

    const cleanup = () => {
      characteristic.removeEventListener('characteristicvaluechanged', onNotification)
    }

    const sendChunk = async () => {
      if (chunkIndex >= chunks.length) {
        // All chunks sent — send end command
        const end = new Uint8Array([0x00, 0x72])
        await characteristic.writeValueWithoutResponse(end)
        return
      }
      const chunk = chunks[chunkIndex]
      const cmd = new Uint8Array(2 + chunk.length)
      cmd[0] = 0x00
      cmd[1] = 0x71
      cmd.set(chunk, 2)
      await characteristic.writeValueWithoutResponse(cmd)
      onProgress?.(chunkIndex + 1, chunks.length)
      chunkIndex++
    }

    const onNotification = (event: Event) => {
      if (done) return
      const value = (event.target as BluetoothRemoteGATTCharacteristic).value!
      if (value.byteLength < 2) return

      const b0 = value.getUint8(0)
      const b1 = value.getUint8(1)

      // Accept both [0x00, 0xNN] and [0xNN, 0x00] byte orders
      let responseCmd: number | null = null
      if (b0 === 0x00 && (b1 >= 0x70 && b1 <= 0x74)) responseCmd = b1
      else if (b1 === 0x00 && (b0 >= 0x70 && b0 <= 0x74)) responseCmd = b0

      if (responseCmd === null) return

      if (responseCmd === 0x70) {
        // Start ack — begin sending chunks
        sendChunk().catch(err => { cleanup(); done = true; reject(err) })
      } else if (responseCmd === 0x71) {
        // Chunk ack — send next
        sendChunk().catch(err => { cleanup(); done = true; reject(err) })
      } else if (responseCmd === 0x72) {
        // End ack — display is refreshing, wait for 0x73
      } else if (responseCmd === 0x73) {
        // Refresh complete
        cleanup()
        done = true
        resolve()
      }
    }

    characteristic.addEventListener('characteristicvaluechanged', onNotification)

    // Send start command
    const start = new Uint8Array([0x00, 0x70])
    characteristic.writeValueWithoutResponse(start).catch(err => {
      cleanup()
      reject(err)
    })
  })
}
