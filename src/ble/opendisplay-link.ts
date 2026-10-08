import { type OdSession, decryptResponse, encryptCommand } from './opendisplay-crypto'

// Encrypted frames are at least cmd(2) + nonce(16) + len(1) + tag(12) bytes.
// Shorter frames are plaintext even during a session (e.g. the 2-byte
// direct-write ACKs and error frames).
const ENCRYPTED_MIN_LEN = 31
const RESP_FIRMWARE_VERSION = 0x43
const RESP_AUTHENTICATE = 0x50
const MAX_STASH = 8

export class OdTimeoutError extends Error {
  constructor(message = 'BLE notification timeout') {
    super(message)
    this.name = 'OdTimeoutError'
  }
}

/** The BLE link dropped while waiting for a reply. */
export class OdDisconnectedError extends Error {
  constructor(message = 'The device disconnected') {
    super(message)
    this.name = 'OdDisconnectedError'
  }
}

/** The device answered RESP_AUTH_REQUIRED: it has encryption on and there is no session. */
export class OdEncryptionRequiredError extends Error {
  constructor(message = 'This device uses encryption: enter its key (the opendisplay.org/l/… link from its QR code, or the 32-character hex key)') {
    super(message)
    this.name = 'OdEncryptionRequiredError'
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
  private stash: Uint8Array[] = []  // frames readFor set aside for another command
  private waiter: { resolve: (frame: Uint8Array) => void; reject: (err: Error) => void } | null = null
  private writeWithoutResponseUnsupported = false
  /** The GATT link dropped; pending and later reads fail at once. */
  closed = false

  constructor(readonly char: BluetoothRemoteGATTCharacteristic) {
    char.addEventListener('characteristicvaluechanged', this.onValue)
    this.device.addEventListener('gattserverdisconnected', this.onDisconnect)
  }

  get device(): BluetoothDevice {
    return this.char.service.device
  }

  get connected(): boolean {
    return !this.closed && (this.device.gatt?.connected ?? false)
  }

  dispose(): void {
    this.char.removeEventListener('characteristicvaluechanged', this.onValue)
    this.device.removeEventListener('gattserverdisconnected', this.onDisconnect)
    this.onDisconnect()
    this.queue.length = 0
  }

  private onValue = (event: Event) => {
    const dv = (event.target as BluetoothRemoteGATTCharacteristic).value
    if (!dv) return
    const frame = new Uint8Array(dv.buffer.slice(dv.byteOffset, dv.byteOffset + dv.byteLength))
    if (this.waiter) this.waiter.resolve(frame)
    else this.queue.push(frame)
  }

  private onDisconnect = () => {
    this.closed = true
    this.session = null  // the firmware drops its session with the link
    this.waiter?.reject(new OdDisconnectedError())
  }

  /** Discard notifications left over from a previous exchange. */
  drain(): void {
    this.queue.length = 0
    this.stash.length = 0
  }

  /** Next notification exactly as received (no decryption). */
  readRaw(timeoutMs: number): Promise<Uint8Array> {
    const queued = this.queue.shift()
    if (queued) return Promise.resolve(queued)
    if (this.closed) return Promise.reject(new OdDisconnectedError())
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null
        reject(new OdTimeoutError())
      }, timeoutMs)
      const settle = () => {
        clearTimeout(timer)
        this.waiter = null
      }
      this.waiter = {
        resolve: (frame) => { settle(); resolve(frame) },
        reject: (err) => { settle(); reject(err) },
      }
    })
  }

  /**
   * Next notification that answers one of `echoes` (the low byte of the
   * command, frame byte 1), as a plaintext [status][echo][data...] frame.
   *
   * The queue has no request/response correlation, so frames for other
   * commands are set aside (a few, newest kept) for a later readFor of their
   * own: a reply that arrived after its read timed out isn't taken as the
   * answer to the next command, and a request sent ahead (the firmware
   * version during auth) can be collected later. `timeoutMs` bounds the whole
   * wait. Frames are decrypted when a session is active, except the
   * firmware-version and auth replies, which the firmware always sends in
   * plaintext (and `plain` reads, which never decrypt). Byte 1 is the echo in
   * the encrypted envelope too, so frames are matched before decrypting.
   */
  async readFor(echoes: number[], timeoutMs: number, plain = false): Promise<Uint8Array> {
    const matches = (raw: Uint8Array) => raw.length >= 2 && echoes.includes(raw[1])
    const stashed = this.stash.findIndex(matches)
    if (stashed >= 0) return this.accept(this.stash.splice(stashed, 1)[0], plain)
    const deadline = performance.now() + timeoutMs
    for (;;) {
      const left = deadline - performance.now()
      if (left <= 0) throw new OdTimeoutError()
      const raw = await this.readRaw(left)
      if (matches(raw)) return this.accept(raw, plain)
      console.debug(`OpenDisplay: setting aside frame ${hex(raw)} (waiting for a reply to 0x${echoes.map(e => e.toString(16)).join('/0x')})`)
      this.stash.push(raw)
      if (this.stash.length > MAX_STASH) this.stash.shift()
    }
  }

  private async accept(raw: Uint8Array, plain: boolean): Promise<Uint8Array> {
    const f = await this.decode(raw, plain)
    if ((f.length === 2 && f[0] === 0xFE) || (f.length === 3 && f[2] === 0xFE)) {
      // With a session, the device has dropped it (its optional session timeout).
      throw new OdEncryptionRequiredError(this.session
        ? 'The device ended the encryption session: try again to start a new one'
        : undefined)
    }
    if (f.length === 3 && f[2] === 0xFF) {
      throw new Error('Device rejected an encrypted command (integrity check failed)')
    }
    return f
  }

  private async decode(raw: Uint8Array, plain: boolean): Promise<Uint8Array> {
    const alwaysPlain = raw.length >= 2 && (raw[1] === RESP_FIRMWARE_VERSION || raw[1] === RESP_AUTHENTICATE)
    if (plain || !this.session || raw.length < ENCRYPTED_MIN_LEN || alwaysPlain) return raw
    const { cmd, payload } = await decryptResponse(this.session, raw)
    const frame = new Uint8Array(2 + payload.length)
    frame[0] = cmd >> 8
    frame[1] = cmd & 0xFF
    frame.set(payload, 2)
    return frame
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
