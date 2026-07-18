/**
 * OpenDisplay BLE encryption — Web Crypto implementation.
 * Matches firmware encryption.cpp and py-opendisplay/crypto.py exactly.
 * RFC 4493 (AES-CMAC), RFC 3610 (AES-CCM, L=2, 13-byte nonce, 12-byte tag).
 */

export interface OdSession {
  sessionKey: Uint8Array
  sessionId: Uint8Array
  counter: number
}

// ── AES-ECB single block ──────────────────────────────────────────────────────
// AES-CBC with zero IV on 16 bytes → first 16 bytes of output = AES(K, block).
// (Web Crypto always appends a PKCS7 padding block; we discard it.)

// TypeScript 5.4 requires Uint8Array<ArrayBuffer> for BufferSource; cast where needed.
type U8 = Uint8Array<ArrayBuffer>

async function importCbc(rawKey: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', rawKey as unknown as U8, { name: 'AES-CBC' }, false, ['encrypt'])
}

async function aesEcbBlock(rawKey: Uint8Array, block: Uint8Array): Promise<U8> {
  const key = await importCbc(rawKey)
  const out = await crypto.subtle.encrypt({ name: 'AES-CBC', iv: new Uint8Array(16) }, key, block as unknown as U8)
  // .slice() always returns Uint8Array<ArrayBuffer>
  return new Uint8Array(out).slice(0, 16)
}

// ── CBC-MAC ───────────────────────────────────────────────────────────────────
// data must already be padded to a multiple of 16 bytes.

async function cbcMac(rawKey: Uint8Array, data: Uint8Array): Promise<U8> {
  const key = await importCbc(rawKey)
  let T: U8 = new Uint8Array(16)
  for (let i = 0; i < data.length; i += 16) {
    const xored = new Uint8Array(16)
    for (let j = 0; j < 16; j++) xored[j] = data[i + j] ^ T[j]
    const out = await crypto.subtle.encrypt({ name: 'AES-CBC', iv: new Uint8Array(16) }, key, xored)
    // .slice() coerces ArrayBuffer → Uint8Array<ArrayBuffer>
    T = new Uint8Array(out).slice(0, 16)
  }
  return T
}

// ── AES-CMAC (RFC 4493) ───────────────────────────────────────────────────────

function xor16(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(16)
  for (let i = 0; i < 16; i++) out[i] = a[i] ^ b[i]
  return out
}

function shl1(b: Uint8Array): Uint8Array {
  const out = new Uint8Array(16)
  for (let i = 0; i < 15; i++) out[i] = (b[i] << 1) | (b[i + 1] >> 7)
  out[15] = b[15] << 1
  return out
}

async function aesCmac(rawKey: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const Rb = new Uint8Array(16); Rb[15] = 0x87
  const L = await aesEcbBlock(rawKey, new Uint8Array(16))
  const K1 = (L[0] & 0x80) ? xor16(shl1(L), Rb) : shl1(L)
  const K2 = (K1[0] & 0x80) ? xor16(shl1(K1), Rb) : shl1(K1)

  const n = data.length
  let padded: Uint8Array
  let lastKey: Uint8Array

  if (n === 0) {
    padded = new Uint8Array(16); padded[0] = 0x80
    lastKey = K2
  } else {
    const blocks = Math.ceil(n / 16)
    padded = new Uint8Array(blocks * 16)
    padded.set(data)
    if (n % 16 !== 0) { padded[n] = 0x80; lastKey = K2 }
    else lastKey = K1
  }

  for (let i = 0; i < 16; i++) padded[padded.length - 16 + i] ^= lastKey[i]
  return cbcMac(rawKey, padded)
}

// ── AES-CTR ───────────────────────────────────────────────────────────────────

async function aesCtr(rawKey: Uint8Array, counterBlock: Uint8Array, data: Uint8Array): Promise<U8> {
  const key = await crypto.subtle.importKey('raw', rawKey as unknown as U8, { name: 'AES-CTR' }, false, ['encrypt'])
  // L=2: rightmost 16 bits are the counter field
  const out = await crypto.subtle.encrypt(
    { name: 'AES-CTR', counter: counterBlock as unknown as U8, length: 16 },
    key,
    data as unknown as U8
  )
  return new Uint8Array(out).slice()
}

