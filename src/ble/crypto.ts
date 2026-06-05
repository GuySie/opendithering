// AES-128-CCM and AES-128-CMAC for OpenDisplay BLE encryption.
// Implemented on top of Web Crypto AES-CBC (no CCM native support in browsers).
// Matches the firmware's mbedtls/CryptoCell implementations exactly.

const _DEVICE_ID = new Uint8Array([0x00, 0x00, 0x00, 0x01])
const TAG_LEN = 12

// Web Crypto requires ArrayBuffer (not the broader ArrayBufferLike).
// Cast to ArrayBuffer is safe in browser context; SharedArrayBuffer is never used here.
function ab(u: Uint8Array): ArrayBuffer {
  return (u.buffer as ArrayBuffer).slice(u.byteOffset, u.byteOffset + u.byteLength)
}

async function importCbcKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', ab(raw), 'AES-CBC', false, ['encrypt'])
}

// AES single-block encryption. Uses CBC with a zero IV; slicing the first
// 16 bytes of the padded output gives AES-ECB semantics for one block.
async function aesBlock(key: CryptoKey, input: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const ct = await crypto.subtle.encrypt({ name: 'AES-CBC', iv: new Uint8Array(16) }, key, ab(input))
  return new Uint8Array(ct).slice(0, 16)
}

function xor(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length)
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i]
  return out
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const len = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(len)
  let off = 0
  for (const p of parts) { out.set(p, off); off += p.length }
  return out
}

// GF(2^128) left-shift-by-one used in CMAC subkey generation (RFC 4493 §2.3).
function dbl(b: Uint8Array): Uint8Array {
  const out = new Uint8Array(16)
  let carry = 0
  for (let i = 15; i >= 0; i--) {
    out[i] = ((b[i] << 1) | carry) & 0xff
    carry = b[i] >> 7
  }
  if (carry) out[15] ^= 0x87  // XOR with Rb = 0x..87 when MSB was 1
  return out
}

// CBC-MAC over data that is already padded to a 16-byte boundary.
async function cbcMac(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  let mac = new Uint8Array(16)
  for (let i = 0; i < data.length; i += 16) {
    mac = await aesBlock(key, xor(mac, data.slice(i, i + 16)))
  }
  return mac
}

// AES-128-CMAC (RFC 4493).
async function aesCmac(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  const L = await aesBlock(key, new Uint8Array(16))
  const K1 = dbl(L)
  const K2 = dbl(K1)

  const blockCount = Math.max(1, Math.ceil(data.length / 16))
  const padded = new Uint8Array(blockCount * 16)
  padded.set(data)

  const isComplete = data.length > 0 && data.length % 16 === 0
  if (!isComplete) padded[data.length] = 0x80  // ISO/IEC 7816-4 padding

  const lastOff = (blockCount - 1) * 16
  const subkey = isComplete ? K1 : K2
  for (let i = 0; i < 16; i++) padded[lastOff + i] ^= subkey[i]

  return cbcMac(key, padded)
}

// Produce `length` bytes of AES-CCM CTR keystream starting from `A`.
// CCM uses q=2, so the counter occupies the rightmost 2 bytes of the
// 16-byte counter block.
async function ccmKeystream(key: CryptoKey, A: Uint8Array, length: number): Promise<Uint8Array> {
  if (length === 0) return new Uint8Array(0)
  const out = new Uint8Array(length)
  const ctr = new Uint8Array(A)
  for (let off = 0; off < length; off += 16) {
    const block = await aesBlock(key, ctr)
    const n = Math.min(16, length - off)
    out.set(block.slice(0, n), off)
    // Increment counter (rightmost 2 bytes, big-endian, no carry past byte 14)
    const lo = ctr[15] + 1
    ctr[15] = lo & 0xff
    if (lo > 0xff) ctr[14] = (ctr[14] + 1) & 0xff
  }
  return out
}

// ── Public API ────────────────────────────────────────────────────────────────

export function parseHexKey(hex: string): Uint8Array {
  const h = hex.replace(/\s/g, '')
  if (h.length !== 32 || !/^[0-9a-fA-F]+$/.test(h)) {
    throw new Error('Encryption key must be 32 hex characters (16 bytes)')
  }
  const out = new Uint8Array(16)
  for (let i = 0; i < 16; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16)
  return out
}

