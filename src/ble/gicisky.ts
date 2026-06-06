// BLE transfer to Gicisky e-paper devices.
// Protocol: manufacturer ID 0x5053, two-characteristic state-machine (cmd + image).
// Reference: https://github.com/eigger/hass-gicisky

// ── Constants ─────────────────────────────────────────────────────────────────

const CHUNK_SIZE = 240   // bytes per image data packet
const QLZ_CHUNK  = 64    // bytes per QuickLZ compression chunk (mode2)
const NOTIFY_DELAY_MS = 1000  // wait after startNotifications for device to be ready

// Service and characteristic UUIDs — confirmed via atc1441/ATC_GICISKY_ESL web uploader
// and consistent across all known Gicisky / Picksmart ESL models.
const SERVICE_UUID  = 0xFEF0
const CMD_UUID      = 0xFEF1   // commands out + notifications in
const IMG_UUID      = 0xFEF2   // image data out

const MANUFACTURER_ID = 0x5053

const SUPPORTED_PALETTES = new Set(['bw', 'bwr', 'bwry'])

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GiciskyDeviceInfo {
  deviceId: number
  compression: 'none' | 'mode1' | 'mode2'
  invertLuminance: boolean
}

export interface GiciskyConnection {
  cmdChar: BluetoothRemoteGATTCharacteristic
  imgChar: BluetoothRemoteGATTCharacteristic
  device: BluetoothDevice
  deviceInfo: GiciskyDeviceInfo
}

// ── Device table ──────────────────────────────────────────────────────────────
// Source: eigger/hass-gicisky devices.py

const DEVICE_TABLE: Record<number, { compression: 'none' | 'mode1' | 'mode2'; invertLuminance: boolean }> = {
  0x022B: { compression: 'mode1', invertLuminance: false },  // EPD 3.7" BWR
  0x022E: { compression: 'none',  invertLuminance: false },  // EPD 3.7" BWRY
  0x0228: { compression: 'none',  invertLuminance: false },  // EPD 3.7" BW
  0x012B: { compression: 'mode2', invertLuminance: true  },  // EPD 7.5" BWR
  0x012E: { compression: 'none',  invertLuminance: false },  // EPD 7.5" BWRY
  0x012C: { compression: 'none',  invertLuminance: false },  // EPD 7.5" BW
  0x013B: { compression: 'mode2', invertLuminance: true  },  // EPD 7.5" BWR ZP
  0x013E: { compression: 'none',  invertLuminance: false },  // EPD 7.5" BWRY ZP
  0x0136: { compression: 'none',  invertLuminance: false },  // EPD 7.5" BWRY_1
  0x008B: { compression: 'mode2', invertLuminance: false },  // EPD 10.2" BWR
  0x008E: { compression: 'none',  invertLuminance: false },  // EPD 10.2" BWRY
  0x0088: { compression: 'none',  invertLuminance: false },  // EPD 10.2" BW
  0x009B: { compression: 'mode2', invertLuminance: false },  // EPD 10.2" BWR ZP
}

function getDeviceInfo(deviceId: number): GiciskyDeviceInfo {
  const entry = DEVICE_TABLE[deviceId] ?? { compression: 'none' as const, invertLuminance: false }
  return { deviceId, ...entry }
}

// ── Public API ─────────────────────────────────────────────────────────────────

export function isSupported(paletteGroupId: string): boolean {
  return SUPPORTED_PALETTES.has(paletteGroupId)
}

