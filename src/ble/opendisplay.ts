import { OdAuthError, authenticate } from './opendisplay-crypto'
import { OdDisconnectedError, OdEncryptionRequiredError, OdLink, OdSessionEndedError, OdTimeoutError, hex, isAck, isNack } from './opendisplay-link'
import { negotiatePipe, pipeWrite } from './opendisplay-pipe'

const SERVICE_UUID = 0x2446

// Opcodes (opendisplay-protocol, src/opendisplay_protocol.h)
const CMD_CONFIG_READ = 0x0040
const CMD_FIRMWARE_VERSION = 0x0043
const CMD_DIRECT_WRITE_START = 0x0070
const CMD_DIRECT_WRITE_DATA = 0x0071
const CMD_DIRECT_WRITE_END = 0x0072
const RESP_REFRESH_SUCCESS = 0x73
const RESP_REFRESH_TIMEOUT = 0x74
// Echo bytes a direct-write exchange can answer with; [0xFF][0xFF] is older
// firmware's compressed-start rejection.
const DIRECT_WRITE_ECHOES = [0x70, 0x71, 0x72, RESP_REFRESH_SUCCESS, RESP_REFRESH_TIMEOUT, 0xFF]

// Direct-write data bytes per 0x71 frame. Encrypted: the envelope adds
// cmd(2)+nonce(16)+len(1)+tag(12) = 31 bytes, and packets must stay <= 185.
const CHUNK_SIZE = 230
const ENCRYPTED_CHUNK_SIZE = 154
// Compressed START carries [uncompressed_size:4 LE][first zlib bytes] within
// these limits (plaintext / encrypted); the rest follows in 0x71 chunks.
const MAX_START_PAYLOAD = 200
const MAX_START_PAYLOAD_ENCRYPTED = 154
// Firmware without streaming decompression buffers the whole zlib stream (~50 KB).
const MAX_BUFFERED_COMPRESSED_SIZE = 50 * 1024
// The firmware's inflater is built with a 512-byte window and rejects zlib
// headers advertising more. The browser's CompressionStream always uses a
// 15-bit window, hence pako.
const ZLIB_WINDOW_BITS = 9

// Timeouts. Data ACKs, the END ACK and the refresh can each block on a slow
// SPI write or panel refresh (up to ~60 s on Spectra/ACeP); py-opendisplay
// allows 90 s for all three.
// Replies to the connect-time commands. Firmware that idles between commands
// (older builds and low-power configs, e.g. nRF with a long sleep_timeout)
// only looks at a new command after its idle wait: ~10 s per reply has been
// seen. A reply that still comes late is skipped by later reads.
const TIMEOUT_CONNECT_REPLY = 30_000
const TIMEOUT_START = 15_000
const TIMEOUT_DATA_ACK = 90_000
const TIMEOUT_END_ACK = 90_000
const TIMEOUT_REFRESH = 90_000

const SCHEME_SPECTRA6 = 4
const SCHEME_SPECTRA6_SPLIT = 8

// OpenDisplay color scheme (display config `color_scheme`) for each palette group
const PALETTE_SCHEMES: Record<string, number> = {
  bw: 0,
  bwr: 1,
  bwry: 3,
  spectra6: 4,
  grayscale4: 5,
  acep: 7,
  grayscale8: 6,
  grayscale16: 6,
}

export function isSupported(paletteGroupId: string): boolean {
  return paletteGroupId in PALETTE_SCHEMES
}

