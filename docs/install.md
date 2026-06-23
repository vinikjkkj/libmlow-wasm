# Install

`libmlow-wasm` ships precompiled WebAssembly. Installing it pulls no native
toolchain and runs no build step — the `.wasm` is inlined into the published
JavaScript.

This package is a fork of [libopus-wasm](https://github.com/openclaw/libopus-wasm)
built against [opus_mlow](https://github.com/edgardmessias/opus_mlow) instead of
upstream libopus.

## Add the package

```bash
npm install libmlow-wasm
# or
pnpm add libmlow-wasm
# or
yarn add libmlow-wasm
```

## Requirements

- **Node:** 20 or newer. The package is ESM-only (`"type": "module"`).
- **Browsers:** any engine with WebAssembly and ES2022 — every current
  evergreen browser qualifies.
- **No cross-origin isolation.** The module is single-threaded and needs neither
  `SharedArrayBuffer` nor COOP/COEP headers.

## Entry points

| Import | Runtime | Use it for |
| --- | --- | --- |
| `libmlow-wasm` | Browser + Node | The full encoder/decoder API. Browser-safe. |
| `libmlow-wasm/discordjs` | Node only | A drop-in for `@discordjs/opus`. Uses `Buffer`. |

```ts
import { createEncoder, createDecoder } from "libmlow-wasm";
import { OpusEncoder } from "libmlow-wasm/discordjs";
```

The main entry is browser-safe and self-contained. The `discordjs` adapter
imports `node:buffer`, so it is Node-only by design — see
[discord.js compatibility](discordjs.md).

## Module format

The package is pure ESM with bundled TypeScript declarations:

```json
{
  "exports": {
    ".": { "types": "./dist/index.d.ts", "browser": "./dist/index.js", "import": "./dist/index.js" },
    "./discordjs": { "types": "./dist/discordjs.d.ts", "import": "./dist/discordjs.js" }
  }
}
```

To consume it from CommonJS, use a dynamic `import()`:

```js
const { createEncoder } = await import("libmlow-wasm");
```

## TypeScript

Types ship in the package; no `@types/*` install is needed. The structural
handle types are exported as `OpusEncoderHandle` and `OpusDecoderHandle`, and
all enums (`Application`, `Signal`, `Bitrate`, `Bandwidth`, `EncoderCtl`,
`DecoderCtl`) are exported as both values and types.

## Building from source

The npm package is all you need to use the codec. If you want to compile
libopus yourself — to pin a different version or audit the toolchain — see
[Building from source](building.md). It requires Emscripten (`emcc`) on `PATH`.

## Next

- [Quickstart](quickstart.md) — encode and decode a frame.
- [Browser usage](browser.md) — bundlers and Web Audio capture.
