# Plan: faster OpenDisplay BLE uploads

Status: implemented 2026-10-08 (see CLAUDE.md "OpenDisplay BLE upload"). Researched 2026-10-08 against
`OpenDisplay/opendisplay-protocol` (spec v2.2), `OpenDisplay/Firmware` (2.26.7),
`OpenDisplay/py-opendisplay` (7.18.1) and `OpenDisplay/opendisplay.org`
(`httpdocs/js/ble-common.js`, the official Web Bluetooth client).

**Outcome, where it differs from the plan below:**
- Compression pays off more than estimated. Even uniform random 6-colour noise deflates to ~66 % (6 inks in a 4-bit nibble leave slack), so the "< 90 %" skip rule became "use it whenever it's smaller".
- The pipe sender re-probes after 600 ms when a retransmit is outstanding, and aborts on 45 s of total silence instead of after 3 probes. In simulation, a lost retransmit otherwise stalled the whole window for the 15 s ACK timeout.
- 4-grey (scheme 5) turned out to need two bitplanes through a panel grey-code table, according to py-opendisplay. That isn't fixed, and it's noted in CLAUDE.md.

## Where we are

`src/ble/opendisplay.ts` implements the original direct-write flow as it was in
March 2026:

- `0x70` START with no payload, then `0x71` chunks of 230 B (154 B encrypted),
  then `0x72` END, then wait for `0x73`.
- **Lock-step**: one chunk in flight. Every chunk waits for its `0x71` ACK
  notification before the next one goes out, so throughput is roughly one chunk
  per two BLE connection intervals, whatever the link could carry.
- **No compression**: a 800×480 Spectra 6 frame is 192,000 B, i.e. about 835
  round trips.
- We never read the device config, so we don't know what the device supports.

## What changed upstream

OpenDisplay added three things that make uploads faster.

### 1. zlib-compressed direct write

This works on all four firmware families (Firmware, NRF54, Silabs, NRF52811).

- START becomes `[0x00][0x70][uncompressed_size:4 LE][first zlib bytes…]`. The
  START payload can be up to 200 B plaintext, or must fit the 154 B budget when
  encrypted. The rest of the zlib stream goes in ordinary `0x71` chunks, still
  lock-step.
- The firmware inflates the stream as it arrives (tinfl/uzlib, built with
  `OPENDISPLAY_ZLIB_WINDOW_BITS=9`). It **rejects any zlib header that
  advertises a window larger than 9 bits (512 B)**. That has two consequences
  for us:
  - The browser's built-in `CompressionStream('deflate')` is unusable, because it
    always writes a 15-bit window and has no option to change it.
  - We need a deflate library that takes a `windowBits` setting. The official
    web client uses `pako.deflate(data, { level: 9, windowBits: 9 })`.
- The device config must allow it. The display packet's `transmission_modes`
  byte has bit `0x01` (streaming decompression, so no size cap) and bit `0x02`
  (zip). The web client compresses only when both are set. py-opendisplay
  accepts either bit, and with only `0x02` it caps the compressed size at 50 KB.
- If the device rejects the compressed START (`[0xFF][0x70]` or the legacy
  `[0xFF][0xFF]`), send an uncompressed START and continue the same session.
- **How much this gains depends on the image.** Flat illustrations compress
  well. Dithered photos compress poorly: 6 colours carry at most ~2.6 bits of
  information per 4-bit nibble, and DBS and blue-noise output is close to
  incompressible noise. For our typical output, expect maybe 1.2–2× from
  compression alone. Measure this before relying on it (see Phase 1).

### 2. PIPE_WRITE sliding window (`0x0080`–`0x0082`)

This is the main gain. It is supported only on the combined nRF52840 + ESP32
`Firmware`, from **release 2.20 (2026-07-14)**, and not on NRF54, Silabs or
NRF52811.

