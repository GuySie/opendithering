import { parseHexKey, deriveSessionKey, deriveSessionId, computeChallengeResponse, encryptCommand } from './crypto'

const SERVICE_UUID = 0x2446
const CHUNK_SIZE = 230
const ENCRYPTED_CHUNK_SIZE = 154  // cmd(2)+nonce(16)+len(1)+data(154)+tag(12) = 185 bytes

// Palette groups that have no matching OpenDisplay color scheme
const UNSUPPORTED_PALETTES = new Set(['acep'])

export interface BleSession {
  characteristic: BluetoothRemoteGATTCharacteristic
  sessionKeyBytes: Uint8Array | null
  sessionId: Uint8Array | null
  counter: number
}

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

// Waits for a BLE notification that satisfies `parse`, within `timeoutMs`.
// `parse` returns a value (including null/false truthy checks don't apply —
// return undefined to indicate "keep waiting", throw to reject).
function waitForNotification<T>(
  characteristic: BluetoothRemoteGATTCharacteristic,
  parse: (bytes: Uint8Array) => T | undefined,
  timeoutMs: number,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let done = false

    const timer = setTimeout(() => {
      if (done) return
      done = true; cleanup()
      reject(new Error('Timed out waiting for device response'))
    }, timeoutMs)

    function cleanup() {
      clearTimeout(timer)
      characteristic.removeEventListener('characteristicvaluechanged', onNotify)
    }

    function onNotify(event: Event) {
      if (done) return
      const dv = (event.target as BluetoothRemoteGATTCharacteristic).value!
      const bytes = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength)
      try {
        const result = parse(bytes)
        if (result !== undefined) {
          done = true; cleanup()
          resolve(result)
        }
      } catch (err) {
        done = true; cleanup()
        reject(err)
      }
    }

    characteristic.addEventListener('characteristicvaluechanged', onNotify)
  })
}

// Runs the two-step CMAC challenge-response authentication (command 0x0050).
// Returns the session key and session ID to use for subsequent encrypted commands.
// Throws if the key is wrong or the device does not have encryption configured.
export async function authenticate(
  characteristic: BluetoothRemoteGATTCharacteristic,
  masterKeyHex: string,
): Promise<{ sessionKeyBytes: Uint8Array; sessionId: Uint8Array }> {
  const masterKeyBytes = parseHexKey(masterKeyHex)

  // Step 1: send [0x00 0x50 0x00] → receive server_nonce(16) + optional device_id(4)
  await characteristic.writeValueWithoutResponse(new Uint8Array([0x00, 0x50, 0x00]))

  const { serverNonce, deviceId } = await waitForNotification(
    characteristic,
    (bytes) => {
      if (bytes.length < 3) return undefined
      const cmd = (bytes[0] << 8) | bytes[1]
      if ((cmd & ~0x8000) !== 0x0050) return undefined
      const status = bytes[2]
      if (status === 0x02) throw new Error('Device already has an active session — reconnect and try again')
      if (status === 0x03) throw new Error('This device does not have encryption configured')
      if (status === 0x04) throw new Error('Authentication rate limited — wait before retrying')
      if (status !== 0x00) throw new Error(`Auth challenge failed (status 0x${status.toString(16).padStart(2, '0')})`)
      if (bytes.length < 19) return undefined
      return {
        serverNonce: bytes.slice(3, 19),
        deviceId: bytes.length >= 23 ? bytes.slice(19, 23) : new Uint8Array([0x00, 0x00, 0x00, 0x01]),
      }
    },
    5000,
  )

  // Step 2: send [0x00 0x50][client_nonce:16][CMAC(master_key, server_nonce||client_nonce||device_id):16]
  const clientNonce = crypto.getRandomValues(new Uint8Array(16))
  const challengeResp = await computeChallengeResponse(masterKeyBytes, serverNonce, clientNonce, deviceId)

  const step2 = new Uint8Array(2 + 16 + 16)
  step2[0] = 0x00; step2[1] = 0x50
  step2.set(clientNonce, 2)
  step2.set(challengeResp, 18)
  await characteristic.writeValueWithoutResponse(step2)

  await waitForNotification(
    characteristic,
    (bytes) => {
      if (bytes.length < 3) return undefined
      const cmd = (bytes[0] << 8) | bytes[1]
      if ((cmd & ~0x8000) !== 0x0050) return undefined
      const status = bytes[2]
      if (status === 0x01) throw new Error('Wrong encryption key — check the key shown on your device')
      if (status === 0x04) throw new Error('Authentication rate limited — wait before retrying')
      if (status !== 0x00) throw new Error(`Authentication failed (status 0x${status.toString(16).padStart(2, '0')})`)
      return true
    },
    5000,
  )

  const sessionKeyBytes = await deriveSessionKey(masterKeyBytes, clientNonce, serverNonce, deviceId)
  const sessionId = await deriveSessionId(sessionKeyBytes, clientNonce, serverNonce)

  return { sessionKeyBytes, sessionId }
}

