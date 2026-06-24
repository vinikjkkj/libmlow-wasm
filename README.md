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

For WhatsApp-style MLow (SMPL), use **16 kHz mono** and enable `useSmpl`. This
matches common VoIP integrations and works with the pinned opus_mlow v1.0.0.
SMPL at 24k/48k API rates needs a newer opus_mlow release (resampler fix upstream).

Typical parameters:

| Setting | Value | Notes |
| --- | --- | --- |
| `sampleRate` | `16_000` | Hz |
| `channels` | `1` | mono |
| `frameSize` | `960` | samples per encode frame (60 ms @ 16 kHz) |
| `maxFrameSize` | `1_920` | decoder output capacity (120 ms @ 16 kHz) |
| `useSmpl` | `true` | MLow/SMPL path |
| `application` | `Application.Voip` (`2048`) | VoIP |
| `signal` | `Signal.Voice` (`3001`) | voice-optimized |
| `bitrate` | `6_000` | bits/s (tune per network) |
| `complexity` | `5` | encoder CPU vs quality |
| `dtx` | `true` | discontinuous transmission |
| `fec` | `false` | in-band FEC (enable when expecting loss) |

```ts
import {
  Application,
  Signal,
  createDecoder,
  createEncoder,
  loadLibopus,
} from "libmlow-wasm";

const SAMPLE_RATE = 16_000;
const CHANNELS = 1;
const FRAME_SIZE = 960;       // 60 ms @ 16 kHz
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

const decoder = await createDecoder({
  channels: CHANNELS,
  sampleRate: SAMPLE_RATE,
  useSmpl: true,
  maxFrameSize: MAX_FRAME_SIZE,
});

// Encode: Float32 [-1, 1] → Int16 → MLow packet
const float32 = new Float32Array(FRAME_SIZE);
const pcm = new Int16Array(FRAME_SIZE);
for (let i = 0; i < float32.length; i++) {
  const sample = Math.max(-1, Math.min(1, float32[i]!));
  pcm[i] = Math.round(sample * 32_767);
}
const packet = encoder.encode(pcm, { frameSize: FRAME_SIZE });

// Decode: MLow packet → Float32 PCM
const audio = decoder.decodeFloat(packet, { frameSize: FRAME_SIZE });

// Packet loss: synthesize a concealment frame (PLC)
const concealed = decoder.decodePacketLossFloat(FRAME_SIZE);

encoder.free();
decoder.free();
```

`createEncoder({ useSmpl: true })` initializes SMPL global tables automatically.
For long-lived processes you can also call `opusGlobalCreate()` once up front.

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
| `getPacketInfo(packet, options?)` | `Promise<OpusPacketInfo>` | Validate a raw packet and return duration, frame count, channels, and bandwidth. |

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

`pnpm build` downloads [**opus_mlow 1.0.0**](https://github.com/edgardmessias/opus_mlow/releases/tag/v1.0.0),
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