- **`0x80` START**: the client sends
  `[0x00][0x80][ver=1][flags][req_window][req_ack_every][client_max_frame:2 LE][total_size:4 LE]`.
  - `flags` bit0 means the stream is zlib (same 9-bit window rule).
  - `total_size` is the *decompressed* byte count.
  - The device replies
    `[0x00][0x80][ver][max_window][max_ack_every][max_frame:2 LE][resp_flags]`.
  - `resp_flags` bit0 means selective repeat is supported.
  - The effective values are `W = min(req, dev, 32)`, `N = min(req, dev, W)` and
    `frame = min(244, dev)`. Firmware allows a window of up to 32, or 16 on
    classic ESP32 boards with little DRAM.
- **`0x81` DATA**: the client sends `[0x00][0x81][seq:1][data…]`.
  - `seq` is the chunk index mod 256.
  - Data per frame is 241 B plaintext (frame 244 − 3), or 212 B encrypted (frame
    244 − 31 for the envelope − 1 for seq).
  - Up to W frames are in flight, all sent with `writeValueWithoutResponse`.
- **ACKs**: every N frames the device sends a SACK,
  `[0x00][0x81][highest_seen][ack_mask:4 LE]`, where mask bit i means chunk
  `highest_seen-1-i` arrived.
  - When a hole appears, retransmit only the missing chunk. Wait 2 ACKs
    (`PIPE_RETX_ACK_SPACING`) before repeating the same one.
  - Retransmit budget: `max(3W, ceil(chunks × 0.5))`. The web client found that
    Chrome's write-without-response **silently drops frames** when the
    controller buffer backs up, so large uploads need this many repairs.
  - Tail probe: if fewer than N frames are left unacked at the end, they never
    earn a cadence ACK. After about 600 ms, resend the oldest unacked chunk to
    draw out an ACK. Abort after 3 silent probes.
  - `[0xFF][0x81][err]…` is fatal.
- **Completion works differently in the two modes**, and this is easy to get
  wrong:
  - *Uncompressed*: when `total_size` is reached the device **auto-completes**.
    It sends a flush SACK, then an unsolicited `[0x00][0x82]`, then `0x73`/`0x74`.
    Do **not** send an END: it would be NACKed.
  - *Compressed*: once every chunk is acked, send `[0x00][0x82][refresh]`, skip
    any stray SACK, then wait for `[0x00][0x82]` and then `0x73`/`0x74`.
- **Fallback**: if there is no response to `0x80` within 15 s (pipe-less
  firmware), or the START is NACKed, fall back to the legacy `0x70` flow. If the
  NACK is err `0x02` on a compressed request, retry `0x80` once uncompressed
  first.
- **Gating**: both reference clients only try `0x80` when the config's
  `transmission_modes` **bit `0x10`** is set. That bit is *stored config*, not
  detected. A device flashed with pipe-capable firmware keeps the slow path until
  someone sets the bit with the OpenDisplay toolbox.
- **Encryption**: firmware 2.26.1 (PR #136) replaced strict nonce ordering with a
  ±32 sliding replay window. Pipe retransmits get a fresh, higher nonce, but
  frames can still arrive out of order. Encrypted pipe therefore needs
  **≥ 2.26.1**. Before that, an out-of-order frame was NACKed.

### 3. Write-without-response for `0x71`

We already do this. py-opendisplay only adopted it alongside the pipe work, so
there is nothing to port here.

### Other upstream fixes worth taking

- **Row padding** (web client `b66f4b1`, 2026-07-06): the firmware expects every
  row to start on a byte boundary, so a row is `ceil(w/8)` B for 1 bpp,
  `ceil(w/4)` B for 2 bpp and `ceil(w/2)` B for 4 bpp. Our `encodeImage()`
  packs the whole image as one bit stream instead. All our packers
  (bw, bwr planes, bwry, grayscale4, spectra6, grayscale8/16) are therefore
  wrong on panels whose width isn't a multiple of 8, 4 or 2 (e.g. the 122-px
  EP213). For widths that are already multiples, the output is byte-identical.
- **ACeP (scheme 7)** (web client `4c32fbb`, 2026-08-15): OpenDisplay now has a
  7-colour scheme. It uses nibble codes black 0, white 1, yellow 2, red 3,
  blue 4, green 5, orange 6. Note that blue and green differ from Spectra 6,
  where they are 5 and 6. Our `acep` palette could stop being "unsupported".