// ── AES-CCM (RFC 3610, L=2, 13-byte nonce, 12-byte tag) ─────────────────────

function pad16(data: Uint8Array): Uint8Array {
  const len = Math.ceil(data.length / 16) * 16 || 16
  const out = new Uint8Array(len)
  out.set(data)
  return out
}

function ccmCounterBlock(nonce13: Uint8Array, counter: number): Uint8Array {
  const block = new Uint8Array(16)
  block[0] = 0x01  // flags_A = L-1 = 1
  block.set(nonce13, 1)
  // counter as 2-byte BE at [14:16]
  block[14] = (counter >> 8) & 0xFF
  block[15] = counter & 0xFF
  return block
}

async function aesCcmEncrypt(
  rawKey: Uint8Array,
  nonce13: Uint8Array,
  ad: Uint8Array,
  plaintext: Uint8Array
): Promise<Uint8Array> {
  // flags_B: bit6=Adata, bits5-3=M'=(12-2)/2=5, bits2-0=L'=1
  const flags_B = (ad.length > 0 ? 0x40 : 0x00) | 0x29
  const B0 = new Uint8Array(16)
  B0[0] = flags_B
  B0.set(nonce13, 1)
  B0[14] = (plaintext.length >> 8) & 0xFF
  B0[15] = plaintext.length & 0xFF

  // Adata: [len as 2-byte BE][ad bytes], padded to 16
  const adataRaw = new Uint8Array(2 + ad.length)
  adataRaw[0] = (ad.length >> 8) & 0xFF
  adataRaw[1] = ad.length & 0xFF
  adataRaw.set(ad, 2)
  const adataBlock = pad16(adataRaw)
  const ptPadded = pad16(plaintext)

  const cbcInput = new Uint8Array(16 + (ad.length > 0 ? adataBlock.length : 0) + ptPadded.length)
  let off = 0
  cbcInput.set(B0, off); off += 16
  if (ad.length > 0) { cbcInput.set(adataBlock, off); off += adataBlock.length }
  cbcInput.set(ptPadded, off)

  const T = await cbcMac(rawKey, cbcInput)
  const S0 = await aesEcbBlock(rawKey, ccmCounterBlock(nonce13, 0))
  const ciphertext = await aesCtr(rawKey, ccmCounterBlock(nonce13, 1), plaintext)

  const out = new Uint8Array(ciphertext.length + 12)
  out.set(ciphertext)
  for (let i = 0; i < 12; i++) out[ciphertext.length + i] = T[i] ^ S0[i]
  return out
}

async function aesCcmDecrypt(
  rawKey: Uint8Array,
  nonce13: Uint8Array,
  ad: Uint8Array,
  ciphertext: Uint8Array,
  tag: Uint8Array
): Promise<Uint8Array> {
  const S0 = await aesEcbBlock(rawKey, ccmCounterBlock(nonce13, 0))
  const plaintext = await aesCtr(rawKey, ccmCounterBlock(nonce13, 1), ciphertext)

  // Re-compute CBC-MAC over decrypted plaintext to verify tag
  const flags_B = (ad.length > 0 ? 0x40 : 0x00) | 0x29
  const B0 = new Uint8Array(16)
  B0[0] = flags_B
  B0.set(nonce13, 1)
  B0[14] = (plaintext.length >> 8) & 0xFF
  B0[15] = plaintext.length & 0xFF

  const adataRaw = new Uint8Array(2 + ad.length)
  adataRaw[0] = (ad.length >> 8) & 0xFF
  adataRaw[1] = ad.length & 0xFF
  adataRaw.set(ad, 2)
  const adataBlock = pad16(adataRaw)
  const ptPadded = pad16(plaintext)

  const cbcInput = new Uint8Array(16 + (ad.length > 0 ? adataBlock.length : 0) + ptPadded.length)
  let off = 0
  cbcInput.set(B0, off); off += 16
  if (ad.length > 0) { cbcInput.set(adataBlock, off); off += adataBlock.length }
  cbcInput.set(ptPadded, off)

  const T = await cbcMac(rawKey, cbcInput)

  let diff = 0
  for (let i = 0; i < 12; i++) diff |= tag[i] ^ (T[i] ^ S0[i])
  if (diff !== 0) throw new Error('CCM tag verification failed')

  return plaintext
}

