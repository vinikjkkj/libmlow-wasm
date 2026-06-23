# libmlow-wasm

Fork of [openclaw/libopus-wasm](https://github.com/openclaw/libopus-wasm) with WebAssembly bindings for [opus_mlow](https://github.com/edgardmessias/opus_mlow) raw packet encode/decode — Opus with SMPL/MLow support for WhatsApp-compatible low-bitrate audio.

The default path is Discord/realtime voice ready: 48 kHz, stereo, 20 ms PCM frames, raw Opus packets, no Ogg/WebM container layer.

```bash
npm install libmlow-wasm
```

```ts
import { createDecoder, createEncoder } from "libmlow-wasm";

using encoder = await createEncoder();
using decoder = await createDecoder();

const pcm = new Int16Array(960 * 2);
const packet = encoder.encode(pcm);
const decoded = decoder.decode(packet);
const concealed = decoder.decodePacketLoss(960);
```

- Source: [edgardmessias/libmlow-wasm](https://github.com/edgardmessias/libmlow-wasm)
- Upstream bindings: [openclaw/libopus-wasm](https://github.com/openclaw/libopus-wasm)
- Codec: [edgardmessias/opus_mlow](https://github.com/edgardmessias/opus_mlow)