- **Timeouts**: END ACK can take up to ~60 s on Spectra and ACeP panels, because
  some firmware writes SPI or refreshes before acking. The web client uses 60 s
  and py-opendisplay uses 90 s. We currently allow 15 s for the start ACK and
  10 s or 30 s elsewhere (`waitForNotification`).

## Plan

### Phase 0: groundwork (needed by everything else)

1. **Notification queue.** Replace the add/remove-listener pattern with one
   persistent `characteristicvaluechanged` listener that pushes frames into a
   queue, read with `read(timeoutMs)`.
   - Today's `waitForNotification` is attached *after* the write. A fast ACK can
     arrive before the listener exists, and is then lost.
   - The pipe sender needs to read SACKs that arrive while it is still writing.
   - The encrypted path decrypts each frame as it is dequeued.
   - This mirrors `transport/notification-queue.ts` in `opendisplay-js` and
     py-opendisplay's connection queue.
2. **Config read (`0x0040`) right after connect**, after authentication when
   encrypted. The steps:
   - Collect the chunked response: the first chunk is `[echo:2][chunk#:2][total:2][…]`
     and later chunks are `[echo:2][chunk#:2][…]`.
   - Strip the wrapper `[len:2][version:1] … [crc:2]`.
   - Walk the TLV packets `[num][type][fixed-size data]` using py-opendisplay's
     size table (`_get_packet_size`). Packets have no length field, so the table
     is required.
   - Parse only the first display packet (`0x20`, 46 B, `<BBHHHHHHBBBBBBBBBB`)
     for `pixel_width`, `pixel_height`, `rotation`, `color_scheme` and
     `transmission_modes`.
   - Treat `[0xFF][0x40][0x00][0x00]` as "no config".
   - Cache the result in `bleState`, and treat any parse failure as "capabilities
     unknown", which means the legacy path.
   - **Payoff beyond speed**: we can warn when the dithered image's size or
     palette doesn't match the device's actual panel. Today that mismatch
     silently produces garbage on screen.
3. **Firmware version read (`0x0043`, always plaintext)**, used only for a hint.
   If the firmware is ≥ 2.20 but bit `0x10` is off, log or show "This device
   supports fast uploads; enable PIPE_WRITE in its config (OpenDisplay
   toolbox)".
4. **Row-padding fix** in `encodeImage()`: flush the accumulator at the end of
   each row for every packer. This can ship on its own straight away.
5. Raise the END/refresh timeouts to about 90 s, matching py-opendisplay.

### Phase 1: compressed direct write

1. Add `pako` as a dependency, loaded lazily with `await import('pako')` inside
   the upload path so it doesn't weigh on initial page load. Use
   `deflate(bytes, { level: 9, windowBits: 9 })`.
2. Gate: `transmission_modes & 0x01` (no size cap), or `& 0x02` with a
   compressed size under 50 KB. Also skip compression when the result isn't
   meaningfully smaller than the raw data (say < 90 %), since dithered noise can
   inflate.
3. START payload: `size:4 LE` followed by up to 196 B of zlib (or up to 150 B
   when encrypted). The remainder goes in `0x71` chunks as today. On a rejected
   START, resend an uncompressed START.
4. **Measure** compression ratios with a small script over our own output: FS,
   Dizzy and DBS on the sample illustrations and photos, guysie palette,
   800×480. If DBS photos only reach ~1.2×, say so in CLAUDE.md, so nobody
   expects compression to be the speed fix.

### Phase 2: PIPE_WRITE

1. A new `sendImagePipe()` in `opendisplay.ts`, with the protocol structured
   like `ble-common.js` `_pumpPipeWindow` and py-opendisplay `_send_pipe_chunks`:
   - Request W=16 and N=4. N=4 is the web client's choice, tighter than
     Python's 8, and suits Chrome's frame dropping.
   - Apply the min-rule, chunk at the negotiated frame size, and keep at most W
     frames past `windowBase`.
   - Selective repeat with ACK spacing 2. Rewind from `windowBase` instead when
     `resp_flags` bit0 is clear.
   - Tail-flush probes at 600 ms and a PTO limit of 3.
   - The scaled retransmit budget described above.
   - The two completion paths: auto-complete for uncompressed, explicit END for
     compressed.
