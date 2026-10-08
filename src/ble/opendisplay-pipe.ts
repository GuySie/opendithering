// PIPE_WRITE (0x0080–0x0082): sliding-window image upload with selective
// repeat. Firmware >= 2.20 (nRF52840/ESP32 "Firmware" only). Follows
// opendisplay-protocol's opendisplay_protocol.h, py-opendisplay's
// _send_pipe_chunks and the opendisplay.org web client (ble-common.js),
// whose timing constants were tuned against Chrome.
import { type OdLink, OdTimeoutError, hex, isAck, isNack } from './opendisplay-link'

const CMD_PIPE_WRITE_START = 0x0080
const CMD_PIPE_WRITE_DATA = 0x0081
const CMD_PIPE_WRITE_END = 0x0082

const PIPE_VERSION = 1
const PIPE_FLAG_COMPRESSED = 0x01
const PIPE_MAX_FRAME = 244
const PIPE_START_NACK_COMPRESSION = 0x02

const REQ_WINDOW = 16          // frames in flight
const REQ_ACK_EVERY = 4        // device ACKs every N frames (web client; python uses 8)
const TIMEOUT_START = 15_000   // silence after START = firmware without PIPE_WRITE
const TIMEOUT_ACK = 15_000     // wait for a cadence ACK
// Re-probe sooner when an ACK is due but hasn't come: a short tail (< N
// unacked frames never earn a cadence ACK), or a retransmit that should have
// filled a hole (the device ACKs as soon as the hole drains). A lost
// retransmit otherwise costs a full TIMEOUT_ACK with the window stalled.
const TIMEOUT_PROBE = 600
// Give up after this long without any frame from the device. Measured as
// time rather than probe count, so a device blocked on a slow SPI write isn't
// abandoned just because the short probes ran out.
const MAX_SILENCE = 3 * TIMEOUT_ACK
const TIMEOUT_END_ACK = 90_000
const RETX_ACK_SPACING = 2     // ACKs a retransmit gets to land before repeating it
// Chrome's writeValueWithoutResponse silently drops frames when the controller
// buffer backs up, so a large upload legitimately repairs many frames.
const MAX_RETX_FRACTION = 0.5

export interface PipeParams {
  window: number
  ackEvery: number
  frame: number
  /** Device buffers out-of-order frames (selective repeat); otherwise rewind. */
  selective: boolean
  compressed: boolean
}

/**
 * Send PIPE_WRITE_START and negotiate window, ACK cadence and frame size.
 * Returns null when the device doesn't answer (no PIPE_WRITE in this
 * firmware) or rejects the transfer; the caller then uses direct write. A
 * compressed request rejected with err 0x02 is retried once uncompressed.
 */
export async function negotiatePipe(link: OdLink, compressed: boolean, totalSize: number): Promise<PipeParams | null> {
  const req = new Uint8Array(10)
  const dv = new DataView(req.buffer)
  req[0] = PIPE_VERSION
  req[1] = compressed ? PIPE_FLAG_COMPRESSED : 0
  req[2] = REQ_WINDOW
  req[3] = REQ_ACK_EVERY
  dv.setUint16(4, PIPE_MAX_FRAME, true)
  dv.setUint32(6, totalSize, true)  // decompressed size
  link.drain()
  await link.send(CMD_PIPE_WRITE_START, req)

  let f: Uint8Array
  try {
    f = await link.readFor([0x80], TIMEOUT_START)
  } catch (err) {
    if (err instanceof OdTimeoutError) return null
    throw err
  }
  if (isNack(f, CMD_PIPE_WRITE_START)) {
    const code = f[2]
    if (code === PIPE_START_NACK_COMPRESSION && compressed) {
      console.info('OpenDisplay: device rejected compressed PIPE_WRITE; retrying uncompressed')
      return negotiatePipe(link, false, totalSize)
    }
    console.info(`OpenDisplay: PIPE_WRITE start rejected (err 0x${code?.toString(16)})`)
    return null
  }
  if (!isAck(f, CMD_PIPE_WRITE_START) || f.length < 8) {
    console.info(`OpenDisplay: unexpected PIPE_WRITE start response ${hex(f)}`)
    return null
  }
  // [0x00][0x80][ver][max_window][max_ack_every][max_frame:2 LE][resp_flags]
  const window = Math.max(1, Math.min(REQ_WINDOW, f[3], 32))
  return {
    window,
    ackEvery: Math.max(1, Math.min(REQ_ACK_EVERY, f[4], window)),
    frame: Math.min(PIPE_MAX_FRAME, f[5] | (f[6] << 8)),
    selective: (f[7] & 0x01) !== 0,
    compressed,
  }
}