// ── Key derivation ────────────────────────────────────────────────────────────

const DEFAULT_DEVICE_ID = new Uint8Array([0, 0, 0, 1])

async function deriveSessionKey(
  masterKey: Uint8Array,
  clientNonce: Uint8Array,
  serverNonce: Uint8Array,
  deviceId: Uint8Array
): Promise<Uint8Array> {
  const label = new TextEncoder().encode('OpenDisplay session')
  // CMAC input: label || 0x00 || deviceId || clientNonce || serverNonce || 0x00 0x80
  const cmacInput = new Uint8Array(label.length + 1 + deviceId.length + 16 + 16 + 2)
  let off = 0
  cmacInput.set(label, off); off += label.length
  cmacInput[off++] = 0x00
  cmacInput.set(deviceId, off); off += deviceId.length
  cmacInput.set(clientNonce, off); off += 16
  cmacInput.set(serverNonce, off); off += 16
  cmacInput[off++] = 0x00; cmacInput[off++] = 0x80

  const intermediate = await aesCmac(masterKey, cmacInput)

  // AES-ECB(masterKey, counter_be(1, 8 bytes) || intermediate[0:8])
  const finalInput = new Uint8Array(16)
  finalInput[7] = 0x01  // counter = 1, big-endian 8 bytes
  finalInput.set(intermediate.slice(0, 8), 8)
  return aesEcbBlock(masterKey, finalInput)
}

async function deriveSessionId(
  sessionKey: Uint8Array,
  clientNonce: Uint8Array,
  serverNonce: Uint8Array
): Promise<Uint8Array> {
  const input = new Uint8Array(32)
  input.set(clientNonce, 0)
  input.set(serverNonce, 16)
  const mac = await aesCmac(sessionKey, input)
  return mac.slice(0, 8)
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Parse a master key from a landing URL (opendisplay.org/l/?…) or 32-char hex string. */
export function parseMasterKey(input: string): Uint8Array | null {
  const s = input.trim()
  if (!s) return null

  // Landing URL: extract base64url payload, key is at bytes 5–20
  const urlMatch = s.match(/\/l\/\?([A-Za-z0-9_=-]+)/)
  if (urlMatch) {
    try {
      const b64 = urlMatch[1].replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '')
      const padded = b64 + '=='.slice((b64.length * 3) % 4 === 0 ? 4 : (b64.length * 3) % 4)
      const binary = atob(padded)
      if (binary.length < 21) return null
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      const key = bytes.slice(5, 21)
      // Reject all-zero key (device with no encryption configured)
      if (key.every(b => b === 0)) return null
      return key
    } catch {
      return null
    }
  }

  // 32-char hex string
  if (/^[0-9a-fA-F]{32}$/.test(s)) {
    const bytes = new Uint8Array(16)
    for (let i = 0; i < 16; i++) bytes[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16)
    if (bytes.every(b => b === 0)) return null
    return bytes
  }

  return null
}

/** Wait for the next BLE notification on a characteristic. */
function waitForNotification(
  char: BluetoothRemoteGATTCharacteristic,
  timeoutMs = 10000
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      char.removeEventListener('characteristicvaluechanged', handler)
      reject(new Error('BLE notification timeout'))
    }, timeoutMs)
    function handler(event: Event) {
      clearTimeout(timer)
      char.removeEventListener('characteristicvaluechanged', handler)
      const dv = (event.target as BluetoothRemoteGATTCharacteristic).value!
      resolve(new Uint8Array(dv.buffer))
    }
    char.addEventListener('characteristicvaluechanged', handler)
  })
}

/**
 * Run the two-step OpenDisplay auth handshake (command 0x0050).
 * Throws if the device rejects the key or times out.
 */
