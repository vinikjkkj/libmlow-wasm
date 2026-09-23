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
produces that copy as a **separate payload** from a second, independent encoder,
which you send alongside the primary one.

`libmlow-wasm` exposes it on the encoder, on the SMPL path (`useSmpl: true`).

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

Call `encode()` for the frame, then `encodeSecondary()` right after, on the same
frame:

```ts
const primary = encoder.encode(pcm);
const redundant = encoder.encodeSecondary(); // the copy of the PREVIOUS frame
```

The secondary encoder is one frame behind by design — the payload it returns
carries the frame *before* the one you just encoded. That is what makes it
useful on loss, and it means the very first call has nothing to encode yet:
prime the encoder with one `encode()` before you start reading secondary
payloads.

`encodeSecondary` accepts `{ maxPacketBytes }` to cap its output buffer, same as
`encode`.

### Methods

| Method | Returns | Description |
| --- | --- | --- |
| `setSecondaryBitrate(bitrate)` | `void` | Bitrate for the redundant copy, in bits/s. |
| `setSecondaryComplexity(complexity)` | `void` | Complexity `0`–`10` for the secondary encoder. |
| `encodeSecondary(options?)` | `Uint8Array` | The redundant payload for the previous frame. |

### Limitation: no secondary reset

The Meta binary has an `opus_reset_secondary` entry point; the open-source
opus_mlow does not export one, so these bindings cannot offer it. Practically:
once the secondary encoder's notion of "previous frame" is out of step with the
stream — after a DTX gap, for instance — there is no way to resynchronize it
short of recreating the encoder.

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

For the FEC-recovery path, hold one packet of look-ahead so a lost frame can be
rebuilt from the packet that follows it.

## Next

- [Encoder tuning](encoder-tuning.md) — bitrate and signal settings that make
  FEC effective.
- [Repacketizer](repacketizer.md) — the multiframe packing RED payloads ride
  alongside.
- [API reference](api-reference.md) — PLC and FEC method signatures.
