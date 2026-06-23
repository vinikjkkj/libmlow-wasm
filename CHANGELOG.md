# Changelog

## Unreleased

- Remove `@discordjs/opus` dev dependency and native comparison benchmark; keep `libmlow-wasm/discordjs` API compatibility adapter.
- Add WASM-only benchmark (`pnpm benchmark`) and manual CI workflow.
- Fix Windows WASM build: use CMake via `emcmake` when autotools `configure` cannot run natively; auto-detect `EMSDK` / `LIBMLOW_WASM_EMSDK`.
- Default `useSmpl` to opt-in (`false`) so standard Opus encode/decode tests pass; document WASM SMPL encode limitation.
- Extend `native/mlow_wasm_wrapper.c` with opus_mlow SMPL/MLow CTLs and `mlow_packet_*` exports; add `getMlowPacketInfo()` and opt-in `useSmpl` for MLow encode/decode.

## 0.1.0 - 2026-06-23

- Fork [openclaw/libopus-wasm](https://github.com/openclaw/libopus-wasm) as `libmlow-wasm`.
- Build against [edgardmessias/opus_mlow](https://github.com/edgardmessias/opus_mlow) v1.0.0 instead of upstream libopus 1.6.1 from Xiph.Org.
- Document fork lineage, codec swap, and third-party notices.
