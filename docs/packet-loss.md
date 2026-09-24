# Packet loss

Realtime audio runs over lossy transports. Opus has two complementary tools for
this, and `libmlow-wasm` exposes both: **packet-loss concealment** (PLC) on the
decoder, and **in-band forward error correction** (FEC) across encoder and
decoder. On the MLow path there is a third: a **secondary (RED) encoder** that
emits a separate redundant payload.

## Packet-loss concealment (PLC)

When a packet never arrives, ask the decoder to synthesize a replacement frame
from its internal state. This keeps playback continuous instead of clicking or
dropping to silence.

```ts
// A packet arrived: decode it normally.
const frame = decoder.decode(packet);

// The next packet was lost: conceal one frame.
const concealed = decoder.decodePacketLoss(); // defaults to a 20 ms frame
```

Pass an explicit frame size when your frames are not 20 ms:

```ts
decoder.decodePacketLoss(480);      // conceal a 10 ms frame at 48 kHz
decoder.decodePacketLossFloat(960); // Float32 variant
```

`decodePacketLoss(frameSize)` is exactly equivalent to `decode(null, { frameSize })`:

```ts
const concealed = decoder.decode(null, { frameSize: 960 });
```

That equivalence is why `decodeFrames` treats a `null` entry as a lost packet —
a mixed array of packets and gaps decodes in one call:

```ts
const frames = decoder.decodeFrames([p0, null, p2]); // p1 was lost
```

PLC frame sizes must be a multiple of 2.5 ms (the Opus granularity), from 2.5 ms
up to 120 ms. An invalid size throws a `RangeError`.

## Forward error correction (FEC)

FEC embeds a low-bitrate copy of the previous frame inside the current packet.
If frame _N_ is lost but frame _N+1_ arrives, the decoder can reconstruct _N_
from _N+1_'s FEC data — higher quality than PLC alone.

### Encode with FEC

Enable FEC and tell the encoder how lossy the channel is. The packet-loss
percentage drives how much redundancy Opus spends:

```ts
const encoder = await createEncoder({
  fec: true,
  packetLossPercent: 15, // expected loss; tune to your transport
});
```

Both are also settable at runtime:

```ts
encoder.setFec(true);
encoder.setPacketLossPercent(15);
```

FEC only helps when the bitrate has room for the redundant copy. Pair it with a
sensible bitrate and, for speech, `Signal.Voice` — see
[Encoder tuning](encoder-tuning.md).

### Decode the recovered frame

When you detect a gap and the **next** packet is in hand, decode that next
packet with `decodeFec` to recover the lost frame first, then decode it again
normally for its own audio:

```ts
// frame N was lost; we have packet N+1
const recovered = decoder.decode(nextPacket, {
  decodeFec: true,
  frameSize: 960, // size of the lost frame you are recovering
});

const current = decoder.decode(nextPacket); // now decode N+1 itself
```

`decodeFec` requires a real packet to read the redundant data from — combining
`decodeFec: true` with a `null` packet throws a `RangeError`. When no next
packet is available either, fall back to `decodePacketLoss`.

## RED (secondary encoder)

MLow has a third option that in-band FEC does not cover: **RED**, the redundancy
WhatsApp switches on when the network gets bad (payload `mlow-red-1`). Where FEC
hides a low-rate copy of the previous frame *inside* the current packet, RED
produces a low-rate copy of each frame as a **separate payload**, from a second
encoder that reuses the primary one's analysis. The copy of a frame travels with
the packet after it, so a receiver that loses a packet can decode the copy from
the next one instead.

`libmlow-wasm` exposes it on the encoder, on the SMPL path (`useSmpl: true`).
RED cannot be combined with DTX: `setSecondaryBitrate()` throws while DTX is on,
and `setDtx(true)` throws while RED is on.

### Configure once

```ts
const encoder = await createEncoder({
  channels: 1,
  sampleRate: 16_000,
  frameSize: 320,
  useSmpl: true,
});

encoder.setSecondaryBitrate(4_000); // bits/s for the redundant copy
encoder.setSecondaryComplexity(3);  // 0-10, usually below the primary
```

