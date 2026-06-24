# libmlow-wasm Notes

Fork of [openclaw/libopus-wasm](https://github.com/openclaw/libopus-wasm). Builds against [edgardmessias/opus_mlow](https://github.com/edgardmessias/opus_mlow) instead of upstream libopus 1.6.1 from Xiph.Org.

## WASM build

- Do not blindly pass `-O3 -flto` through opus_mlow `CFLAGS`/`LDFLAGS`. Tested 2026-05-26 with Emscripten 5.0.7 on upstream libopus: build time grew from `28.54s` to `54.29s`, single-file module grew from `377601` to `453420` bytes, and first decode hung. Variant with `-DNDEBUG` also hung and built slower (`67.03s`).
- opus_mlow `CFLAGS=-O3 -fvisibility=hidden` without LTO is valid but slower on upstream libopus. Tested 2026-05-26: build time `52.69s`, module `402064` bytes, benchmark `wasm encode 10214 ops/sec`, `wasm decode 39450 ops/sec` versus current `12633`/`39971`.
- Known-good profile: opus_mlow autotools/CMake defaults plus final wrapper/link `emcc -O3 -flto`.
- WASM link uses `STACK_SIZE=8388608` for SMPL stack depth.
- Windows builds use CMake + `emcmake` (autotools `configure` is not a native Win32 binary). Linux/macOS CI uses autotools by default; set `LIBMLOW_WASM_BUILD_CMAKE=1` to force CMake.
- Emscripten: set `EMSDK` or `LIBMLOW_WASM_EMSDK` to the emsdk root (e.g. `C:\bin\emsdk` on Windows) if `emcc` is not already on `PATH`.

## Codec pin (opus_mlow)

- Pinned release: [opus_mlow v1.0.1](https://github.com/edgardmessias/opus_mlow/releases/tag/v1.0.1) (`opus-mlow-1.0.1.tar.gz`). Version and SHA-256 live in `scripts/build-opus-mlow-wasm.mjs`. SMPL/MLow is enabled by default in opus_mlow (`ENABLE_SMPL`).

## SMPL / MLow runtime

- `useSmpl: true` requires `opus_global_create()` before encode/decode. The JS API calls this automatically via `createEncoder({ useSmpl: true })`, `createDecoder({ useSmpl: true })`, or `encoderCtl(SetUseSmpl, 1)`. You can also call `opusGlobalCreate()` / `opusGlobalFree()` explicitly.
- Without global tables, SMPL encode returns `OPUS_INTERNAL_ERROR` (-3) because the codec maps `SMPL_ENC_NO_GLOBAL_DATA` (-112) internally.
- Standard Opus (default `useSmpl: false`) is unaffected and works at all supported sample rates.