// Encode already-dithered ideal ImageData into Gicisky wire format.
// Pixels must already be quantized to exact palette RGB values.
export function encodeImage(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  paletteGroupId: string,
  deviceInfo: GiciskyDeviceInfo
): Uint8Array {
  const total = width * height

  if (paletteGroupId === 'bwry') {
    // 2 bits/pixel, 4 pixels per byte MSB-first.
    // black=00, white=01, yellow=10, red=11
    const byteData: number[] = []
    let cur = 0, shift = 3
    for (let i = 0; i < total; i++) {
      const p = i * 4
      const r = pixels[p], g = pixels[p + 1], b = pixels[p + 2]
      let code: number
      if (r > 200 && g < 50 && b < 50)       code = 3  // red
      else if (r > 200 && g > 200 && b < 50) code = 2  // yellow
      else if (r > 200 && g > 200 && b > 200) code = 1  // white
      else                                     code = 0  // black
      cur |= (code << (shift * 2))
      if (--shift < 0) { byteData.push(cur); cur = 0; shift = 3 }
    }
    if (shift !== 3) byteData.push(cur)
    return new Uint8Array(byteData)  // BWRY devices never use compression in device table

  } else if (paletteGroupId === 'bwr') {
    // Dual 1-bit planes: BW plane then Red plane, 8 pixels/byte MSB-first.
    // BW plane: 1 = white (or, if invertLuminance, 1 = non-white)
    // Red plane: 1 = red
    const planeBw: number[] = []
    const planeRed: number[] = []
    let b1 = 0, b2 = 0, bit = 7
    for (let i = 0; i < total; i++) {
      const p = i * 4
      const r = pixels[p], g = pixels[p + 1], b = pixels[p + 2]
      const isWhite = r > 200 && g > 200 && b > 200
      const isRed   = r > 200 && g < 50  && b < 50
      const bwBit   = deviceInfo.invertLuminance ? !isWhite : isWhite
      if (bwBit)  b1 |= (1 << bit)
      if (isRed)  b2 |= (1 << bit)
      if (--bit < 0) { planeBw.push(b1); planeRed.push(b2); b1 = 0; b2 = 0; bit = 7 }
    }
    if (bit !== 7) { planeBw.push(b1); planeRed.push(b2) }
    return applyCompression(new Uint8Array(planeBw), new Uint8Array(planeRed), height, deviceInfo)

  } else {
    // BW: 1 bit/pixel, 8 pixels/byte MSB-first. 1 = white (or inverted: 1 = non-white)
    const planeBw: number[] = []
    let cur = 0, bit = 7
    for (let i = 0; i < total; i++) {
      const p = i * 4
      const isWhite = pixels[p] > 200 && pixels[p + 1] > 200 && pixels[p + 2] > 200
      const set = deviceInfo.invertLuminance ? !isWhite : isWhite
      if (set) cur |= (1 << bit)
      if (--bit < 0) { planeBw.push(cur); cur = 0; bit = 7 }
    }
    if (bit !== 7) planeBw.push(cur)
    return applyCompression(new Uint8Array(planeBw), null, height, deviceInfo)
  }
}

export async function connectDevice(): Promise<GiciskyConnection> {
  if (!navigator.bluetooth) throw new Error('Web Bluetooth not available')

  const device = await navigator.bluetooth.requestDevice({
    filters: [{ manufacturerData: [{ companyIdentifier: MANUFACTURER_ID }] }],
    optionalServices: [SERVICE_UUID],
  })

  const server  = await device.gatt!.connect()
  const service = await server.getPrimaryService(SERVICE_UUID)
  const cmdChar = await service.getCharacteristic(CMD_UUID)
  const imgChar = await service.getCharacteristic(IMG_UUID)

  // Try to read device ID from advertisement data to determine compression mode.
  const deviceInfo = await readDeviceInfo(device)

  await cmdChar.startNotifications()
  await delay(NOTIFY_DELAY_MS)

  return { cmdChar, imgChar, device, deviceInfo }
}