2. The **encrypted** variant: `[seq][data]` becomes the inner plaintext of each
   `0x81` envelope, and every retransmit is re-encrypted with a fresh nonce,
   which `encryptCommand` already does by bumping `session.counter`.
   - Gate encrypted pipe on firmware ≥ 2.26.1 using the Phase 0 version read.
   - If the version is unknown, use the legacy path when encrypted.
3. Dispatcher order in `sendImage()`:
   1. If bit `0x10` is set, try pipe (compressed when Phase 1's gate passes).
   2. Otherwise, or on a pipe fallback, use compressed direct write.
   3. Otherwise use plain direct write.

   Cache "pipe probed negative" per connection so a 15 s silent probe happens at
   most once.
4. Progress: report by acked bytes, not sent bytes, so the bar doesn't sit at
   100 % while retransmits finish. Keep the `onProgress(sent, total)`
   signature.
5. Debug logging behind a flag, for example `localStorage['odBleDebug']`:
   negotiated W/N/frame, retransmit count, and elapsed time and B/s per upload.
   This is the only way to check the speedup on real hardware.

### Phase 3 (optional): ACeP over OpenDisplay

Map `acep` to scheme 7 with the 0–6 nibble table above. Confirm against the
device's `color_scheme` from the config read. Then remove `acep` from
`UNSUPPORTED_PALETTES`. This needs an ACeP OpenDisplay device to test on.

### Out of scope

- Partial refresh (`0x76`, and pipe-partial via `flags` bit1): this is for 1 bpp
  panels and incremental updates, which doesn't match a one-image-per-upload
  dithering tool.
- The LAN/WiFi transport (protocol §9).
- Pulling in `opendisplay-js` as a dependency: it was last touched 2026-07-23
  and doesn't implement PIPE_WRITE. Copying its notification-queue pattern is
  enough.

## Testing

No automated BLE tests exist, so this needs a manual matrix on real devices. Log
elapsed time per upload for each row.

| Case | Expected path |
|---|---|
| Firmware ≥ 2.20, bit `0x10` set, plaintext | pipe (compressed if bits allow) |
| Same, encrypted, firmware ≥ 2.26.1 | encrypted pipe |
| Firmware ≥ 2.20, bit `0x10` **unset** | compressed or plain direct write, plus the toolbox hint |
| Firmware < 2.20, or NRF54/Silabs | direct write. Pipe is never probed because the bit is unset |
| Compression bits unset | plain direct write, byte-identical to today |
| Width not a multiple of 8 (if a panel is available) | correct image after the row-padding fix |
| Disconnect mid-transfer | clean error, `bleState` cleared, reconnect works |

Plus `npm run build` for the type check. A small Node script could also
exercise the TLV parser on a captured config dump and the zlib header check
(`CMF >> 4) + 8 == 9`).

## Open questions

1. Which firmware is on the test device(s), and is `transmission_modes` bit
   `0x10` set? If it isn't, Phase 2 brings no visible gain until the config is
   updated.
2. Should we probe `0x80` even without bit `0x10`? It would make pipe work on
   un-reconfigured devices, but costs up to 15 s once per connection on old
   firmware, and both reference clients deliberately don't do it.
   Recommendation: no. Follow the gate and show the toolbox hint.

## Suggested order of commits

1. Row-padding fix (independent bug fix).
2. Notification queue, config read and firmware version read (no behaviour
   change except the size/palette mismatch warning and the hint).
3. Compressed direct write, with the measured ratios added to CLAUDE.md.
4. PIPE_WRITE, plaintext.
5. PIPE_WRITE, encrypted.
6. Update CLAUDE.md's "OpenDisplay BLE upload" section with the new protocol
   table and dispatcher order.
7. (Optional) ACeP scheme 7.
