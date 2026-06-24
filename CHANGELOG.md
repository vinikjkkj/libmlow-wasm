# Changelog

## Unreleased

- Fix SMPL/MLow encode (`useSmpl: true`): export `opus_global_create()` / `opus_global_free()` from the WASM wrapper and add `opusGlobalCreate()` / `opusGlobalFree()`; auto-initialize global tables when creating encoders/decoders with `useSmpl` or enabling `SetUseSmpl` via CTL.
- Add `STACK_SIZE=8388608` to the Emscripten link step for SMPL stack depth in WASM.
- Re-enable and extend SMPL tests (round-trip, global reinit, explicit `opusGlobalCreate`).
- Document WhatsApp/MLow voice parameters (16 kHz mono, 60 ms frames, VoIP tuning) in README with a full encode/decode/PLC example.

## 0.1.0 - 2026-06-23

- Remove `@discordjs/opus` dev dependency and native comparison benchmark; keep `libmlow-wasm/discordjs` API compatibility adapter.
- Add WASM-only benchmark (`pnpm benchmark`) and manual CI workflow.
- Fix Windows WASM build: use CMake via `emcmake` when autotools `configure` cannot run natively; auto-detect `EMSDK` / `LIBMLOW_WASM_EMSDK`.
- Default `useSmpl` to opt-in (`false`) so standard Opus encode/decode tests pass; document WASM SMPL encode limitation.
- Extend `native/mlow_wasm_wrapper.c` with opus_mlow SMPL/MLow CTLs and `mlow_packet_*` exports; add `getMlowPacketInfo()` and opt-in `useSmpl` for MLow encode/decode.
- Fork [openclaw/libopus-wasm](https://github.com/openclaw/libopus-wasm) as `libmlow-wasm`.
- Build against [edgardmessias/opus_mlow](https://github.com/edgardmessias/opus_mlow) v1.0.0 instead of upstream libopus 1.6.1 from Xiph.Org.
- Document fork lineage, codec swap, and third-party notices.