// Encode ideal ImageData pixels into OpenDisplay wire format.
// Pixels must already be quantized to the ideal palette (exact RGB matches).
// Every row starts on a byte boundary (the firmware and py-opendisplay both
// row-pad), so panels whose width isn't a multiple of the packing factor
// (e.g. the 122-px EP213) don't get their rows shifted.
//
// `deviceScheme` is the connected device's configured color scheme, if known.
// It only changes the layout for split Spectra 6 panels (scheme 8).
// `panelIc` is the device's panel IC type, if known. It selects the per-panel
// code tables for BWRY and 4-grey; unknown panels get the common tables.
export function encodeImage(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  paletteGroupId: string,
  deviceScheme?: number,
  panelIc?: number
): Uint8Array {
  if (paletteGroupId === 'spectra6') {
    // Scheme 4: 4 bits/pixel, high nibble = left pixel
    // Color codes: black=0, white=1, yellow=2, red=3, blue=5, green=6
    if (deviceScheme === SCHEME_SPECTRA6_SPLIT) {
      // Scheme 8: same codes, but panels driven by two controllers (e.g. the
      // 13.3" reTerminal E1004) take the left half of every row first, then
      // the right half, so each controller's data arrives in one run. Sent as
      // plain rows, the top of the image lands on the left half and the
      // bottom on the right.
      const mid = Math.floor(width / 2)
      const left = packRows(pixels, width, height, 4, spectra6Code, 0, mid)
      const right = packRows(pixels, width, height, 4, spectra6Code, mid, width)
      const out = new Uint8Array(left.length + right.length)
      out.set(left, 0)
      out.set(right, left.length)
      return out
    }
    return packRows(pixels, width, height, 4, spectra6Code)

  } else if (paletteGroupId === 'acep') {
    // Scheme 7: 4 bits/pixel, high nibble = left pixel. Same yellow/red codes
    // as Spectra 6, but blue and green move down to 4/5 to free 6 for orange.
    return packRows(pixels, width, height, 4, acepCode)

  } else if (paletteGroupId === 'bw') {
    // Scheme 0: 1 bit/pixel, MSB = leftmost, white=1 black=0
    return packRows(pixels, width, height, 1, (r, g, b) => (r + g + b) > 382 ? 1 : 0)

  } else if (paletteGroupId === 'bwr') {
    // Scheme 1: 2 bitplanes, plane1 then plane2
    // Plane1 bit=1 for white or red; plane2 bit=1 for red only
    const isRed = (r: number, g: number, b: number) => r > 200 && g < 50 && b < 50
    const isWhite = (r: number, g: number, b: number) => r > 200 && g > 200 && b > 200
    const plane1 = packRows(pixels, width, height, 1, (r, g, b) => isWhite(r, g, b) || isRed(r, g, b) ? 1 : 0)
    const plane2 = packRows(pixels, width, height, 1, (r, g, b) => isRed(r, g, b) ? 1 : 0)
    const out = new Uint8Array(plane1.length + plane2.length)
    out.set(plane1, 0)
    out.set(plane2, plane1.length)
    return out

  } else if (paletteGroupId === 'bwry') {
    // Scheme 3: 2 bits/pixel, MSB first
    // black=0, white=1, yellow=2, red=3 — except panels whose controller has
    // yellow and red the other way round (the firmware streams the codes raw)
    const codes = BWRY_CODES_BY_PANEL[panelIc ?? -1] ?? BWRY_CODES_DEFAULT
    return packRows(pixels, width, height, 2, (r, g, b) => codes[bwryCode(r, g, b)])

  } else if (paletteGroupId === 'grayscale4') {
    // Scheme 5: two row-padded 1-bit planes, plane 0 then plane 1, which the
    // firmware streams straight into the controller's two RAM planes. Each
    // grey level (0=black..3=white) goes through the panel's grey-code table;
    // plane 0 carries bit 0 of the code, plane 1 bit 1. Packed 2 bpp is the
    // same byte count, so the firmware accepts it but shows the wrong image.
    const codes = GRAY4_CODES_BY_PANEL[panelIc ?? -1] ?? GRAY4_CODES_DEFAULT
    const code = (r: number, g: number, b: number) => codes[Math.min(3, Math.round(((r + g + b) / 3) / 85))]
    const plane0 = packRows(pixels, width, height, 1, (r, g, b) => code(r, g, b) & 1)
    const plane1 = packRows(pixels, width, height, 1, (r, g, b) => code(r, g, b) >> 1)
    const out = new Uint8Array(plane0.length + plane1.length)
    out.set(plane0, 0)
    out.set(plane1, plane0.length)
    return out

  } else {
    // Scheme 6: 4 bits/pixel (grayscale8, grayscale16)
    // Uses Rec.709 luminance → 0..15
    return packRows(pixels, width, height, 4, (r, g, b) => {
      const y = 0.299 * r + 0.587 * g + 0.114 * b
      return Math.min(15, Math.max(0, Math.round((y * 15) / 255)))
    })
  }
}