export async function authenticate(
  char: BluetoothRemoteGATTCharacteristic,
  masterKey: Uint8Array
): Promise<OdSession> {
  // Step 1: request server nonce
  await char.writeValueWithoutResponse(new Uint8Array([0x00, 0x50, 0x00]))
  const challenge = await waitForNotification(char)

  if (challenge.length < 19) throw new Error(`Auth challenge too short (${challenge.length} bytes)`)
  const status1 = challenge[2]
  if (status1 === 0x02) throw new Error('Auth failed: session already exists — disconnect and reconnect')
  if (status1 !== 0x00) throw new Error(`Auth challenge rejected (status ${status1})`)

  const serverNonce = challenge.slice(3, 19)
  const deviceId = challenge.length >= 23 ? challenge.slice(19, 23) : DEFAULT_DEVICE_ID

  // Step 2: prove knowledge of master key
  const clientNonce = crypto.getRandomValues(new Uint8Array(16))
  const cmacInput = new Uint8Array(16 + 16 + deviceId.length)
  cmacInput.set(serverNonce, 0)
  cmacInput.set(clientNonce, 16)
  cmacInput.set(deviceId, 32)
  const challengeResponse = await aesCmac(masterKey, cmacInput)

  const step2 = new Uint8Array(2 + 16 + 16)
  step2[0] = 0x00; step2[1] = 0x50
  step2.set(clientNonce, 2)
  step2.set(challengeResponse, 18)
  await char.writeValueWithoutResponse(step2)

  const success = await waitForNotification(char)
  if (success.length < 3) throw new Error(`Auth success response too short (${success.length} bytes)`)
  const status2 = success[2]
  if (status2 !== 0x00) throw new Error(`Auth failed: wrong key (status ${status2})`)

  const sessionKey = await deriveSessionKey(masterKey, clientNonce, serverNonce, deviceId)
  const sessionId = await deriveSessionId(sessionKey, clientNonce, serverNonce)
  return { sessionKey, sessionId, counter: 0 }
}

/**
 * Encrypt a command for sending to the device.
 * Wire format: cmd(2) || nonce_full(16) || ciphertext || tag(12).
 * Increments session.counter.
 */
export async function encryptCommand(
  session: OdSession,
  cmdCode: number,
  payload: Uint8Array
): Promise<Uint8Array> {
  // Full nonce: sessionId(8) || counter as big-endian 8 bytes
  const nonceFull = new Uint8Array(16)
  nonceFull.set(session.sessionId, 0)
  const ctr = session.counter++
  const view = new DataView(nonceFull.buffer)
  view.setUint32(8, Math.floor(ctr / 0x100000000), false)
  view.setUint32(12, ctr >>> 0, false)

  const ccmNonce = nonceFull.slice(3)  // 13 bytes
  const cmd = new Uint8Array([cmdCode >> 8, cmdCode & 0xFF])
  // Plaintext to CCM: [len(payload):1][payload]
  const plaintext = new Uint8Array(1 + payload.length)
  plaintext[0] = payload.length
  plaintext.set(payload, 1)

  const ciphertextAndTag = await aesCcmEncrypt(session.sessionKey, ccmNonce, cmd, plaintext)

  const out = new Uint8Array(2 + 16 + ciphertextAndTag.length)
  out.set(cmd, 0)
  out.set(nonceFull, 2)
  out.set(ciphertextAndTag, 18)
  return out
}

/**
 * Decrypt an encrypted notification from the device.
 * Wire format: cmd(2) || nonce_full(16) || ciphertext || tag(12).
 */
export async function decryptResponse(
  session: OdSession,
  raw: Uint8Array
): Promise<{ cmd: number; payload: Uint8Array }> {
  // Minimum: cmd(2) + nonce(16) + plaintext_min(1) + tag(12) = 31
  if (raw.length < 31) throw new Error(`Encrypted response too short (${raw.length} bytes)`)

  const cmd = (raw[0] << 8) | raw[1]
  const nonceFull = raw.slice(2, 18)
  const body = raw.slice(18)
  const ciphertext = body.slice(0, body.length - 12)
  const tag = body.slice(body.length - 12)
  const ccmNonce = nonceFull.slice(3)
  const ad = raw.slice(0, 2)

  const plaintext = await aesCcmDecrypt(session.sessionKey, ccmNonce, ad, ciphertext, tag)
  const payloadLen = plaintext[0]
  return { cmd, payload: plaintext.slice(1, 1 + payloadLen) }
}