export function sendImage(
  conn: GiciskyConnection,
  imageBytes: Uint8Array,
  onProgress?: (sent: number, total: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const { cmdChar, imgChar, deviceInfo } = conn
    const packetSize = imageBytes.length

    // Block size is reported by the device in the start ack as a 2-byte LE value.
    // Total block = 4 (part index header) + payload, so payload = blockSize - 4.
    // Default 244 (= 0x00F4) matches what all known devices report.
    let chunkSize = CHUNK_SIZE
    let totalChunks = Math.ceil(packetSize / chunkSize)

    type State = 'start' | 'size' | 'image' | 'imageData'
    let state: State = 'start'
    let part = 0
    let lastPart = -1
    let samePartCount = 0
    let done = false
    let timeoutId: ReturnType<typeof setTimeout>

    const cleanup = () => {
      clearTimeout(timeoutId)
      cmdChar.removeEventListener('characteristicvaluechanged', onNotify)
    }

    const fail = (err: Error) => {
      if (done) return
      done = true
      cleanup()
      reject(err)
    }

    const succeed = () => {
      if (done) return
      done = true
      cleanup()
      resolve()
    }

    const resetTimeout = () => {
      clearTimeout(timeoutId)
      timeoutId = setTimeout(() => fail(new Error('Gicisky BLE timeout')), 5000)
    }

    const makeCmdPacket = (cmd: number): Uint8Array<ArrayBuffer> => {
      if (cmd === 0x02) {
        if (deviceInfo.compression === 'mode2') {
          const pkt = new Uint8Array(new ArrayBuffer(6))
          pkt[0] = 0x02
          new DataView(pkt.buffer).setUint32(1, packetSize, true)
          pkt[5] = 0x01
          return pkt
        }
        const pkt = new Uint8Array(new ArrayBuffer(8))
        pkt[0] = 0x02
        new DataView(pkt.buffer).setUint32(1, packetSize, true)
        return pkt
      }
      const b = new Uint8Array(new ArrayBuffer(1)); b[0] = cmd; return b
    }

    const makeImagePacket = (partIdx: number): Uint8Array<ArrayBuffer> => {
      const start = partIdx * chunkSize
      const len = Math.min(chunkSize, packetSize - start)
      const pkt = new Uint8Array(new ArrayBuffer(4 + len))
      new DataView(pkt.buffer).setUint32(0, partIdx, true)
      for (let i = 0; i < len; i++) pkt[4 + i] = imageBytes[start + i]
      return pkt
    }

    const advance = async () => {
      resetTimeout()
      if (state === 'start') {
        await cmdChar.writeValueWithoutResponse(makeCmdPacket(0x01))
      } else if (state === 'size') {
        await cmdChar.writeValueWithoutResponse(makeCmdPacket(0x02))
      } else if (state === 'image') {
        await cmdChar.writeValueWithoutResponse(makeCmdPacket(0x03))
      } else {
        await imgChar.writeValueWithoutResponse(makeImagePacket(part))
        onProgress?.(part, totalChunks)
      }
    }

    const onNotify = async (event: Event) => {
      if (done) return
      const value = (event.target as BluetoothRemoteGATTCharacteristic).value!
      const b = (i: number) => value.getUint8(i)

      try {
        if (state === 'start') {
          if (value.byteLength < 3 || b(0) !== 0x01)
            return fail(new Error('Gicisky: unexpected start response'))
          // Bytes 1-2 are the block size (LE). Payload = blockSize - 4 (part index header).
          const blockSize = b(1) | (b(2) << 8)
          if (blockSize > 4) {
            chunkSize = blockSize - 4
            totalChunks = Math.ceil(packetSize / chunkSize)
          }
          state = 'size'
          await advance()

        } else if (state === 'size') {
          if (value.byteLength < 1 || b(0) !== 0x02)
            return fail(new Error('Gicisky: unexpected size response'))
          state = 'image'
          await advance()

        } else if (state === 'image') {
          if (value.byteLength < 6 || b(0) !== 0x05 || b(1) !== 0x00)
            return fail(new Error('Gicisky: unexpected image-start response'))
          state = 'imageData'
          part = 0
          await advance()

        } else {
          // imageData: device acks with [0x05, status, next_part LE4B]
          if (value.byteLength < 2 || b(0) !== 0x05) return succeed()
          if (b(1) !== 0x00) return succeed()  // non-zero status = done
          if (value.byteLength < 6) return succeed()

          const newPart = new DataView(value.buffer, value.byteOffset + 2, 4).getUint32(0, true)
          if (newPart === lastPart) {
            if (++samePartCount >= 3) return fail(new Error('Gicisky: transfer stalled'))
          } else {
            samePartCount = 1
            lastPart = newPart
          }
          part = newPart
          if (part >= totalChunks) return succeed()
          await advance()
        }
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)))
      }
    }

    cmdChar.addEventListener('characteristicvaluechanged', onNotify)
    advance().catch(fail)
  })
}

// ── Compression ───────────────────────────────────────────────────────────────

function applyCompression(
  bwData: Uint8Array,
  redData: Uint8Array | null,
  height: number,
  deviceInfo: GiciskyDeviceInfo
): Uint8Array {
  if (deviceInfo.compression === 'mode1') {
    return compressMode1(bwData, redData, height)
  }
  if (deviceInfo.compression === 'mode2') {
    return compressMode2(bwData, redData)
  }
  // none: concatenate planes
  if (!redData) return bwData
  const out = new Uint8Array(bwData.length + redData.length)
  out.set(bwData)
  out.set(redData, bwData.length)
  return out
}

