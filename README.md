# libmlow-wasm

> **Fork of [openclaw/libopus-wasm](https://github.com/openclaw/libopus-wasm).** Same WebAssembly bindings API, but built against [**opus_mlow**](https://github.com/edgardmessias/opus_mlow) instead of upstream [libopus](https://opus-codec.org/) 1.6.1. [opus_mlow](https://github.com/edgardmessias/opus_mlow) is an Opus 1.4 fork with **SMPL/MLow** support — Meta's low-bitrate codec path used in WhatsApp, Instagram, and Messenger calls.

Small, modern WebAssembly bindings for [opus_mlow](https://github.com/edgardmessias/opus_mlow) raw
packet encode/decode. One single-file ES module that runs unchanged in browsers
and Node — no `locateFile` hook, no second `.wasm` request, no native build step.

The default path is realtime voice: 48 kHz, stereo, 20 ms frames, raw Opus
packets, no Ogg/WebM container layer.

- **Browser and Node** from one import. Bundles cleanly with Vite, webpack, esbuild.
- **Int16 and Float32 PCM** — use whatever your pipeline already speaks.
- **Loss-resilient** — in-band FEC and packet-loss concealment.
- **Tunable** — bitrate, VBR/CBR, complexity, signal, bandwidth, DTX, plus a curated CTL passthrough.
- **MLow-ready codec** — built on opus_mlow with SMPL/MLow integration for low-bitrate WhatsApp-compatible audio.
- **Drop-in `@discordjs/opus` adapter** — same method shape as upstream, no node-gyp.

## Install

```bash
npm install libmlow-wasm
```

ESM-only; Node 20+ or any current browser. No `@types` install needed.

## Quick start

```ts
import { createDecoder, createEncoder, getPacketInfo } from "libmlow-wasm";

const encoder = await createEncoder(); // 48 kHz, stereo, 20 ms, audio
const decoder = await createDecoder();

const pcm = new Int16Array(encoder.frameSize * encoder.channels); // 960 * 2
const packet = encoder.encode(pcm);    // Uint8Array — one raw Opus packet
const info = await getPacketInfo(packet); // duration, frames, bandwidth
const frame = decoder.decode(packet);  // Int16Array — interleaved PCM

encoder.free();
decoder.free();
```

Both factories share one lazily-loaded WASM module; the first call pays the load
cost and the rest are cheap.

## WhatsApp / MLow voice

> **What this is verified against.** Two things, and neither is interoperation.
>
> Decoding is checked against reference vectors produced by a *separate* native
> build of the same codec, driven with the configuration captured from a real
> call: 10/10 bit-exact across the signals, single-frame and multiframe, including
> DTX comfort-noise frames (`pnpm check-golden <vectorsDir>`; the vectors are not
> part of this repository). That rules out this library and
> the reference disagreeing on the format.
>
> Encoding satisfies the acceptance checks read out of the client's decompiled
> parser: the multiframe marker gate, the fixed-bit mask, the frame-count range.
>
> What is missing is a packet from a real call. **None has been compared
> against**, because the payload is SRTP-encrypted on the wire and otherwise
> stays inside the client's wasm module. Treat this as *conforms to the format*,
> not *known to work against WhatsApp*, and test against your own endpoint before
> depending on it.

For WhatsApp-style MLow (SMPL), use **16 kHz mono** and enable `useSmpl`. This
matches common VoIP integrations and works with the pinned opus_mlow v1.0.1.
SMPL at 24k/48k API rates needs a newer opus_mlow release (resampler fix upstream).

Reverse engineering of the client reports **`complexity: 5`** in production. The
library defaults to `10`, which on the float build also runs a 480-point MDCT and
an MLP for tonality analysis on every frame (anything at or above 7 does), while
SMPL's own search tiers only step at 1/2/3/4/8. Pass `complexity: 5` explicitly
to match the client; the default is left alone so existing callers keep their
current output.

WhatsApp emits **20 ms native SMPL frames grouped into one multiframe packet**.
`opus_encode` does not do that grouping on the SMPL path, so the on-the-wire
packet takes two steps: encode 20 ms frames, then pack them with
[`createRepacketizer`](docs/repacketizer.md).

How many frames land in one packet follows `M = (frame_duration_ms / 20) × fpp`.
The `minfpp`/`maxfpp` settings in the client belong to a bundling layer above
the codec, not to the codec itself, and RED travels in its own buffer without
adding to `M`. Drive the count from your own packetisation; the repacketizer
takes any number from 2 to 18.

A 60 ms native frame (`frameSize: 960` at 16 kHz) is also a valid SMPL frame,
but it is a **different bitstream** from a multiframe packet of 20 ms frames:
one TOC covering 60 ms, versus a multiframe header in front of several 20 ms
sub-frames. Pick 20 ms when the target is WhatsApp's framing. The 120 ms native
duration exists in the TOC but has not been observed in production.

Typical parameters:

| Setting | Value | Notes |
| --- | --- | --- |
| `sampleRate` | `16_000` | Hz |
| `channels` | `1` | mono |
| `frameSize` | `320` | samples per encode frame (20 ms @ 16 kHz): what WhatsApp emits |
| `maxFrameSize` | `1_920` | decoder output capacity (120 ms @ 16 kHz) |
| `useSmpl` | `true` | MLow/SMPL path |
| `application` | `Application.Voip` (`2048`) | VoIP |
| `signal` | `Signal.Voice` (`3001`) | voice-optimized |
| `bitrate` | `6_000` | bits/s: the floor; production is 6-24 kbps adaptive |
| `complexity` | `5` | encoder CPU vs quality: the value the client uses |
| `dtx` | `true` | discontinuous transmission |
| `fec` | `false` | in-band FEC (enable when expecting loss) |

```ts
import {
  Application,
  Signal,
  createDecoder,
  createEncoder,
  createRepacketizer,
  loadLibopus,
} from "libmlow-wasm";

const SAMPLE_RATE = 16_000;
const CHANNELS = 1;
const FRAME_SIZE = 320;       // 20 ms @ 16 kHz
const FRAMES_PER_PACKET = 3;  // 60 ms on the wire; pick what your packetiser needs
const MAX_FRAME_SIZE = 1_920; // 120 ms decode buffer

await loadLibopus();

const encoder = await createEncoder({
  channels: CHANNELS,
  sampleRate: SAMPLE_RATE,
  application: Application.Voip,
  frameSize: FRAME_SIZE,
  useSmpl: true,
  dtx: true,
  fec: false,
  bitrate: 6_000,
  complexity: 5,
  signal: Signal.Voice,
});

const repacketizer = await createRepacketizer();

const decoder = await createDecoder({
  channels: CHANNELS,
  sampleRate: SAMPLE_RATE,
  useSmpl: true,
  maxFrameSize: MAX_FRAME_SIZE,
});

// Encode: Float32 [-1, 1] -> Int16 -> three 20 ms MLow frames -> one packet
const frames: Uint8Array[] = [];
for (let frame = 0; frame < FRAMES_PER_PACKET; frame++) {
  const float32 = new Float32Array(FRAME_SIZE); // one 20 ms slice of capture
  const pcm = new Int16Array(FRAME_SIZE);
  for (let i = 0; i < float32.length; i++) {
    const sample = Math.max(-1, Math.min(1, float32[i]!));
    pcm[i] = Math.round(sample * 32_767);
  }
  frames.push(encoder.encode(pcm));
}
const packet = repacketizer.pack(frames); // multiframe: 3 x 20 ms

// Decode: MLow packet -> Float32 PCM. The decoder's capacity has to cover the
// whole packet, so a 60 ms multiframe needs maxFrameSize >= 960.
const audio = decoder.decodeFloat(packet); // 960 samples = 60 ms

// Packet loss: synthesize a concealment frame (PLC)
const concealed = decoder.decodePacketLossFloat(FRAME_SIZE);

encoder.free();
repacketizer.free();
decoder.free();
```

`createEncoder({ useSmpl: true })` initializes SMPL global tables automatically.
For long-lived processes you can also call `opusGlobalCreate()` once up front.

For the packing step and the multiframe byte layout, see
[Repacketizer](docs/repacketizer.md). For the redundancy WhatsApp adds on a bad
network, see [RED (secondary encoder)](docs/packet-loss.md#red-secondary-encoder).

## Relationship to upstream

| | [libopus-wasm](https://github.com/openclaw/libopus-wasm) | **libmlow-wasm** (this repo) |
| --- | --- | --- |
| Bindings / TypeScript API | Original | Fork — same surface |
| Native codec | [libopus 1.6.1](https://downloads.xiph.org/releases/opus/) (Xiph.Org) | [**opus_mlow**](https://github.com/edgardmessias/opus_mlow) |
| MLow / SMPL | — | Enabled via opus_mlow |

For standard Opus without MLow, use [libopus-wasm](https://github.com/openclaw/libopus-wasm) and [libopus-wasm.dev](https://libopus-wasm.dev).

## Examples

### Float32 PCM

Encode and decode floats directly — ideal for Web Audio:

```ts
const frame = new Float32Array(encoder.frameSize * encoder.channels); // [-1, 1]
const packet = encoder.encodeFloat(frame);
const decoded = decoder.decodeFloat(packet); // Float32Array
```

### Batches

```ts
const packets = encoder.encodeFrames([frameA, frameB, frameC]); // Uint8Array[]
const frames = decoder.decodeFrames(packets);                   // Int16Array[]
```

### Packet loss: FEC + concealment

```ts
// Encoder: enable in-band FEC and declare the expected loss rate.
const encoder = await createEncoder({ fec: true, packetLossPercent: 15 });

// Decoder: a packet is lost. If the next packet is in hand, recover from its
// FEC data; otherwise synthesize a concealment frame.
const recovered = decoder.decode(nextPacket, { decodeFec: true, frameSize: 960 });
const concealed = decoder.decodePacketLoss(960); // == decode(null, { frameSize: 960 })
```

### Tuning the encoder

```ts
const encoder = await createEncoder({
  application: Application.Audio,
  bitrate: 96000,        // or "auto" / "max"
  complexity: 10,        // 0..10
  signal: Signal.Music,
  vbr: true,
});

encoder.setBitrate(128000);
encoder.setMaxBandwidth(Bandwidth.Wideband);
encoder.getBitrate();    // 128000
```

### Deterministic cleanup with `using`

```ts
{
  using encoder = await createEncoder();
  using decoder = await createDecoder();
  decoder.decode(encoder.encode(new Int16Array(960 * 2)));
} // both freed automatically at scope exit
```

## discord.js compatibility

`libmlow-wasm/discordjs` matches the [`@discordjs/opus`](https://github.com/discordjs/opus)
method shape, minus the native toolchain. It is Node-only (uses `Buffer`) and
loads asynchronously:

```ts
import { OpusEncoder } from "libmlow-wasm/discordjs";

const opus = await OpusEncoder.create(48000, 2);
const packet = opus.encode(pcmBuffer);
const decoded = opus.decode(packet);
opus.setBitrate(64000);
opus.setFEC(true);
opus.free();
```

Or construct directly and await `ready` to keep existing call sites:

```ts
const opus = new OpusEncoder(48000, 2);
await opus.ready;
```

## Browser

The main entry inlines the WASM, so it bundles with no plugins and needs no
cross-origin isolation. Web Audio delivers Float32 samples that go straight into
`encodeFloat`.

## API overview

The API matches [libopus-wasm](https://libopus-wasm.dev/api-reference.html).

### Top-level

| Function | Returns | Description |
| --- | --- | --- |
| `loadLibopus()` | `Promise<{ version }>` | Loads the module; returns the bundled opus_mlow version. |
| `opusGlobalCreate()` | `Promise<void>` | Initialize SMPL global tables (optional; auto-called when `useSmpl: true`). |
| `opusGlobalFree()` | `Promise<void>` | Release SMPL global tables. |
| `createEncoder(options?)` | `Promise<OpusEncoderHandle>` | Create a raw-packet encoder. |
| `createDecoder(options?)` | `Promise<OpusDecoderHandle>` | Create a raw-packet decoder. |
| `createRepacketizer(options?)` | `Promise<MlowRepacketizerHandle>` | Create a repacketizer for MLow multiframe packets. See [Repacketizer](docs/repacketizer.md). |
| `getPacketInfo(packet, options?)` | `Promise<OpusPacketInfo>` | Validate a raw packet by decoding it, and return duration, frame count, channels, and bandwidth. |
| `getMlowPacketInfo(packet, options?)` | `Promise<MlowPacketInfo>` | Same fields for an MLow packet, plus the VAD/FEC flags and the decoded TOC. |

### Supported formats

| Constraint | Allowed values |
| --- | --- |
| Sample rate | `8000`, `12000`, `16000`, `24000`, `48000` Hz |
| Channels | `1` (mono), `2` (stereo) |
| Encode frame duration | `2.5`, `5`, `10`, `20`, `40`, `60` ms |
| Decode output capacity | up to `120` ms |
| PLC / FEC frame size | multiples of `2.5` ms, up to `120` ms |

Validation errors (wrong frame size, out-of-range option, empty packet,
non-allow-listed CTL) throw a `RangeError` before reaching WASM; codec errors
surface as `OpusError`.

## Build from source

The npm package ships compiled output, so using it needs no toolchain. Building
from source requires Emscripten (`emcc`) on `PATH`:

```bash
pnpm install
pnpm build
pnpm test
```

`pnpm build` downloads [**opus_mlow 1.0.1**](https://github.com/edgardmessias/opus_mlow/releases/tag/v1.0.1),
verifies the pinned SHA-256, compiles it with Emscripten, and emits a single-file
ES module under `dist/generated/`. See [Building from source](docs/building.md).

## Benchmark

WASM-only throughput check — no native addons required:

```bash
pnpm benchmark
```

## License

Released under the [MIT license](LICENSE). The JavaScript/TypeScript bindings
inherit the MIT license from [libopus-wasm](https://github.com/openclaw/libopus-wasm).
[opus_mlow](https://github.com/edgardmessias/opus_mlow) carries the Opus BSD-style
license, reproduced in [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES.md). Not affiliated
with Xiph.Org, Meta, or the upstream libopus-wasm maintainers.
