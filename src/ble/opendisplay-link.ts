import { type OdSession, decryptResponse, encryptCommand } from './opendisplay-crypto'

// Encrypted frames are at least cmd(2) + nonce(16) + len(1) + tag(12) bytes.
// Shorter frames are plaintext even during a session (e.g. the 2-byte
// direct-write ACKs and error frames).
const ENCRYPTED_MIN_LEN = 31

export class OdTimeoutError extends Error {
  constructor(message = 'BLE notification timeout') {
    super(message)
    this.name = 'OdTimeoutError'
  }
}

/**
 * One OpenDisplay BLE connection: the command characteristic plus a queue of
 * incoming notifications. A single persistent listener feeds the queue, so a
 * response that arrives before the caller starts reading isn't lost, and the
 * PIPE_WRITE sender can collect ACKs that arrive while it is still writing.
 */
export class OdLink {
  session: OdSession | null = null
  /** PIPE_WRITE was tried on this connection and the device didn't take it. */
  pipeUnavailable = false
  private queue: Uint8Array[] = []
  private waiter: ((frame: Uint8Array) => void) | null = null
  private writeWithoutResponseUnsupported = false

  constructor(readonly char: BluetoothRemoteGATTCharacteristic) {
    char.addEventListener('characteristicvaluechanged', this.onValue)
  }

  get device(): BluetoothDevice {
    return this.char.service.device
  }

  get connected(): boolean {
    return this.device.gatt?.connected ?? false
  }

  dispose(): void {
    this.char.removeEventListener('characteristicvaluechanged', this.onValue)
    this.queue.length = 0
  }

  private onValue = (event: Event) => {
    const dv = (event.target as BluetoothRemoteGATTCharacteristic).value
    if (!dv) return
    const frame = new Uint8Array(dv.buffer.slice(dv.byteOffset, dv.byteOffset + dv.byteLength))
    if (this.waiter) this.waiter(frame)
    else this.queue.push(frame)
  }

  /** Discard notifications left over from a previous exchange. */
  drain(): void {
    this.queue.length = 0
  }

  /** Next notification exactly as received (no decryption). */
  readRaw(timeoutMs: number): Promise<Uint8Array> {
    const queued = this.queue.shift()
    if (queued) return Promise.resolve(queued)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null
        reject(new OdTimeoutError())
      }, timeoutMs)
      this.waiter = (frame) => {
        clearTimeout(timer)
        this.waiter = null
        resolve(frame)
      }
    })
  }

  /**
   * Next notification as a plaintext [status][echo][data...] frame, decrypting
   * it when a session is active. Throws on the device's auth-required and
   * integrity-failure frames.
   */
  async read(timeoutMs: number): Promise<Uint8Array> {
    const raw = await this.readRaw(timeoutMs)
    if (this.session && raw.length >= ENCRYPTED_MIN_LEN) {
      const { cmd, payload } = await decryptResponse(this.session, raw)
      const frame = new Uint8Array(2 + payload.length)
      frame[0] = cmd >> 8
      frame[1] = cmd & 0xFF
      frame.set(payload, 2)
      return frame
    }
    if ((raw.length === 2 && raw[0] === 0xFE) || (raw.length === 3 && raw[2] === 0xFE)) {
      throw new Error('Device requires encryption — set the encryption key')
    }
    if (raw.length === 3 && raw[2] === 0xFF) {
      throw new Error('Device rejected an encrypted command (integrity check failed)')
    }
    return raw
  }

  /** Write bytes as-is. Prefers write-without-response for throughput. */
  async writeRaw(data: Uint8Array): Promise<void> {
    const bytes = data as Uint8Array<ArrayBuffer>
    if (!this.writeWithoutResponseUnsupported && this.char.properties.writeWithoutResponse !== false) {
      try {
        await this.char.writeValueWithoutResponse(bytes)
        return
      } catch (err) {
        // Some engines/characteristics only support write-with-response; fall
        // back once and remember. Other errors (e.g. NetworkError) propagate.
        if (!(err instanceof DOMException && err.name === 'NotSupportedError')) throw err
        this.writeWithoutResponseUnsupported = true
      }
    }
    await this.char.writeValueWithResponse(bytes)
  }

  /**
   * Send a command: [cmd_hi][cmd_lo][payload...]. Encrypted when a session is
   * active; every call takes a fresh nonce, so a PIPE_WRITE retransmission is
   * a new frame as far as the firmware's replay window is concerned.
   */
  async send(cmd: number, payload: Uint8Array = new Uint8Array(0)): Promise<void> {
    if (this.session) {
      await this.writeRaw(await encryptCommand(this.session, cmd, payload))
      return
    }
    const frame = new Uint8Array(2 + payload.length)
    frame[0] = cmd >> 8
    frame[1] = cmd & 0xFF
    frame.set(payload, 2)
    await this.writeRaw(frame)
  }
}

/** True if `frame` is a success response to `cmd` ([0x00|0x80][cmd_lo]). */
export function isAck(frame: Uint8Array, cmd: number): boolean {
  return frame.length >= 2 && (frame[0] === 0x00 || frame[0] === 0x80) && frame[1] === (cmd & 0xFF)
}

/** True if `frame` is a NACK for `cmd` ([0xFF][cmd_lo]...). */
export function isNack(frame: Uint8Array, cmd: number): boolean {
  return frame.length >= 2 && frame[0] === 0xFF && frame[1] === (cmd & 0xFF)
}

export function hex(frame: Uint8Array, max = 8): string {
  return Array.from(frame.slice(0, max), b => b.toString(16).padStart(2, '0')).join(' ')
}