### Encode per frame

Call `encode()` for the frame, then `encodeSecondary()` right after:

```ts
const primary = encoder.encode(pcm);
const redundant = encoder.encodeSecondary(); // a low-rate copy of the same frame
```

The copy is of the frame you just encoded, not of the one before it. Sending it
one packet later is up to you:

```ts
let pendingCopy: Uint8Array | null = null;
for (const pcm of frames) {
  const primary = encoder.encode(pcm);
  const copy = encoder.encodeSecondary();
  send({ primary, redundant: pendingCopy }); // packet i carries the copy of frame i-1
  pendingCopy = copy;
}
```

`encodeSecondary()` has to follow every `encode()`, from the first frame on.
Calling it twice in a row, or after more than one `encode()`, throws: the codec
aborts the whole WASM module in those cases, and it cannot pick up a secondary
stream that starts late. To switch RED on and off as the network changes, keep
producing the copy for every frame and decide per packet whether to send it.
The secondary encoder adds about 70 us per 20 ms frame.

`encodeSecondary` accepts `{ maxPacketBytes }` to cap its output buffer, same as
`encode`.

### Recover a lost frame from its copy

The copy is an ordinary MLow packet. When packet `i` is lost and packet `i + 1`
arrives with the copy of frame `i`, decode the copy **with the same decoder, in
place of the lost packet**:

```ts
function frameAt(i) {
  if (packets[i]) return decoder.decode(packets[i].primary);
  const copy = packets[i + 1]?.redundant; // the copy of frame i rides in packet i + 1
  if (copy) return decoder.decode(copy);
  return decoder.decodePacketLoss(320);
}
```

This needs one packet of look-ahead. Measured on recorded speech, with the
primary at 13.7 kbps and the copy at 4.8 kbps, against the same stream decoded
with no loss:

| loss | lost frame, PLC | lost frame, RED | whole stream, PLC | whole stream, RED |
| --- | --- | --- | --- | --- |
| 1 in 10 | 2.0 dB | 8.4 dB | 3.4 dB | 12.3 dB |
| 1 in 5 | 1.2 dB | 8.3 dB | 2.0 dB | 10.6 dB |
| 1 in 3 | -0.1 dB | 7.7 dB | 0.5 dB | 8.5 dB |

Decoding the copy in the same decoder keeps its state in step, so the frame
after the loss comes out clean as well: 8.0 dB, against -0.3 dB after PLC. A
separate decoder fed only the copies recovers the lost frame but not the one
after it.

How WhatsApp lays out the primary and the copy inside one RTP payload
(`mlow-red-1`) is not implemented here. The transport framing is up to the
application.

### Methods

| Method | Returns | Description |
| --- | --- | --- |
| `setSecondaryBitrate(bitrate)` | `void` | Bitrate for the redundant copy, in bits/s. |
| `setSecondaryComplexity(complexity)` | `void` | Complexity `0`-`10` for the secondary encoder. |
| `encodeSecondary(options?)` | `Uint8Array` | A low-rate copy of the frame just passed to `encode()`. |

### Limitation: no secondary reset

The Meta binary has an `opus_reset_secondary` entry point; the open-source
opus_mlow does not export one, so these bindings cannot offer it. Once the
secondary stream is interrupted there is no way to resume it short of
recreating the encoder.

## A realtime receive loop

Putting it together for a jitter-buffer-style consumer:

```ts
function handlePacket(decoder, packet, lostFrameSize) {
  if (packet === null) {
    // Nothing arrived and no future packet to recover from.
    return decoder.decodePacketLoss(lostFrameSize);
  }
  return decoder.decode(packet);
}
```

For the FEC and RED recovery paths, hold one packet of look-ahead so a lost
frame can be rebuilt from the packet that follows it.

## Next

- [Encoder tuning](encoder-tuning.md) — bitrate and signal settings that make
  FEC effective.
- [Repacketizer](repacketizer.md): the multiframe packing RED payloads ride
  alongside.
- [API reference](api-reference.md) — PLC and FEC method signatures.