// Column-chunked format used by 3.7" EPD (compression=True in HA).
// Each column of the BW (and optionally red) plane is wrapped with a 7-byte header.
function compressMode1(bwData: Uint8Array, redData: Uint8Array | null, height: number): Uint8Array {
  const bytePerLine = height >> 3  // bits per column / 8
  const numCols = bwData.length / bytePerLine  // should equal width

  const chunks: number[] = [0, 0, 0, 0]  // 4-byte LE total_len placeholder

  const addPlane = (data: Uint8Array) => {
    let pos = 0
    for (let col = 0; col < numCols; col++) {
      // Header: [0x75][byte_per_line+7][byte_per_line][0x00 x4]
      chunks.push(0x75, bytePerLine + 7, bytePerLine, 0, 0, 0, 0)
      for (let i = 0; i < bytePerLine; i++) chunks.push(data[pos++])
    }
  }

  addPlane(bwData)
  if (redData) addPlane(redData)

  const totalLen = chunks.length
  chunks[0] = totalLen & 0xFF
  chunks[1] = (totalLen >> 8) & 0xFF
  chunks[2] = (totalLen >> 16) & 0xFF
  chunks[3] = (totalLen >> 24) & 0xFF
  return new Uint8Array(chunks)
}

// Split-half chunked format used by 7.5" and 10.2" EPD (compression2=True in HA).
// Data is split in half; each half is wrapped in 64-byte uncompressed chunks.
// The HA integration currently uses force_raw=True (no QuickLZ) — we do the same.
function compressMode2(bwData: Uint8Array, redData: Uint8Array | null): Uint8Array {
  const rawLen = bwData.length + (redData?.length ?? 0)
  const raw = new Uint8Array(rawLen)
  raw.set(bwData)
  if (redData) raw.set(redData, bwData.length)

  const split  = Math.floor(rawLen / 2)
  const part1  = raw.slice(0, split)
  const part2  = raw.slice(split)
  const cp1    = chunkUncompressed(part1)
  const cp2    = chunkUncompressed(part2)

  // [4B LE part2 original length] + compressed_part1 + compressed_part2
  const out = new Uint8Array(4 + cp1.length + cp2.length)
  new DataView(out.buffer).setUint32(0, part2.length, true)
  out.set(cp1, 4)
  out.set(cp2, 4 + cp1.length)
  return out
}

// Wrap data in 64-byte uncompressed chunks: [0x74][total_len][n][...data]
function chunkUncompressed(data: Uint8Array): Uint8Array {
  const chunks: number[] = []
  for (let i = 0; i < data.length; i += QLZ_CHUNK) {
    const slice = data.slice(i, i + QLZ_CHUNK)
    const n = slice.length
    chunks.push(0x74, 3 + n, n, ...slice)
  }
  return new Uint8Array(chunks)
}

// ── Advertisement → device info ───────────────────────────────────────────────

// Reads Gicisky manufacturer advertisement data to identify the device model.
// Returns a fallback (compression=none) if the advertisement cannot be read.
async function readDeviceInfo(device: BluetoothDevice): Promise<GiciskyDeviceInfo> {
  if (typeof device.watchAdvertisements !== 'function') {
    return { deviceId: 0, compression: 'none', invertLuminance: false }
  }
  return new Promise(resolve => {
    const fallback = { deviceId: 0, compression: 'none' as const, invertLuminance: false }
    const tid = setTimeout(() => {
      device.removeEventListener('advertisementreceived', handler as EventListener)
      resolve(fallback)
    }, 3000)

    const handler = (event: Event) => {
      clearTimeout(tid)
      device.removeEventListener('advertisementreceived', handler as EventListener)
      try {
        const mfr = (event as BluetoothAdvertisingEvent).manufacturerData?.get(MANUFACTURER_ID)
        if (!mfr || mfr.byteLength < 5) { resolve(fallback); return }
        const data = new Uint8Array(mfr.buffer, mfr.byteOffset, mfr.byteLength)
        const deviceId = ((data[4] << 8) | data[0]) & 0x3FFF
        resolve(getDeviceInfo(deviceId))
      } catch {
        resolve(fallback)
      }
    }

    device.addEventListener('advertisementreceived', handler as EventListener)
    device.watchAdvertisements().catch(() => {
      clearTimeout(tid)
      device.removeEventListener('advertisementreceived', handler as EventListener)
      resolve(fallback)
    })
  })
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