// Derives a per-session AES-128 key from the master key and both nonces.
// Matches firmware deriveSessionKey().
export async function deriveSessionKey(
  masterKeyBytes: Uint8Array,
  clientNonce: Uint8Array,
  serverNonce: Uint8Array,
  deviceId: Uint8Array = _DEVICE_ID,
): Promise<Uint8Array> {
  const key = await importCbcKey(masterKeyBytes)
  const label = new TextEncoder().encode('OpenDisplay session')
  const cmacInput = concat(label, new Uint8Array([0x00]), deviceId, clientNonce, serverNonce, new Uint8Array([0x00, 0x80]))
  const intermediate = await aesCmac(key, cmacInput)
  // AES-ECB(master_key, counter_be(1, 8 bytes) || intermediate[0:8])
  const counter = new Uint8Array(8); counter[7] = 1
  return aesBlock(key, concat(counter, intermediate.slice(0, 8)))
}

// Derives the 8-byte session ID. Matches firmware deriveSessionId().
export async function deriveSessionId(
  sessionKeyBytes: Uint8Array,
  clientNonce: Uint8Array,
  serverNonce: Uint8Array,
): Promise<Uint8Array> {
  const key = await importCbcKey(sessionKeyBytes)
  return (await aesCmac(key, concat(clientNonce, serverNonce))).slice(0, 8)
}

// Computes the client's CMAC challenge proof for authenticate step 2.
// CMAC(master_key, server_nonce || client_nonce || device_id)
export async function computeChallengeResponse(
  masterKeyBytes: Uint8Array,
  serverNonce: Uint8Array,
  clientNonce: Uint8Array,
  deviceId: Uint8Array = _DEVICE_ID,
): Promise<Uint8Array> {
  const key = await importCbcKey(masterKeyBytes)
  return aesCmac(key, concat(serverNonce, clientNonce, deviceId))
}

// Encrypts a single OpenDisplay BLE command.
// Returns: [cmd:2][nonce_full:16][ciphertext][auth_tag:12]
// Plaintext inside CCM: [len(payload):1][payload]
// AAD: the 2-byte command code
export async function encryptCommand(
  sessionKeyBytes: Uint8Array,
  sessionId: Uint8Array,
  counter: number,
  cmd: readonly [number, number],
  payload: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await importCbcKey(sessionKeyBytes)

  // nonce_full = session_id(8) || counter_be(8)
  const nonceFull = new Uint8Array(16)
  nonceFull.set(sessionId, 0)
  const nv = new DataView(nonceFull.buffer)
  nv.setUint32(8, Math.floor(counter / 0x100000000) >>> 0, false)
  nv.setUint32(12, counter >>> 0, false)
  const ccmNonce = nonceFull.slice(3)  // 13 bytes

  const plaintext = concat(new Uint8Array([payload.length]), payload)
  const aadBytes = new Uint8Array([cmd[0], cmd[1]])

  // B0: flags(1) + ccmNonce(13) + msgLen_be(2)
  // flags = 0x69 = Adata(1)=1, M'=(t-2)/2=5, q-1=1
  const B0 = new Uint8Array(16)
  B0[0] = 0x69
  B0.set(ccmNonce, 1)
  B0[14] = (plaintext.length >> 8) & 0xff
  B0[15] = plaintext.length & 0xff

  // AAD block: [0x00][len(aad)] || aad, padded to 16-byte boundary
  const aadBlock = new Uint8Array(Math.ceil((2 + aadBytes.length) / 16) * 16)
  aadBlock[1] = aadBytes.length
  aadBlock.set(aadBytes, 2)

  // Message block padded to 16-byte boundary
  const ptBlock = new Uint8Array(Math.ceil(Math.max(plaintext.length, 1) / 16) * 16)
  ptBlock.set(plaintext)

  const T = await cbcMac(key, concat(B0, aadBlock, ptBlock))

  // Counter block A0 = [q-1=1][ccmNonce][00 00]
  const A0 = new Uint8Array(16)
  A0[0] = 0x01
  A0.set(ccmNonce, 1)
  const S0 = await ccmKeystream(key, A0, 16)

  // Counter block A1: same as A0 but counter byte = 1
  const A1 = new Uint8Array(A0)
  A1[15] = 1
  const Sn = await ccmKeystream(key, A1, plaintext.length)

  const ciphertext = xor(plaintext, Sn)
  const tag = xor(T.slice(0, TAG_LEN), S0.slice(0, TAG_LEN))

  return concat(aadBytes, nonceFull, ciphertext, tag)
}