// Pack per-pixel codes of `bits` bits each (1, 2 or 4), MSB = leftmost pixel,
// zero-padding the end of every row to a whole byte. Packs columns x0..x1-1.
function packRows(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  bits: 1 | 2 | 4,
  code: (r: number, g: number, b: number) => number,
  x0 = 0,
  x1 = width
): Uint8Array {
  const perByte = 8 / bits
  const rowBytes = Math.ceil((x1 - x0) / perByte)
  const out = new Uint8Array(rowBytes * height)
  for (let y = 0; y < height; y++) {
    for (let x = x0; x < x1; x++) {
      const p = (y * width + x) * 4
      const col = x - x0
      const shift = 8 - bits * (col % perByte + 1)
      out[y * rowBytes + Math.floor(col / perByte)] |= code(pixels[p], pixels[p + 1], pixels[p + 2]) << shift
    }
  }
  return out
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

// [r, g, b, code] for the ACeP ideal palette (src/palettes/acep.ts)
const ACEP_CODES: [number, number, number, number][] = [
  [0, 0, 0, 0], [255, 255, 255, 1], [255, 255, 0, 2], [255, 0, 0, 3],
  [0, 0, 255, 4], [0, 255, 0, 5], [255, 128, 0, 6],
]

function acepCode(r: number, g: number, b: number): number {
  let best = 0, bestDist = Infinity
  for (const [cr, cg, cb, code] of ACEP_CODES) {
    const d = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2
    if (d < bestDist) { bestDist = d; best = code }
  }
  return best
}

// Per-panel code tables, from bb_epaper's colour tables (bb_ep.inl) via
// py-opendisplay display_palettes.py. Indexed by our code / grey level.
//
// BWRY: most panels (u8Colors_4clr_v2) take black=0, white=1, yellow=2,
// red=3. EP29YR 128×296 (0x001D) uses u8Colors_4clr with yellow and red
// swapped. bb_epaper lists 0x001E with that table too, but on hardware
// (Solum M3 2.7") the normal order is right (py-opendisplay #161/#166).
const BWRY_CODES_DEFAULT = [0, 1, 2, 3]
const BWRY_CODES_BY_PANEL: Record<number, number[]> = {
  0x001D: [0, 1, 3, 2],  // EP29YR_128x296
}

// 4-grey: level (0=black..3=white) → 2-bit code stored across the two planes
// (u8Colors_4gray; EP426 and EP368 use u8Colors_4gray_v2, mid-greys swapped).
const GRAY4_CODES_DEFAULT = [3, 1, 2, 0]
const GRAY4_CODES_BY_PANEL: Record<number, number[]> = {
  0x0028: [3, 2, 1, 0],  // EP426_800x480_4GRAY
  0x0048: [3, 2, 1, 0],  // EP368_792x528_4GRAY
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


// ── Connection and device info ────────────────────────────────────────────────

export interface OdFirmwareVersion {
  major: number
  minor: number
  patch: number
}

/** The first display's entry from the device's stored config (TLV packet 0x20). */
export interface OdDisplayConfig {
  width: number
  height: number
  panelIc: number
  colorScheme: number
  transmissionModes: number
}

export interface OdDeviceInfo {
  firmware: OdFirmwareVersion | null
  display: OdDisplayConfig | null
  /** Security config `session_timeout_seconds` (0 = none), or null if unknown. */
  sessionTimeoutS: number | null
}

export interface OdConnection {
  link: OdLink
  info: OdDeviceInfo
  /** The key that authenticated, or null when none was needed. */
  key: Uint8Array | null
}

// The firmware (2.26.1+, Firmware PR #135) serves one client at a time. A
// second one is refused: on ESP32 it is disconnected right after connecting,
// on nRF the device stops advertising while its one link is taken. The slot
// frees when the other client leaves, or after it sends nothing for 120 s.
const BUSY_HINT = 'It may be connected to another client (Home Assistant, the OpenDisplay toolbox, another tab), ' +
  'which keeps it for up to 2 minutes after its last command.'

/**
 * Show the browser's device chooser (needs a user gesture). With `name`
 * (from a device link), it lists only that device.
 */
export function requestDevice(name?: string | null): Promise<BluetoothDevice> {
  return navigator.bluetooth.requestDevice({
    filters: [name ? { name } : { namePrefix: 'OD' }],
    optionalServices: [SERVICE_UUID],
  })
}

/**
 * Connect to a chosen device, authenticate, and read what it supports. The
 * firmware version is always plaintext, so it's requested before
 * authenticating; the config read needs the session when the device has
 * encryption enabled. Either read failing just leaves that part of `info`
 * null (uploads then use the basic path).
 */
export async function connectDevice(device: BluetoothDevice, keys: Uint8Array[]): Promise<OdConnection> {
  const t0 = performance.now()
  const link = await openLink(device)
  const t1 = performance.now()
  try {
    const result = await identifyDevice(link, keys)
    checkStillConnected(link)
    console.info(`OpenDisplay: connect took ${Math.round(performance.now() - t0)} ms (GATT ${Math.round(t1 - t0)} ms, ${result.timing})`)
    return result
  } catch (err) {
    closeLink(link)
    throw connectError(err, device)
  }
}

/**
 * Reconnect to a device connected before, without the chooser (no user
 * gesture needed), e.g. after the firmware dropped an idle connection. Only
 * re-authenticates: the device info from the first connect is reused, since
 * on slow devices each read can take seconds.
 */
export async function reconnectDevice(device: BluetoothDevice, keys: Uint8Array[], info: OdDeviceInfo): Promise<OdConnection> {
  const t0 = performance.now()
  const link = await openLink(device)
  try {
    const key = await startSession(link, keys)
    checkStillConnected(link)
    console.info(`OpenDisplay: reconnected in ${Math.round(performance.now() - t0)} ms`)
    return { link, info, key }
  } catch (err) {
    closeLink(link)
    throw connectError(err, device)
  }
}

async function openLink(device: BluetoothDevice): Promise<OdLink> {
  let server: BluetoothRemoteGATTServer
  try {
    server = await device.gatt!.connect()
  } catch (err) {
    console.warn('OpenDisplay: GATT connect failed', err)
    throw new Error(`Couldn't connect to ${device.name ?? 'the device'}. Check that it's awake and in range. ${BUSY_HINT}`)
  }
  try {
    const service = await server.getPrimaryService(SERVICE_UUID)
    const characteristic = await service.getCharacteristic(SERVICE_UUID)
    await characteristic.startNotifications()
    return new OdLink(characteristic)
  } catch (err) {
    if (!server.connected) throw busyError(device, err)
    server.disconnect()
    throw err
  }
}

function closeLink(link: OdLink): void {
  link.dispose()
  link.device.gatt?.disconnect()
}

function checkStillConnected(link: OdLink): void {
  // The reads at connect swallow their errors, so a refusal shows up here.
  if (!link.connected) throw new OdDisconnectedError()
}

function busyError(device: BluetoothDevice, cause: unknown): Error {
  console.warn('OpenDisplay: connection closed during setup', cause)
  return new Error(`${device.name ?? 'The device'} closed the connection right away. ${BUSY_HINT}`)
}

function connectError(err: unknown, device: BluetoothDevice): unknown {
  return err instanceof OdDisconnectedError ? busyError(device, err) : err
}

/**
 * Authenticate with the first of `keys` the device accepts; returns it, or
 * null without keys. A wrong key moves on to the next one. Any other refusal
 * throws: a device with encryption on accepts no command without a session.
 */
async function startSession(link: OdLink, keys: Uint8Array[]): Promise<Uint8Array | null> {
  for (let i = 0; i < keys.length; i++) {
    try {
      link.session = await authenticate(link, keys[i])
      link.masterKey = keys[i]
      return keys[i]
    } catch (err) {
      if (err instanceof OdAuthError && err.reason === 'not-configured') {
        // Never fall back to plaintext once a key is set: this reply comes
        // before any proof, so anything impersonating the device could send
        // it to switch encryption off (a downgrade).
        throw new OdAuthError(`${link.device.name ?? 'The device'} says it has no encryption set up, but a key is set for it, ` +
          'so it wasn\'t connected to. If encryption was turned off on it, connect again and confirm.', 'not-configured')
      }
      if (err instanceof OdAuthError && err.reason === 'wrong-key' && i < keys.length - 1) {
        console.info('OpenDisplay: key rejected; trying the next one')
        continue
      }
      throw err
    }
  }
  return null
}

/**
 * Authenticate (if a key is given) and read what the device supports, on an
 * already connected link.
 */
export async function identifyDevice(link: OdLink, keys: Uint8Array[]): Promise<OdConnection & { timing: string }> {
  const t1 = performance.now()
  link.drain()
  // Firmware that idles between commands (older builds, low-power configs,
  // WiFi sharing the ESP32 radio) can take seconds per reply, so don't spend
  // a round trip on the firmware version: request it now, alongside auth (it
  // is always plaintext and needs no session), and collect the reply last.
  const versionRequested = await requestFirmwareVersion(link)
  const key = await startSession(link, keys)
  const t2 = performance.now()
  // Without a key, this is where a device with encryption on says so
  // (readDeviceConfig rethrows that).
  const { display, sessionTimeoutS } = await readDeviceConfig(link)
  const t3 = performance.now()

  const firmware = versionRequested ? await collectFirmwareVersion(link) : null
  const t4 = performance.now()

  const ms = (a: number, b: number) => `${Math.round(b - a)} ms`
  const timing = `auth ${keys.length ? ms(t1, t2) : 'none'}, config ${ms(t2, t3)}, ` +
    `firmware version ${versionRequested ? `+${ms(t3, t4)} (requested up front)` : 'not requested'}`
  return { link, info: { firmware, display, sessionTimeoutS }, key, timing }
}

export async function readFirmwareVersion(link: OdLink): Promise<OdFirmwareVersion | null> {
  link.drain()
  return await requestFirmwareVersion(link) ? collectFirmwareVersion(link) : null
}

async function requestFirmwareVersion(link: OdLink): Promise<boolean> {
  try {
    // Always plaintext, before or during a session.
    await link.writeRaw(new Uint8Array([CMD_FIRMWARE_VERSION >> 8, CMD_FIRMWARE_VERSION & 0xFF]))
    return true
  } catch (err) {
    console.warn('OpenDisplay: could not request firmware version', err)
    return false
  }
}

async function collectFirmwareVersion(link: OdLink): Promise<OdFirmwareVersion | null> {
  try {
    // [echo:2][major][minor][shaLen][sha...][patch] — patch was added after 2.25.0
    const f = await link.readFor([CMD_FIRMWARE_VERSION & 0xFF], TIMEOUT_CONNECT_REPLY, true)
    if (isAck(f, CMD_FIRMWARE_VERSION) && f.length >= 5) {
      const patchAt = 5 + f[4]
      return { major: f[2], minor: f[3], patch: f.length > patchAt ? f[patchAt] : 0 }
    }
  } catch (err) {
    console.warn('OpenDisplay: could not read firmware version', err)
  }
  return null
}

export async function readDeviceConfig(link: OdLink): Promise<OdStoredConfig> {
  try {
    await link.send(CMD_CONFIG_READ)
    // First chunk: [echo:2][chunk#:2][total:2 LE][data...]; later chunks:
    // [echo:2][chunk#:2][data...], until `total` data bytes have arrived.
    let total = -1
    let data = new Uint8Array(0)
    while (total < 0 || data.length < total) {
      const f = await link.readFor([CMD_CONFIG_READ & 0xFF], total < 0 ? TIMEOUT_CONNECT_REPLY : 2_000)
      if (isNack(f, CMD_CONFIG_READ)) return NO_CONFIG  // device has no stored config
      if (!isAck(f, CMD_CONFIG_READ)) throw new Error(`unexpected config frame ${hex(f)}`)
      const body = f.subarray(total < 0 ? 6 : 4)
      if (total < 0) total = f[4] | (f[5] << 8)
      else if (body.length === 0) throw new Error('config read stalled')
      const grown = new Uint8Array(data.length + body.length)
      grown.set(data, 0)
      grown.set(body, data.length)
      data = grown
    }
    return parseDeviceConfig(data)
  } catch (err) {
    if (err instanceof OdEncryptionRequiredError || err instanceof OdDisconnectedError) throw err
    console.warn('OpenDisplay: could not read device config', err)
    return NO_CONFIG
  }
}

// Fixed payload size of each TLV packet type. Packets carry no length field,
// so reaching the display packet means knowing the size of everything before
// it (py-opendisplay config_parser._get_packet_size).
const TLV_PACKET_SIZES: Record<number, number> = {
  0x01: 22, 0x02: 22, 0x04: 30, 0x20: 46, 0x21: 22, 0x23: 30, 0x24: 30, 0x25: 30,
  0x26: 160, 0x27: 64, 0x28: 32, 0x29: 32, 0x2A: 32, 0x2B: 32, 0x2C: 288,
}

/** What uploads need from the device's stored config. */
export interface OdStoredConfig {
  display: OdDisplayConfig | null
  sessionTimeoutS: number | null
}

const NO_CONFIG: OdStoredConfig = { display: null, sessionTimeoutS: null }

/**
 * Parse a config blob, [len:2][version:1][packets...][crc:2]: the first
 * display packet (0x20) and the security packet's (0x27) session timeout.
 * Stops at an unknown or truncated packet, keeping what it found before.
 */
export function parseDeviceConfig(raw: Uint8Array): OdStoredConfig {
  const result: OdStoredConfig = { display: null, sessionTimeoutS: null }
  if (raw.length < 5) return result
  const packets = raw.subarray(3, raw.length - 2)
  let off = 0
  while (off + 2 <= packets.length) {
    const type = packets[off + 1]  // [packet_number:1][packet_type:1][data]
    off += 2
    const size = TLV_PACKET_SIZES[type]
    if (size === undefined || off + size > packets.length) break
    const d = new DataView(packets.buffer, packets.byteOffset + off, size)
    if (type === 0x20 && !result.display) {
      result.display = {
        panelIc: d.getUint16(2, true),
        width: d.getUint16(4, true),
        height: d.getUint16(6, true),
        colorScheme: d.getUint8(21),
        transmissionModes: d.getUint8(22),
      }
    } else if (type === 0x27) {
      // [encryption_enabled:1][key:16][session_timeout_seconds:2 LE]...
      result.sessionTimeoutS = d.getUint16(17, true)
    }
    off += size
  }
  return result
}

// display config `transmission_modes` bits
const TM_STREAMING_DECOMPRESSION = 0x01
const TM_ZIP = 0x02
const TM_PIPE_WRITE = 0x10

/**
 * Use PIPE_WRITE only when the device config advertises it (bit 0x10), as
 * both official clients do, and not after it already failed to start on this
 * connection. Encrypted, it needs firmware >= 2.26.1: before that the
 * firmware required strictly increasing nonces and NACKed the out-of-order
 * frames a sliding window produces (Firmware PR #136 added a ±32 replay
 * window).
 */
function pipeEligible(link: OdLink, info: OdDeviceInfo): boolean {
  if (!info.display || !(info.display.transmissionModes & TM_PIPE_WRITE)) return false
  if (link.pipeUnavailable) return false
  return !link.session || firmwareAtLeast(info.firmware, 2, 26, 1)
}

function firmwareAtLeast(fw: OdFirmwareVersion | null, major: number, minor: number, patch = 0): boolean {
  if (!fw) return false
  if (fw.major !== major) return fw.major > major
  if (fw.minor !== minor) return fw.minor > minor
  return fw.patch >= patch
}

const SCHEME_NAMES: Record<number, string> = {
  0: 'black/white', 1: 'black/white/red', 2: 'black/white/yellow', 3: 'black/white/red/yellow',
  4: 'Spectra 6', 5: '4-level grey', 6: '16-level grey', 7: '7-colour ACeP', 8: 'Spectra 6 (split)',
}

/**
 * Describe why an image won't display correctly on this device (wrong size or
 * colour scheme), or null if it matches or the device config is unknown.
 */
export function checkCompatibility(info: OdDeviceInfo, width: number, height: number, paletteGroupId: string): string | null {
  const d = info.display
  if (!d) return null
  const problems: string[] = []
  if (d.width !== width || d.height !== height) {
    problems.push(`The image is ${width}×${height} px but the device's panel is ${d.width}×${d.height} px.`)
  }
  const scheme = PALETTE_SCHEMES[paletteGroupId]
  const splitSpectra6 = scheme === SCHEME_SPECTRA6 && d.colorScheme === SCHEME_SPECTRA6_SPLIT  // encodeImage handles it
  if (scheme !== undefined && scheme !== d.colorScheme && !splitSpectra6) {
    const name = SCHEME_NAMES[d.colorScheme] ?? `scheme ${d.colorScheme}`
    problems.push(`The selected palette is ${SCHEME_NAMES[scheme]} but the device is configured as ${name}.`)
  }
  return problems.length ? problems.join('\n') : null
}

/**
 * A hint when the firmware can do fast (PIPE_WRITE) uploads but the device's
 * stored config doesn't advertise them. Both official clients only use the
 * fast path when the config bit is set, so we do the same.
 */
export function fastUploadHint(info: OdDeviceInfo): string | null {
  if (!info.display || (info.display.transmissionModes & TM_PIPE_WRITE)) return null
  if (!firmwareAtLeast(info.firmware, 2, 20)) return null
  return 'This device\'s firmware supports fast uploads, but they are switched off in its config. ' +
    'Enable "pipe_write" under the display\'s transmission modes in the OpenDisplay toolbox.'
}

export function describeDevice(info: OdDeviceInfo): string {
  const parts: string[] = []
  if (info.firmware) parts.push(`firmware ${info.firmware.major}.${info.firmware.minor}.${info.firmware.patch}`)
  if (info.display) {
    const d = info.display
    parts.push(`${d.width}×${d.height}`, SCHEME_NAMES[d.colorScheme] ?? `scheme ${d.colorScheme}`,
      `transmission modes 0x${d.transmissionModes.toString(16).padStart(2, '0')}`)
  }
  return parts.join(', ') || 'no device info'
}

// ── Upload ────────────────────────────────────────────────────────────────────

export interface UploadStats {
  method: string
  /** Encoded image size. */
  bytes: number
  /** Bytes actually streamed (compressed size when compressed). */
  wireBytes: number
  /** Start until the device confirmed it has the whole image. */
  transferMs: number
  /** Total including the panel refresh. */
  ms: number
}

// Debug switches for comparing upload paths on real hardware, set in the
// browser console: localStorage.odUpload = 'direct' (skip PIPE_WRITE) or
// 'plain' (skip PIPE_WRITE and compression: the original lock-step upload).
function uploadOverride(): string | null {
  try {
    return localStorage.getItem('odUpload')
  } catch {
    return null
  }
}

/**
 * Send an encoded image and wait for the panel refresh to finish.
 * `onProgress` reports bytes of the streamed payload.
 *
 * With encryption, the device may end the session after its configured
 * `session_timeout_seconds` (0 = never, the default). Like py-opendisplay,
 * re-authenticate up front once the session is 90 % of the way there; if the
 * device ends it mid-upload anyway, re-authenticate and send again, once.
 * (If it drops the link instead, after 10 rejected frames, this throws
 * OdDisconnectedError and the caller reconnects.)
 */
export async function sendImage(
  link: OdLink,
  imageBytes: Uint8Array,
  info: OdDeviceInfo,
  onProgress?: (sent: number, total: number) => void
): Promise<UploadStats> {
  const timeoutS = info.sessionTimeoutS ?? 0
  if (link.session && link.masterKey && timeoutS > 0 &&
      performance.now() - link.session.startedAt >= 0.9 * timeoutS * 1000) {
    console.info(`OpenDisplay: encryption session near its ${timeoutS} s timeout; re-authenticating`)
    link.session = await authenticate(link, link.masterKey)
  }
  try {
    return await sendImageOnce(link, imageBytes, info, onProgress)
  } catch (err) {
    if (!(err instanceof OdSessionEndedError) || !link.masterKey || !link.connected) throw err
    console.info('OpenDisplay: the device ended the encryption session; re-authenticating and sending again')
    link.session = await authenticate(link, link.masterKey)
    return await sendImageOnce(link, imageBytes, info, onProgress)
  }
}

async function sendImageOnce(
  link: OdLink,
  imageBytes: Uint8Array,
  info: OdDeviceInfo,
  onProgress?: (sent: number, total: number) => void
): Promise<UploadStats> {
  const t0 = performance.now()
  let transferredAt = 0
  const markTransferred = () => { transferredAt ||= performance.now() }
  const finish = (method: string, wireBytes: number): UploadStats => {
    const end = performance.now()
    const stats = { method, bytes: imageBytes.length, wireBytes, transferMs: (transferredAt || end) - t0, ms: end - t0 }
    logStats(stats)
    return stats
  }
  const override = uploadOverride()
  if (override) console.info(`OpenDisplay: upload override "${override}" (localStorage.odUpload)`)
  const compressed = override === 'plain' ? null : await compressFor(info, imageBytes)

  if (!override && pipeEligible(link, info)) {
    const p = await negotiatePipe(link, compressed !== null, imageBytes.length)
    if (p) {
      const payload = p.compressed ? compressed! : imageBytes
      const retx = await pipeWrite(link, payload, p, onProgress)
      markTransferred()
      await awaitRefresh(link)
      return finish(`pipe write${p.compressed ? ', compressed' : ''} (window ${p.window}, ACK every ${p.ackEvery}, ` +
        `${p.frame} B frames, ${retx} retransmits)`, payload.length)
    }
    link.pipeUnavailable = true
    console.info('OpenDisplay: PIPE_WRITE unavailable on this device; using direct write')
  }

  let method = 'direct write'
  let wireBytes = imageBytes.length
  if (compressed && await directWriteCompressed(link, imageBytes, compressed, markTransferred, onProgress)) {
    method = 'compressed direct write'
    wireBytes = compressed.length
  } else {
    if (compressed) method = 'direct write (compressed start rejected)'
    await directWrite(link, imageBytes, markTransferred, onProgress)
  }
  return finish(method, wireBytes)
}

/**
 * The zlib stream to upload, or null when the device config doesn't allow
 * compression or it doesn't pay off. Bit 0x01 (streaming decompression) means
 * any size; bit 0x02 alone is the older buffered inflater with a ~50 KB cap.
 */
async function compressFor(info: OdDeviceInfo, data: Uint8Array): Promise<Uint8Array | null> {
  const tm = info.display?.transmissionModes ?? 0
  if (!(tm & (TM_STREAMING_DECOMPRESSION | TM_ZIP))) return null
  const { deflate } = await import('pako')
  const z = deflate(data, { level: 9, windowBits: ZLIB_WINDOW_BITS })
  if (z.length >= data.length) return null
  if (!(tm & TM_STREAMING_DECOMPRESSION) && z.length >= MAX_BUFFERED_COMPRESSED_SIZE) return null
  return z
}

function logStats(s: UploadStats): void {
  const rate = s.wireBytes / (s.transferMs / 1000)
  console.info(
    `OpenDisplay upload: ${s.method}, ${s.bytes} B` +
    (s.wireBytes !== s.bytes ? ` (${s.wireBytes} B on the wire)` : '') +
    `, transfer ${(s.transferMs / 1000).toFixed(1)} s (${(rate / 1024).toFixed(1)} KiB/s), ` +
    `refresh ${((s.ms - s.transferMs) / 1000).toFixed(1)} s, total ${(s.ms / 1000).toFixed(1)} s`
  )
}

// Lock-step direct write (0x70/0x71/0x72): one chunk in flight, each ACKed.
// Supported by every OpenDisplay firmware.
async function directWrite(
  link: OdLink,
  data: Uint8Array,
  onTransferred: () => void,
  onProgress?: (sent: number, total: number) => void
): Promise<void> {
  link.drain()
  await link.send(CMD_DIRECT_WRITE_START)
  const f = await readStartResponse(link)
  if (!isAck(f, CMD_DIRECT_WRITE_START)) throw new Error(`Unexpected response to upload start: ${hex(f)}`)
  const autoCompleted = await sendDataChunks(link, data, 0, data.length, onProgress)
  await finishDirectWrite(link, autoCompleted, onTransferred)
}

/**
 * Compressed direct write: START = [size:4 LE][first zlib bytes], the rest of
 * the stream in 0x71 chunks, then END. Returns false (nothing sent past
 * START) if the device rejects compression; the caller then falls back.
 */
async function directWriteCompressed(
  link: OdLink,
  data: Uint8Array,
  z: Uint8Array,
  onTransferred: () => void,
  onProgress?: (sent: number, total: number) => void
): Promise<boolean> {
  const maxStart = link.session ? MAX_START_PAYLOAD_ENCRYPTED : MAX_START_PAYLOAD
  const head = z.subarray(0, maxStart - 4)
  const start = new Uint8Array(4 + head.length)
  new DataView(start.buffer).setUint32(0, data.length, true)
  start.set(head, 4)
  link.drain()
  await link.send(CMD_DIRECT_WRITE_START, start)
  const f = await readStartResponse(link)
  if (!isAck(f, CMD_DIRECT_WRITE_START)) {
    // [0xFF][0x70], or [0xFF][0xFF] from older firmware
    console.warn(`OpenDisplay: compressed upload rejected (${hex(f)}); sending uncompressed`)
    return false
  }
  onProgress?.(head.length, z.length)
  const autoCompleted = await sendDataChunks(link, z.subarray(head.length), head.length, z.length, onProgress)
  await finishDirectWrite(link, autoCompleted, onTransferred)
  return true
}

async function readStartResponse(link: OdLink): Promise<Uint8Array> {
  try {
    return await link.readFor(DIRECT_WRITE_ECHOES, TIMEOUT_START)
  } catch (err) {
    if (err instanceof OdTimeoutError) {
      throw new Error('BLE timeout: no response to start command (device may require encryption)')
    }
    throw err
  }
}

/**
 * Send 0x71 chunks, each waiting for its ACK. Returns true if the device
 * auto-completed (answered 0x72 instead of 0x71 because its buffer is full);
 * no END may be sent then.
 */
async function sendDataChunks(
  link: OdLink,
  data: Uint8Array,
  progressBase: number,
  progressTotal: number,
  onProgress?: (sent: number, total: number) => void
): Promise<boolean> {
  const size = link.session ? ENCRYPTED_CHUNK_SIZE : CHUNK_SIZE
  for (let off = 0; off < data.length; off += size) {
    await link.send(CMD_DIRECT_WRITE_DATA, data.subarray(off, off + size))
    const f = await link.readFor(DIRECT_WRITE_ECHOES, TIMEOUT_DATA_ACK)
    onProgress?.(progressBase + Math.min(off + size, data.length), progressTotal)
    if (isAck(f, CMD_DIRECT_WRITE_END)) return true
    if (!isAck(f, CMD_DIRECT_WRITE_DATA)) throw new Error(`Upload failed at byte ${off}: ${hex(f)}`)
  }
  return false
}

async function finishDirectWrite(link: OdLink, autoCompleted: boolean, onTransferred: () => void): Promise<void> {
  if (!autoCompleted) {
    await link.send(CMD_DIRECT_WRITE_END, new Uint8Array([0]))  // 0 = full refresh
    const f = await link.readFor(DIRECT_WRITE_ECHOES, TIMEOUT_END_ACK)
    onTransferred()
    if (isAck(f, RESP_REFRESH_SUCCESS)) return  // some firmware skips the END ACK
    if (!isAck(f, CMD_DIRECT_WRITE_END)) throw new Error(`Unexpected response to end of upload: ${hex(f)}`)
  }
  onTransferred()
  await awaitRefresh(link)
}

async function awaitRefresh(link: OdLink): Promise<void> {
  const f = await link.readFor([RESP_REFRESH_SUCCESS, RESP_REFRESH_TIMEOUT], TIMEOUT_REFRESH)
  if (isAck(f, RESP_REFRESH_SUCCESS)) return
  if (isAck(f, RESP_REFRESH_TIMEOUT)) throw new Error('Display refresh timed out')
  throw new Error(`Unexpected response waiting for refresh: ${hex(f)}`)
}
