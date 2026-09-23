# libmlow-wasm Notes

## Architecture rule

**All processing lives in C. TypeScript only calls the functions.**

TS validates arguments, copies buffers across the WASM boundary, owns handle
lifetimes, and shapes the public API. It does not read, inspect or transform
audio, packets or model data — not one byte. If a change needs that, it needs a
C function, exported from `scripts/build-opus-mlow-wasm.mjs` and called from TS.

This holds even where the JavaScript would be a line or two. A per-frame loop in
JS costs orders of magnitude more than the same loop compiled, and splitting the
format's logic across two languages means whoever debugs it later has to hold
both in their head.

Concretely: no `HEAPU8[...]` reads or writes in `src/` beyond `set()`/`slice()`
to move a whole buffer in or out.

Fork of [openclaw/libopus-wasm](https://github.com/openclaw/libopus-wasm). Builds against [edgardmessias/opus_mlow](https://github.com/edgardmessias/opus_mlow) instead of upstream libopus 1.6.1 from Xiph.Org.

## WASM build

- Do not blindly pass `-O3 -flto` through opus_mlow `CFLAGS`/`LDFLAGS`. Tested 2026-05-26 with Emscripten 5.0.7 on upstream libopus: build time grew from `28.54s` to `54.29s`, single-file module grew from `377601` to `453420` bytes, and first decode hung. Variant with `-DNDEBUG` also hung and built slower (`67.03s`).
- opus_mlow `CFLAGS=-O3 -fvisibility=hidden` without LTO is valid but slower on upstream libopus. Tested 2026-05-26: build time `52.69s`, module `402064` bytes, benchmark `wasm encode 10214 ops/sec`, `wasm decode 39450 ops/sec` versus current `12633`/`39971`.
- Known-good profile: opus_mlow autotools/CMake defaults plus final wrapper/link `emcc -O3 -flto`.
- WASM link uses `STACK_SIZE=8388608` for SMPL stack depth.
- `OPUS_REDUCE_SMPL_BINARY_SIZE` (ON upstream) compiles the SMPL DSP core with `-Os`. Turning it off reads like an obvious win but is not: measured 2026-09-19 in A/B alternating trials, encode moved ~1% — inside a trial spread of 0.6–3.4% — while the module grew `609703` to `816094` bytes (+34%). The link-time `wasm-opt -O3` already recovers most of it. Left at the default; `LIBMLOW_WASM_SMPL_FULL_OPT=1` opts out for anyone re-measuring. `-O3` over `-O2` in codec `CFLAGS` was likewise unmeasurable and cost 28 KB.
- `OPUS_FLOAT_APPROX=ON` (via `LIBMLOW_WASM_FLOAT_APPROX=1`) unlocks the `-Ofast` upstream marks for its eight hottest files, but output stops being bit-exact and the float approximations reach the plain Opus rate control too. Run codec vectors before adopting.
- `OPUS_HARDENING=OFF` (via `LIBMLOW_WASM_HARDENING=0`) drops the SMPL asserts but also `validate_opus_decoder` / `validate_celt_decoder`, which guard against malformed packets. This library decodes bytes off the network, so it stays on.

## Regression checking

- `node scripts/codec-vectors.mjs` prints SHA-256 fingerprints of encode and decode output across every sample rate, both channel counts, the native SMPL frame durations, the deepest stack path (120 ms @ 48 kHz stereo float), and FEC/PLC. Capture it before a change, again after, and diff: identical hashes mean the codec behaves identically no matter what moved around it. Unsupported cases are recorded rather than throwing, so the harness runs against older builds too.
- The unit suite proves the API contract; it does not prove the codec still produces the same bytes. Use both.
- Windows builds use CMake + `emcmake` (autotools `configure` is not a native Win32 binary). Linux/macOS CI uses autotools by default; set `LIBMLOW_WASM_BUILD_CMAKE=1` to force CMake.
- Emscripten: set `EMSDK` or `LIBMLOW_WASM_EMSDK` to the emsdk root (e.g. `C:\bin\emsdk` on Windows) if `emcc` is not already on `PATH`.

## Codec pin (opus_mlow)

- Pinned release: [opus_mlow v1.0.1](https://github.com/edgardmessias/opus_mlow/releases/tag/v1.0.1) (`opus-mlow-1.0.1.tar.gz`). Version and SHA-256 live in `scripts/build-opus-mlow-wasm.mjs`. SMPL/MLow is enabled by default in opus_mlow (`ENABLE_SMPL`).

## SMPL / MLow runtime

- `useSmpl: true` requires `opus_global_create()` before encode/decode. The JS API calls this automatically via `createEncoder({ useSmpl: true })`, `createDecoder({ useSmpl: true })`, or `encoderCtl(SetUseSmpl, 1)`. You can also call `opusGlobalCreate()` / `opusGlobalFree()` explicitly.
- Without global tables, SMPL encode returns `OPUS_INTERNAL_ERROR` (-3) because the codec maps `SMPL_ENC_NO_GLOBAL_DATA` (-112) internally.
- Standard Opus (default `useSmpl: false`) is unaffected and works at all supported sample rates.

## Decoding real WhatsApp traffic: the framing is confirmed

A packet captured from a live call parses and decodes here. It was readable
because the transport failed: with the relay down, SRTP is never applied to the
buffer, so the payload sits in the clear. That it is cleartext is checkable
rather than assumed — byte 0 of the payload is identical across six
consecutive sequence numbers, where a counter-mode keystream would have
randomised it.

From the RTP payload at offset 16:

```
92 02 63 50 d8 02 dd 57 ...
^  ^  ^  ^
|  |  |  +-- sub-frame TOC
|  |  +----- size of the first sub-frame, 99
|  +-------- frame count, 2
+----------- 0x82 | (toc & 0x39) = 0x92, the multiframe marker
```

What this confirms, and it is the part no test here could: both inner TOCs are
`0x50`, identical to each other and agreeing with the marker on rate, frame
size and channel count — which is what `MLOW_TOC_FIXED_MASK` requires and what
every earlier candidate buffer failed. `getMlowPacketInfo` reports two frames
and 1920 samples, and the decoder returns 1920 samples.

**What is not confirmed is the audio.** These buffers carry a stale tail from
whatever occupied the memory before, so the second sub-frame's bytes are not
the ones that were sent, and the decoded output saturates. The framing is
demonstrated; a sample-accurate comparison still needs a packet with a known
payload.

Comparing what this library emits against it, field by field:

| | captured call | this library |
| --- | --- | --- |
| marker `& 0x82` | `0x82` | `0x82` |
| frame count | 2 | 2 |
| count byte flags | **`0x00`** | `0x00` |
| inner TOC frame size | 2 (60 ms) | 1 (20 ms) |
| marker carries the inner fixed fields | yes | yes |

Two things follow.

**The captured packet sets no flags on the count byte.** The masking fix was
motivated by bytes like `0x86` and `0xc3` seen in scanned buffers, which were
later withdrawn as probably not packets — and real traffic shows `0x00` here.
The fix stands on its own argument (the count cannot exceed 18, so the top bits
are flags whether or not we have seen them, and masking is strictly more
permissive), but it has still never been exercised by a real packet. Do not
cite the wire capture as evidence for it.

**WhatsApp used 60 ms sub-frames here, where this library defaults to 20 ms.**
Two of them account for the 1920 samples the decoder returns. That is a
configuration difference and not an incompatibility — the decoder reads the
duration from each TOC — but anything comparing packet layouts should match the
frame duration first, or it will be comparing different things.

This also cannot settle the size-table question below: the frame is 99 bytes,
and the two schemes are identical under 252.

## Multiframe size tables differ from the client's, above 252 bytes

Settled by reading both write sites. The two schemes agree exactly for frames
under 252 bytes and disagree above it.

For a frame of length L at or above 252, this codec writes
`[252 + (L & 3), (L - b0) >> 2]` and reads it back as `b0 + 4*b1`. The client
writes `[252 + (L & 3), L >> 2]` and reads `(b0 & 3) + (b1 << 2)`. Both
round-trip correctly on their own; neither reads the other:

| L | this codec | client | this codec reads the client's as |
| --- | --- | --- | --- |
| 300 | `[252, 12]` | `[252, 75]` | 552 |
| 1000 | `[252, 187]` | `[252, 250]` | 1252 |

Below 252 both write a single byte equal to L, byte for byte identical, so
nothing diverges there.

**How often that matters:** a frame reaches 252 bytes at 100.8 kbps for 20 ms,
33.6 kbps for 60 ms, or 16.8 kbps for 120 ms. Native MLow sub-frames are 20 ms,
and 4 s of real 16 kHz MLow at 16 kbps measured 6 to 43 bytes per packet. So
the divergence is out of reach for ordinary MLow traffic and reachable for
120 ms frames at an ordinary bitrate.

**Why this has not been changed.** Changing only the repacketizer would break
this library against itself: decoding goes through `parse_size` in the codec,
which reads the scheme above, so we would emit packets our own decoder
misreads. Matching the client needs both the encoder and the decoder of the
vendored codec patched, which changes what this library is — a wrapper around
`opus_mlow` — and is a decision for whoever owns that question, not one to make
while passing through.

The client also sets bit 6 of the frame-count byte, for padding, where we leave
it clear. We already accept it on the way in; we do not produce it.

None of this is visible to any test here. Both ends of every test are this same
codec, so a format they share looks correct however wrong it is against a third
party — which is the general point worth keeping.

## This library is not bit-exact with a native build of the same codec

Worth knowing before anyone compares its output against reference vectors.

Reference vectors for MLow with redundancy were generated by a native x86-64
build of the pinned codec. Compiling that generator against the codec as
vendored here and running it reproduces them **exactly** — 327 packets across
four signals, primary and secondary, byte for byte. So the codec, the pin and
the configuration all agree.

Driving the same codec through this library's WebAssembly build does not
reproduce them. The packets share their first bytes and diverge partway
through the payload: the header and the high-level parameters match, the
entropy-coded remainder does not. That is floating-point arithmetic differing
between x86-64 and WebAssembly, amplified by a feedback loop — the encoder's
state depends on its own previous output.

How far apart the decoded audio lands depends entirely on the signal:

| signal | result |
| --- | --- |
| impulse | bit-identical |
| speech proxy | SNR 59.6 dB, worst sample differs by 9 |
| AM/FM tone | SNR 30.2 dB, worst sample differs by 893 |
| frequency sweep | SNR 20.2 dB, worst sample differs by 12869 |

Speech — the thing this codec exists for — comes out essentially identical.
Synthetic wideband signals do not, and a sweep is the worst case: an SNR of
20 dB is not a rounding difference.

Two consequences. Reference vectors from a native build are usable for
checking *configuration* and *framing*, which is what they were used for here,
but not as byte-exact expectations for this library's output. And
`scripts/codec-vectors.mjs` stays meaningful precisely because it compares this
build against itself.
