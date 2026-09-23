# Packet inspection

`getPacketInfo` reports what a raw Opus packet contains — duration, frame count,
channels, and bandwidth — and validates it along the way. Worth knowing how:
it **decodes the packet** with an internal decoder and discards the PCM. So the
answer is stronger than a header check — it tells you the packet is actually
decodable, not merely that its first bytes parse — and it costs a full decode.

The internal decoder is created once and reused across calls, rather than built
and torn down per packet, so what you pay is the decode itself. That is still a
decode on every call: if you are on a high-frequency path and only need the
structural metadata, count it in.

```ts
import { getPacketInfo } from "libmlow-wasm";

const info = await getPacketInfo(packet);
info.durationMs;      // 20
info.frames;          // 1
info.samples;         // 960  (per channel, at the given sample rate)
info.samplesPerFrame; // 960
info.channels;        // 1 | 2
info.sampleRate;      // 48000
info.bandwidth;       // Bandwidth.Fullband
```

Like the factories, the first call lazily loads the shared WASM module; later
calls are cheap.

## Sample rate

Opus packets do not carry their sample rate in band, so `durationMs`, `samples`,
and `samplesPerFrame` are computed against the rate you pass — `48000` Hz by
default. Pass the rate the stream was encoded at to get accurate timing:

```ts
const info = await getPacketInfo(packet, { sampleRate: 16000 });
```

Only the [supported rates](api-reference.md#limits) (`8000`, `12000`, `16000`,
`24000`, `48000`) are accepted; anything else throws a `RangeError`.

## What you get back

| Field | Type | Meaning |
| --- | --- | --- |
| `durationMs` | `number` | Total audio in the packet, `2.5`–`120` ms. |
| `frames` | `number` | Opus frames packed into the packet (`1`–`48`). |
| `samples` | `number` | Total samples per channel at `sampleRate`. |
| `samplesPerFrame` | `number` | Samples per channel in one frame. |
| `channels` | `1 \| 2` | Channel count encoded in the packet. |
| `sampleRate` | `SampleRate` | The rate the figures were computed against. |
| `bandwidth` | `Bandwidth` | Coded bandwidth — `Narrowband`…`Fullband`. |

`samples === frames * samplesPerFrame`, and `durationMs === samples / sampleRate
* 1000`. The result is read-only.

## Sizing a decoder

Use the duration to confirm a packet fits a decoder's
[output capacity](decoding.md#output-capacity) before decoding:

```ts
const info = await getPacketInfo(packet);
if (info.durationMs > 60) {
  // larger than this decoder's 60 ms buffer — raise maxFrameSize or skip.
}
const frame = decoder.decode(packet);
```

## MLow packets

`getMlowPacketInfo` is the MLow-aware counterpart. It parses the packet with the
`mlow_packet_*` helpers instead of the generic Opus ones, so it reads the SMPL
framing correctly, and it returns everything `getPacketInfo` does plus the MLow
flags and the decoded TOC:

```ts
import { getMlowPacketInfo, MlowMode } from "libmlow-wasm";

const info = await getMlowPacketInfo(packet, { sampleRate: 16000 });

info.durationMs;      // 60   (a 3 x 20 ms multiframe packet)
info.frames;          // 3
info.samples;         // 960  (per channel, at the given sample rate)
info.samplesPerFrame; // 320
info.channels;        // 1 | 2
info.sampleRate;      // 16000
info.bandwidth;       // Bandwidth.Narrowband ... Fullband
info.hasVadFlag;      // VAD bit set in the TOC
info.hasFecContent;   // the packet carries FEC content
info.toc;             // { mode, bandwidth, samplesPerFrame, stereo }
```

Unlike `getPacketInfo`, this one does not run a validating decode — it parses.

### Which codec produced the packet

`toc.mode` is the discriminator: it says whether the packet is native MLow or a
CELT fallback. Compare against the exported `MlowMode` rather than raw numbers:

```ts
import { MlowMode } from "libmlow-wasm";

const info = await getMlowPacketInfo(packet, { sampleRate: 16000 });

if (info.toc.mode === MlowMode.Smpl) {
  // native SMPL/MLow — what a WhatsApp call carries
} else if (info.toc.mode === MlowMode.Celt) {
  // CELT fallback
}
```

| Member | Value | Meaning |
| --- | --- | --- |
| `MlowMode.Smpl` | `4` | Native SMPL/MLow layout. |
| `MlowMode.Celt` | `3` | CELT fallback (TOC bits 7-6 are `0b11`). |

### MLow fields

| Field | Type | Meaning |
| --- | --- | --- |
| `hasVadFlag` | `boolean` | The TOC's VAD bit — the frame was coded as speech. |
| `hasFecContent` | `boolean` | The packet carries FEC content. |
| `toc.mode` | `MlowMode` | `Smpl` or `Celt` — see above. |
| `toc.bandwidth` | `number` | Raw bandwidth field from the TOC. |
| `toc.samplesPerFrame` | `number` | Samples per frame as coded in the TOC. |
| `toc.stereo` | `number` | Stereo bit, `0` or `1`. |

The rest of the fields (`durationMs`, `frames`, `samples`, `samplesPerFrame`,
`channels`, `sampleRate`, `bandwidth`) mean exactly what they do for
`getPacketInfo` above.

### SMPL TOC layout

For debugging on the wire, the first byte of a native SMPL frame decomposes as
(verified against `smpl/smpl_param_coding.c` in the codec):

| Bit(s) | Meaning |
| --- | --- |
| `7` | SID (silence descriptor) |
| `6` | VAD |
| `5` | Rate: `0` = 16 kHz, `1` = 32 kHz |
| `4`–`3` | Frame duration: `{10, 20, 60, 120}` ms |
| `2` | Low-rate mode |
| `1` | FEC — effective only when VAD is also set |
| `0` | Stereo |

In a multiframe packet this is the TOC of each *sub-frame*; the packet's own
first byte is the multiframe marker instead. See
[Repacketizer](repacketizer.md#packet-layout) for that layout.

## Invalid packets

A corrupt or truncated packet surfaces the libopus error as an
[`OpusError`](errors.md); an empty `Uint8Array` throws a `RangeError` before
reaching WASM.

```ts
import { OpusError } from "libmlow-wasm";

try {
  await getPacketInfo(suspectPacket);
} catch (err) {
  if (err instanceof OpusError) {
    // not a valid Opus packet
  }
}
```

## Next

- [Errors & validation](errors.md) — how failures surface.
- [Decoding](decoding.md) — turn the packet into PCM.
- [Repacketizer](repacketizer.md) — build the multiframe packets this inspects.
- [API reference](api-reference.md#top-level-functions) — full signature.