const REFRESH_TIMEOUT_MS = 30_000

export function sendImage(
  session: BleSession,
  imageBytes: Uint8Array,
  onProgress?: (sent: number, total: number) => void,
  signal?: AbortSignal
): Promise<void> {
  const { characteristic } = session
  const encrypted = session.sessionKeyBytes !== null && session.sessionId !== null
  const chunkSize = encrypted ? ENCRYPTED_CHUNK_SIZE : CHUNK_SIZE

  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = []
    for (let i = 0; i < imageBytes.length; i += chunkSize) {
      chunks.push(imageBytes.slice(i, i + chunkSize))
    }

    let chunkIndex = 0
    let done = false
    let refreshTimer: ReturnType<typeof setTimeout> | null = null

    const cleanup = () => {
      characteristic.removeEventListener('characteristicvaluechanged', onNotification)
      if (refreshTimer !== null) { clearTimeout(refreshTimer); refreshTimer = null }
      signal?.removeEventListener('abort', onAbort)
    }

    const onAbort = () => {
      if (done) return
      cleanup(); done = true
      reject(new Error('BLE device disconnected'))
    }

    if (signal) {
      if (signal.aborted) { reject(new Error('BLE device disconnected')); return }
      signal.addEventListener('abort', onAbort)
    }

    // Build a command packet, encrypting when a session is active.
    // For encrypted commands, payload is wrapped as [len:1][payload] inside CCM.
    async function buildCmd(cmdHi: number, cmdLo: number, payload: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
      if (!encrypted) {
        const cmd = new Uint8Array(2 + payload.length)
        cmd[0] = cmdHi; cmd[1] = cmdLo
        cmd.set(payload, 2)
        return cmd
      }
      return encryptCommand(
        session.sessionKeyBytes!,
        session.sessionId!,
        session.counter++,
        [cmdHi, cmdLo],
        payload,
      )
    }

    const sendChunk = async () => {
      if (chunkIndex >= chunks.length) {
        // All chunks sent — send end command (refresh_mode=0 when encrypted)
        const endPayload = encrypted ? new Uint8Array([0x00]) : new Uint8Array()
        const end = await buildCmd(0x00, 0x72, endPayload)
        await characteristic.writeValueWithoutResponse(end)
        refreshTimer = setTimeout(() => {
          if (done) return
          cleanup(); done = true
          reject(new Error('Display refresh timed out'))
        }, REFRESH_TIMEOUT_MS)
        return
      }
      const chunk = chunks[chunkIndex]
      const cmd = await buildCmd(0x00, 0x71, chunk)
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

      // For encrypted sessions the command bytes (0-1) are always in cleartext.
      // Accept both [0x00, 0xNN] and [0xNN, 0x00] byte orders.
      let responseCmd: number | null = null
      if (b0 === 0x00 && (b1 >= 0x70 && b1 <= 0x74)) responseCmd = b1
      else if (b1 === 0x00 && (b0 >= 0x70 && b0 <= 0x74)) responseCmd = b0

      if (responseCmd === null) return

      if (responseCmd === 0x70) {
        sendChunk().catch(err => { cleanup(); done = true; reject(err) })
      } else if (responseCmd === 0x71) {
        sendChunk().catch(err => { cleanup(); done = true; reject(err) })
      } else if (responseCmd === 0x72) {
        // End ack — display is refreshing, wait for 0x73
      } else if (responseCmd === 0x73) {
        cleanup(); done = true; resolve()
      }
    }

    characteristic.addEventListener('characteristicvaluechanged', onNotification)

    buildCmd(0x00, 0x70, new Uint8Array()).then(start => {
      characteristic.writeValueWithoutResponse(start).catch(err => {
        cleanup(); reject(err)
      })
    }).catch(err => {
      cleanup(); reject(err)
    })
  })
}
