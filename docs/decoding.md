# Decoding

The decoder turns one raw Opus packet into one PCM frame. Like the encoder, it
is stateful per stream but works one packet at a time.

## Create a decoder

```ts
import { createDecoder } from "libmlow-wasm";

const decoder = await createDecoder({
  sampleRate: 48000, // must match how the stream was encoded
  channels: 2,
});
```

The decoder's sample rate and channel count must match the encoder that
produced the packets. There is no in-band signalling of these in a raw Opus
packet, so you carry them out of band (the same way Discord and WebRTC do).

## Int16 PCM

```ts
const frame = decoder.decode(packet); // Int16Array, interleaved
frame.length; // === samplesDecoded * channels
```

The result is interleaved signed 16-bit little-endian PCM. The length tells you
how many samples the packet held — Opus packets can carry 2.5–120 ms of audio,
so do not assume it equals your encoder's frame size.

## Float32 PCM

```ts
const frame = decoder.decodeFloat(packet); // Float32Array in [-1, 1]
```

Useful when the output goes straight into Web Audio, which expects float
samples.

## Output capacity

A decoder allocates enough scratch for the largest packet it expects. By
default that is **120 ms** (`maxFrameSize`), the largest an Opus packet can
hold. Lower it if you know your packets are always short and want a tighter
buffer:

```ts
const decoder = await createDecoder({ maxFrameSize: 960 }); // cap at 20 ms
```

```ts
decoder.maxFrameSize; // resolved capacity in samples per channel
```

If a packet decodes to more samples than `maxFrameSize`, the call throws rather
than overrunning. Raise `maxFrameSize`, or override it per call:

```ts
decoder.decode(packet, { maxFrameSize: 2880 }); // allow up to 60 ms here
```

## Batches

`decodeFrames` and `decodeFloatFrames` map over an array of packets:

```ts
const frames = decoder.decodeFrames(packets);          // Int16Array[]
const floatFrames = decoder.decodeFloatFrames(packets); // Float32Array[]
```

A `null` entry in the array is treated as a lost packet and concealed — see
[Packet loss](packet-loss.md).

## Decoding into your own buffer

`decode` allocates a fresh `Int16Array` for every frame. At 48 kHz stereo a
20 ms frame is 3,840 bytes of new typed array per decode — across many
simultaneous streams that becomes real GC pressure. `decodeInto` runs the same
decode into a buffer you own and returns the number of samples **per channel**:

```ts
const target = new Int16Array(decoder.maxFrameSize * decoder.channels);

const samples = decoder.decodeInto(target, packet);
const pcm = target.subarray(0, samples * decoder.channels); // a view, not a copy
```

Note the argument order: the target comes first, then the packet.
`decodeFloatInto` is the Float32 variant:

```ts
const target = new Float32Array(decoder.maxFrameSize * decoder.channels);
const samples = decoder.decodeFloatInto(target, packet);
```

Both accept the same options as `decode` / `decodeFloat`, including a `null`
packet for concealment:

```ts
const samples = decoder.decodeInto(target, null, { frameSize: 960 });
```

A target that cannot hold `samples * channels` throws a `RangeError` naming both
sizes, and nothing is written.

`decode` and `decodeFloat` are fine for most use. Reach for the `Into` variants
when you have many streams and care about allocation rate.

## Invalid packets

A corrupt or truncated packet makes libopus return an error, surfaced as an
`OpusError` with the libopus code and a readable message:

```ts
import { OpusError } from "libmlow-wasm";

try {
  decoder.decode(new Uint8Array([1, 2, 3, 4]));
} catch (err) {
  if (err instanceof OpusError) {
    console.error(err.operation, err.code, err.message);
  }
}
```

Passing an **empty** `Uint8Array` is a different mistake and throws a
`RangeError` — use `null` (or `decodePacketLoss`) to signal a lost packet, not a
zero-length buffer.

## Next

- [Packet loss](packet-loss.md) — conceal dropped packets and recover with FEC.
- [Errors & validation](errors.md) — `RangeError` vs `OpusError`, empty vs lost.
- [API reference](api-reference.md) — full decoder method list.
