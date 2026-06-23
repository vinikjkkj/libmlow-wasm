# Building from source

The published npm package ships compiled WebAssembly, so **using** the library
needs no build step. Build from source only when you want to audit the
toolchain, pin a different opus_mlow release, or hack on the bindings.

## Prerequisites

- [Emscripten](https://emscripten.org/) (`emcc`) on your `PATH`, or `EMSDK` / `LIBMLOW_WASM_EMSDK` pointing at the emsdk root (e.g. `C:\bin\emsdk` on Windows).
- [pnpm](https://pnpm.io/) — the repo's package manager.
- Node 20 or newer.
- On **Windows**, CMake and GNU Make (`make`) are also required for the opus_mlow build (the script uses `emcmake` instead of autotools `configure`).

Verify the toolchain:

```bash
emcc --version
pnpm --version
```

## Build

```bash
pnpm install
pnpm build
```

`pnpm build` runs three steps:

1. `build:wasm` — `node scripts/build-opus-mlow-wasm.mjs` downloads
   [**opus_mlow 1.0.0**](https://github.com/edgardmessias/opus_mlow/releases/tag/v1.0.0),
   verifies it against a pinned SHA-256, compiles it with Emscripten, and emits
   a single-file ES module into `src/generated/`. On Windows the script uses
   CMake (`emcmake`); on Linux/macOS it uses autotools (`emconfigure`).
2. `tsc` — type-checks and compiles the TypeScript in `src/` to `dist/`.
3. `copy-generated` — copies the generated WASM module into `dist/`.

The result in `dist/` is exactly what gets published.

## Test

```bash
pnpm test
```

This rebuilds the WASM module and runs the [Vitest](https://vitest.dev/) suite,
which exercises encode/decode roundtrips, Float32 paths, FEC and PLC, CTL
validation, error handling, and the discord.js adapter.

Type-check without emitting:

```bash
pnpm typecheck
```

## Clean

```bash
pnpm clean   # removes dist/ and the .cache/ build directory
```

The first build downloads and compiles opus_mlow into `.cache/`, which takes a
while; later builds reuse it. `pnpm clean` forces a fresh download and compile.

## How the WASM is packaged

The build emits a **single-file** ES module with the `.wasm` bytes inlined as
base64. That is what makes the package browser-safe with no `locateFile` hook
and no second network request. The C entry points are thin wrappers in
`native/mlow_wasm_wrapper.c` (prefixed `oc_`) that the TypeScript in
`src/index.ts` calls into.

## Codec

This fork links against [opus_mlow](https://github.com/edgardmessias/opus_mlow)
instead of upstream libopus. opus_mlow is an Opus 1.4 fork with SMPL/MLow
enabled by default. The bindings API matches
[libopus-wasm](https://github.com/openclaw/libopus-wasm).

## Next

- [Benchmark](benchmark.md) — measure WASM encode/decode throughput.
- [API reference](api-reference.md) — the surface the bindings expose.
