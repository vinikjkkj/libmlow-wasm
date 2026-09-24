# Repacketizer

`opus_encode` emits one frame per packet. WhatsApp-style MLow does not travel
that way on the wire: it sends **20 ms native SMPL frames grouped into a single
multiframe packet**. The SMPL encode path does not do that grouping itself, so
packing is a separate step: that is what `createRepacketizer` is for.

How many frames land in one packet follows `M = (frame_duration_ms / 20) × fpp`.
The `minfpp`/`maxfpp` settings in the client belong to a bundling layer above the
codec, and RED travels in its own buffer without adding to `M`. Drive the count
from your own packetisation; `pack()` accepts 2 to 18.

> **Scope of verification.** Packets from `pack()` satisfy the acceptance checks
> read out of the client's decompiled parser: the `(b0 & 0x82) == 0x82` and
> `b0 < 0xC0` multiframe gate, the `0x39` fixed-bit mask shared by all
> sub-frames, and a frame count within 2..18. Decoding multiframe packets is
> checked bit-exact against independently produced reference vectors
> (`pnpm check-golden <vectorsDir>`). Neither is interoperation: **no packet from a real call
> has been compared against**, since the payload is SRTP-encrypted on the wire
> and stays inside the client's wasm module otherwise.

### The frame-count byte

`byte[1]` carries the count plainly. Bit 6 is a padding flag, set when a run of
`0xFF` padding-length bytes precedes the size table, and bit 7 is never used;
this is *not* the RFC 6716 code-3 encoding, where those bits mean VBR and
padding. The client's parser masks with `0x3F` and reads the per-frame size table
unconditionally, so packets from `pack()` parse correctly without the flag.

Incoming packets are handled the other way round: the client sets bit 6 when it
emits padding, and the upstream parser would read `0x43` as a frame count of 67
and reject it. The decoder clears that bit in its own staged copy before
parsing, leaving the caller's buffer untouched.

A 60 ms native frame (`frameSize: 960` at 16 kHz) and a multiframe packet of
20 ms frames are different bitstreams. If the target is WhatsApp's framing,
encode 20 ms frames and pack them.

## Create one

```ts
import { createRepacketizer } from "libmlow-wasm";

const repacketizer = await createRepacketizer();
```

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `maxPacketBytes` | `number` | `4000` | Ceiling for the packed packet; also sizes the `add()` staging area. |
| `useMlow` | `boolean` | `true` | Emit the MLow multiframe layout. `false` falls back to plain Opus repacketizing. |

Like the encoder and decoder factories, this shares the one lazily-loaded WASM
module, and it initializes the SMPL global tables when `useMlow` is on.

## Pack several frames at once

`pack` takes the frames, packs them, and returns the packet in one crossing into
WASM. Prefer it: it is the path with the least per-frame overhead:

```ts
import { Application, Signal, createEncoder, createRepacketizer } from "libmlow-wasm";

const encoder = await createEncoder({
  application: Application.Voip,
  bitrate: 6_000,
  channels: 1,
  frameSize: 320,      // 20 ms @ 16 kHz
  sampleRate: 16_000,
  signal: Signal.Voice,
  useSmpl: true,
});
const repacketizer = await createRepacketizer();

// Three consecutive 20 ms frames of capture.
const frames = [pcmA, pcmB, pcmC].map((pcm) => encoder.encode(pcm));

const packet = repacketizer.pack(frames); // one multiframe packet, 60 ms

encoder.free();
repacketizer.free();
```

`pack` re-initializes the underlying state, so anything queued with `add()`
before it is discarded.

## Pack incrementally

When frames arrive one at a time, queue them and emit when the packet is full:

```ts
repacketizer.reset();
repacketizer.add(frameA);
repacketizer.add(frameB);
repacketizer.add(frameC);

repacketizer.getFrameCount(); // 3
const packet = repacketizer.out();

repacketizer.reset(); // start the next packet
```

`out()` does not clear the queue: call `reset()` before building the next
packet. `outRange(begin, end)` emits the half-open range `[begin, end)` of the
queued frames instead of all of them:

```ts
const firstTwo = repacketizer.outRange(0, 2);
```

`add()` stages frames in a fixed buffer sized `18 * maxPacketBytes`, because the
underlying repacketizer holds pointers into it until `out()`. Overflowing it
throws a `RangeError` telling you to call `out()` or raise `maxPacketBytes`.

## Methods

| Method | Returns | Description |
| --- | --- | --- |
| `pack(frames, options?)` | `Uint8Array` | Pack `frames` into one packet in a single call. Resets queued state. |
| `reset()` | `void` | Clear the queued frames so the repacketizer can be reused. |
| `add(frame)` | `void` | Queue one frame for the next `out()`. |
| `getFrameCount()` | `number` | Frames queued so far. |
| `out(options?)` | `Uint8Array` | Emit every queued frame as one packet. |
| `outRange(begin, end, options?)` | `Uint8Array` | Emit `[begin, end)` of the queued frames. |
| `free()` | `void` | Release the underlying repacketizer. Idempotent. |
| `[Symbol.dispose]()` | `void` | Calls `free()`; enables `using` declarations. |

`pack`, `out`, and `outRange` accept `{ maxPacketBytes }` to override the
per-instance ceiling for that call.

| Property | Type | Description |
| --- | --- | --- |
| `useMlow` | `boolean` | Whether this instance emits the MLow multiframe layout (read-only). |

## Limits

- **18 frames per packet** (`MAX_MLOW_FRAMES_PER_PACKET`). More throws a
  `RangeError`; so does an empty array, and so does an empty frame.
- The packed packet must fit `maxPacketBytes`, or the codec returns a
  buffer-too-small [`OpusError`](errors.md).
- Decoding a multiframe packet needs decoder capacity for the **whole** packet:
  a 3×20 ms packet at 16 kHz decodes to 960 samples, so `maxFrameSize` has to be
  at least that. See [Output capacity](decoding.md#output-capacity).

```ts
const decoder = await createDecoder({
  channels: 1,
  sampleRate: 16_000,
  maxFrameSize: 960, // 3 x 20 ms
  useSmpl: true,
});
const pcm = decoder.decode(packet); // 960 samples
```

## Packet layout

Useful when reading bytes off the wire. An MLow multiframe packet is:

| Offset | Bytes | Meaning |
| --- | --- | --- |
| `0` | 1 | Multiframe marker. It is a multiframe packet when `(b0 & 0x82) === 0x82` and `b0 < 0xC0`. |
| `1` | 1 | Frame count, `2`-`18`. |
| `2`… | varies | `N - 1` frame lengths, varint-style. |
| then | rest | The `N` sub-frames, back to back, each with its own TOC byte. |

Each length is one byte when it is `<= 251`; otherwise it is two bytes and the
value is `b0 + 4 * b1`. The last frame's length is implicit: whatever remains
of the packet.

```ts
const isMultiframe = (packet[0]! & 0x82) === 0x82 && packet[0]! < 0xc0;
const frameCount = isMultiframe ? packet[1]! : 1;
```

`getMlowPacketInfo` reports the same frame count without hand-parsing: see
[Packet inspection](packet-info.md#mlow-packets).

## Next

- [Packet inspection](packet-info.md): read a packed packet's frame count,
  duration, and TOC back.
- [Packet loss](packet-loss.md): FEC, PLC, and the RED secondary encoder.
- [API reference](api-reference.md): full signatures.