/**
 * Stream `payload` (raw, or zlib when `p.compressed`) and complete the
 * transfer, up to the device's END ACK. The refresh notification is left
 * for the caller. Returns the number of retransmitted frames.
 *
 * Completion differs by mode: an uncompressed transfer auto-completes on the
 * device once total_size bytes arrived (flush ACK, then an unsolicited
 * [0x00][0x82]) and must NOT get an END; a compressed one is finished with an
 * explicit END once every chunk is acked.
 */
export async function pipeWrite(
  link: OdLink,
  payload: Uint8Array,
  p: PipeParams,
  onProgress?: (sent: number, total: number) => void
): Promise<number> {
  // Data per frame: frame minus cmd(2)+seq(1), or minus the encryption
  // envelope (31) + seq(1) when encrypted.
  const size = link.session ? p.frame - 32 : p.frame - 3
  if (size < 1) throw new Error(`PIPE_WRITE frame size ${p.frame} too small`)
  const chunks: Uint8Array[] = []
  for (let off = 0; off < payload.length; off += size) chunks.push(payload.subarray(off, off + size))
  if (chunks.length === 0) chunks.push(new Uint8Array(0))

  const n = chunks.length
  const explicitEnd = p.compressed
  const maxRetx = Math.max(3 * p.window, Math.ceil(n * MAX_RETX_FRACTION))
  const acked = new Uint8Array(n)
  let highestAcked = -1
  let windowBase = 0  // lowest unacked chunk
  let nextToSend = 0
  const pendingRetx = new Map<number, number>()  // missing chunk -> ACKs seen since last (re)send
  let retx = 0
  let lastFrameAt = performance.now()
  let stallAcks = 0

  const send = (i: number) => {
    const frame = new Uint8Array(1 + chunks[i].length)
    frame[0] = i & 0xFF
    frame.set(chunks[i], 1)
    return link.send(CMD_PIPE_WRITE_DATA, frame)
  }
  const retransmit = async (i: number, why: string) => {
    await send(i)
    if (++retx > maxRetx) throw new Error(`PIPE_WRITE aborted: more than ${maxRetx} retransmits (${why})`)
  }

  let autoCompleted = false
  for (;;) {
    // 1. Fill the window.
    while (nextToSend < n && nextToSend - windowBase < p.window) await send(nextToSend++)
    if (windowBase >= n && explicitEnd) break

    // 2. Wait for an ACK.
    const tailFlush = explicitEnd && nextToSend >= n && n - windowBase > 0 &&
      n - windowBase < p.ackEvery && highestAcked < windowBase
    const repairing = pendingRetx.size > 0
    let f: Uint8Array
    try {
      f = await link.readFor([0x81, 0x82], tailFlush || repairing ? TIMEOUT_PROBE : TIMEOUT_ACK)
    } catch (err) {
      if (!(err instanceof OdTimeoutError)) throw err
      if (windowBase >= n) throw new Error('PIPE_WRITE: device never confirmed the end of the upload')
      if (performance.now() - lastFrameAt > MAX_SILENCE) {
        throw new Error(`PIPE_WRITE stalled: no response for ${MAX_SILENCE / 1000} s`)
      }
      // Resend the oldest unacked chunk: it fills the hole if that was lost,
      // and a duplicate draws an immediate ACK otherwise.
      await retransmit(windowBase, 'probe')
      pendingRetx.set(windowBase, 0)
      continue
    }
    lastFrameAt = performance.now()

    if (f.length >= 8 && isNack(f, CMD_PIPE_WRITE_DATA)) throw new Error(`PIPE_WRITE failed (device error 0x${f[2].toString(16)})`)
    if (isAck(f, CMD_PIPE_WRITE_END)) {
      // Unsolicited auto-complete: the device holds the full image.
      autoCompleted = true
      break
    }
    if (isNack(f, CMD_PIPE_WRITE_END)) throw new Error('PIPE_WRITE: device reported an incomplete upload')
    if (!(f.length >= 7 && isAck(f, CMD_PIPE_WRITE_DATA))) throw new Error(`Unexpected frame during PIPE_WRITE: ${hex(f)}`)

    // 3. SACK [0x00][0x81][highest_seen][ack_mask:4 LE]: mask bit i = chunk
    // highest_seen-1-i received. Seqs are mod 256; resolve against windowBase
    // (the in-flight span is <= 32, so this is unambiguous).
    const mask = (f[3] | (f[4] << 8) | (f[5] << 16) | (f[6] << 24)) >>> 0
    let delta = (f[2] - (windowBase & 0xFF)) & 0xFF
    if (delta > 128) delta -= 256
    const hAbs = windowBase + delta
    const mark = (i: number) => {
      if (i < 0 || i >= n) return
      acked[i] = 1
      if (i > highestAcked) highestAcked = i
    }
    mark(hAbs)
    for (let i = 0; i < 32; i++) if (mask & (1 << i)) mark(hAbs - 1 - i)

    const prevBase = windowBase
    while (windowBase < n && acked[windowBase]) pendingRetx.delete(windowBase++)
    if (windowBase > prevBase) {
      stallAcks = 0
      onProgress?.(Math.min(windowBase * size, payload.length), payload.length)
    }
    if (windowBase >= n) {
      // Uncompressed: keep reading for the auto-complete END ACK.
      if (++stallAcks > maxRetx) throw new Error('PIPE_WRITE: no end confirmation after all chunks were acked')
      continue
    }

    // 4. Holes below the highest received chunk are losses.
    const missing: number[] = []
    for (let i = windowBase; i < Math.min(highestAcked, nextToSend); i++) if (!acked[i]) missing.push(i)
    if (missing.length === 0) {
      if (++stallAcks > maxRetx) throw new Error('PIPE_WRITE: ACKs without progress')
      continue
    }
    if (p.selective) {
      for (const m of missing) {
        const seen = pendingRetx.get(m)
        if (seen !== undefined && seen + 1 < RETX_ACK_SPACING) {
          pendingRetx.set(m, seen + 1)  // a retransmit of it may still be in flight
          continue
        }
        await retransmit(m, 'loss')
        pendingRetx.set(m, 0)
      }
    } else {
      // Device doesn't buffer out-of-order frames: resend from the hole.
      nextToSend = windowBase
      pendingRetx.clear()
      if (++retx > maxRetx) throw new Error(`PIPE_WRITE aborted: more than ${maxRetx} retransmits (rewind)`)
    }
  }

  if (!autoCompleted) {
    await link.send(CMD_PIPE_WRITE_END, new Uint8Array([0]))  // 0 = full refresh
    for (let stray = 0; ; stray++) {
      const f = await link.readFor([0x81, 0x82], TIMEOUT_END_ACK)
      if (isAck(f, CMD_PIPE_WRITE_END)) break
      if (isNack(f, CMD_PIPE_WRITE_END)) throw new Error('PIPE_WRITE: device reported an incomplete upload')
      if (f.length >= 8 && isNack(f, CMD_PIPE_WRITE_DATA)) throw new Error(`PIPE_WRITE failed (device error 0x${f[2].toString(16)})`)
      // A tail-flush SACK precedes the END ACK; skip it (bounded).
      if (!isAck(f, CMD_PIPE_WRITE_DATA) || stray > 32) throw new Error(`Unexpected frame awaiting PIPE_WRITE end: ${hex(f)}`)
    }
  }
  onProgress?.(payload.length, payload.length)
  return retx
}
