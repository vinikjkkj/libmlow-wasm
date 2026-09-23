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

## Companion: current state -- inside the decoder, matching the client end to end

**Read this section first; most of what follows it is history.** The Companion
runs inside the pinned decoder, and on the same packets it reproduces the
client's NoLACE (`ctl(4058, 6)` in the client) sample for sample:

| | 15 kbps | 8 kbps (low rate) |
| --- | --- | --- |
| contribution, correlation with the client's | **0.99980** | **0.99982** |
| contribution rms, this build / client | 282.4 / 281.1 | 428.2 / 426.4 |
| filtered output against the client's | 35.7 dB | 34.7 dB |
| dry output against the client's | 35.7 dB | 34.6 dB |
| all 165 features against the client's | 1.00000 | 1.00000 |

The filtered outputs agree exactly as well as the dry ones: what is left is the
two codecs' own disagreement plus the client's int8 quantisation. Details in
`native/COMPANION-EVIDENCE.md`, "Inside the decoder".

### Using it

```ts
const decoder = await createDecoder({
  sampleRate: 16_000, channels: 1, useSmpl: true,
  useLpcPostfilter: false,          // what the client does
  companionModel: modelBytes,       // mlow_companion_v1, supplied by the caller
});
decoder.setCompanionModel(null);    // detach; or pass new bytes to replace
decoder.resetCompanion();           // where the stream restarts
```

The weights are WhatsApp's and this library does not ship them. They are
copied into the Companion, so the caller's bytes can be released. It acts on
20 ms wideband mono MLow frames; everything else decodes as before.

It sits where the client runs it: **on the excitation, before LPC synthesis**.
`scripts/opus-mlow-patches.mjs` adds a per-frame hook to `smpl_core_decode`
for it; with no hook registered the codec is unchanged, and
`scripts/codec-vectors.mjs` confirms it bit for bit. The patched tree carries
a stamp, and the build re-extracts a tree patched by an older version rather
than stacking patches.

**Cost, measured in the WebAssembly build** on 546 frames of real speech, 16
kHz mono, median of seven interleaved trials:

| | per 20 ms frame | share of one core |
| --- | --- | --- |
| decode, postfilter off | 14.6 us | 0.07% |
| decode, LPC postfilter on | 22.1 us | 0.11% |
| decode with the Companion | 885 us | 4.4% |

Memory: **2.22 MiB per Companion** (2,331,348 bytes, counted natively and
matching the heap in WebAssembly), against 50 KiB for the decoder -- the int8
weights are expanded to float. Creating one also copies the model into the
heap for the duration of the call, 754 KiB. The module grows by 25 KB.

Most of the Companion's time is its dense layers. `-msimd128` on the final
link halves it, 885 to 444 us, with output bit-identical (vectorising across a
layer's outputs keeps each output's summation order) -- but the module would
then require WebAssembly SIMD of every user, so it is not enabled. Feature
extraction was 70% of the native cost until the clean spectrum stopped
transforming its zero padding; that change is bit-identical too.

### How it got here

**Six faults were fixed, and none was findable on the decibel oracle:**

1. The predictor polynomial subtracts: `A(z) = 1 - sum a_i z^-i`.
2. The cepstrum and the pitch correlation read the decoder's **excitation**
   (`fcb + adaptive + noise`), not the decoded speech.
3. `af1` and `af4` are conditioned on **`ft1`'s output**, not on the GRU's
   raw state.
4. `ft1` and `ft2` run **side by side** over the GRU's states; `ft2` does not
   chain onto `ft1`.
5. The shaping's **twenty-first envelope slot holds the envelope's mean**, as
   in the reference; this build had a zero there.
6. **The filter runs on the excitation too**, not on the synthesised speech.
   Filtering the speech matched the client's level and filter shape to within
   a few percent and got the samples wrong -- contribution correlation 0.69.
   A level-and-shape match is not a match.

And four decoder-side mappings, each exact against the client once right: the
ltp gains are the adaptive-codebook gains as dequantised, whatever the
voicing; the bit count is `ec_tell` from the frame's own start; slot 92 is the
TOC's low-rate flag; the pitch index rounds its half up.

**How they were found, which is the part worth keeping.** Every one came from
reading a value inside the client and comparing it with this build's, computed
from the client's own inputs -- see "reading the client by ptrace" below. None
came from a metric: the decibel oracle scores an inert filter like silence, and
the first two faults had each been "ruled out" on it. The sixth was found only
by comparing the *input* of the first filter, after every output statistic
already agreed.

Stage by stage, each from the client's own inputs: features 1.00000; `conv1 ->
conv2`, `tconv`, the GRU, `ft1`/`ft2` all 0.99999 or better; the adaptive
gains to 4.6e-4; `af1`, the shaping and `af4` at 54.5 to 56.0 dB SNR.

**`ctl(4058, 1)` is not the Companion.** It is `OPUS_SET_USE_LPC_POSTFILTER`,
the pinned codec's own classical postfilter -- `useLpcPostfilter: true` here.
It takes a mode, not a flag: 0 (the codec default) is off for wideband and on
for super-wideband, 1 on for both, 2 wideband only, 3 off for both, so
`useLpcPostfilter: false` sends 3. Every "client Companion" figure quoted below
in mode 1 -- identity plus seven percent, peak +0.8512, rms 301, +0.45 dB --
measured that postfilter, and the sections that chase them chased the wrong
component.

## Companion: the client's costs 0.17 dB, this build's costs 17.5

**The lever is one call.** Registering the weights is not enough -- a per-frame
driver reads `OD+0x3c`, default 3, and takes the **dry** path unless it is 6:

    opus_decoder_ctl(dec, 4085, blob, len);   /* the weights, container raw */
    opus_decoder_ctl(dec, 4058, 6);           /* and this, or nothing runs */

`OPUS_RESET_STATE` and any rate or channel change clear both. Reissue both.

**Run the control before the result.** Scale the float weights by a fifth and
compare the bytes: under the dry path the outputs are byte-identical, and with
the mode set they differ on 98.6% of samples. That is the test that
discriminates "running and neutral" from "not running", and it is cheap. The
contribution then measures rms 278.4, 17.2 dB below the signal -- a post-filter
doing a post-filter's amount of work.

**And in one mode it improves the signal.** `ctl(4058, n)` takes 0..7: modes
0, 3, 4 and 5 are dry, 1 and 2 are byte-identical and contribute rms 301, 6
contributes 278 and 7 contributes 244. Against the dry path, **mode 1 reads
+0.45 dB** -- it *raises* the SNR -- while 6 and 7 cost 0.18 and 0.14. Three
distinct contribution levels, steps rather than a curve.

That settles a worry carried here for a long time: that a perceptually-trained
post-filter might legitimately lower SNR, so the `clean.s16` oracle could never
show it working. In mode 1 it shows it working. **The target is positive: about
half a decibel better than unfiltered.**

It also bounds any depth explanation: no mode contributes more than rms 301
where this build contributes 8964.8.

**The measurement**, each implementation against its own unfiltered path:

| | dB from clean | its Companion costs |
| --- | --- | --- |
| client, dry | +1.94 | -- |
| **client, running** | **+1.77** | **-0.17 dB** |
| **this build** | **-13.30** | **-17.5 dB** |

The client's post-filter trades a little SNR, which is what a perceptual loss
produces. This build's contribution is **rms 8964.8 against 278.4 -- thirty-two
times too large.**

**The client's Companion is identity plus seven percent, and this build's
output is unrelated to its input.** Fit a 33-tap least-squares FIR from each
implementation's own input to its own output: the client reads peak **+0.8512
at tap 0**, `peak^2/energy` **0.9766**, DC gain **+1.0399**, residual **7.0%**;
this build reads peak **-0.3074 at tap 20**, DC **+0.0801**, residual
**99.8%**. An identity would be +1.0 at tap 0 with zero residual.

So the client leaves the signal alone and adds a small correction, while this
build produces something no linear filter of the input explains. The
arithmetic predicted it -- the client's 15% contribution implies
`peak^2/energy` 0.978 and the fit measures 0.9766 -- and it needs no
disassembly.

**The fault is localised, with a target.** Four measurements of the same thing:
the contribution is rms 8964.8 against the client's 301; the correlation with
the client is 0.105 against a **measured ceiling of 0.95** (the client's own
chain on two decodes 0.96 apart); the adaptive kernel's `peak^2/energy` is
0.239 against the **0.750 its bias alone would give**; and the perturbation the
conditioning adds to that bias is **8.75 times the bias** where it must be well
under one.

The kernel layers are built as a delta plus a perturbation -- their biases peak
on the most recent tap at `peak^2/energy` 0.750 and zero tap 0 -- so a
conditioning nine times too strong turns a filter that *modifies* the signal
into one that *replaces* it, which is why the contribution is 136% of the
signal where the client's is 15%. `8.75 / 0.3 = 29` against the 30 to 32
measured two other ways.

Upstream the feature net runs hot throughout: `ft1` and `ft2` with 13% and 11%
of their outputs on the rails, `conv1`, `conv2` and `tconv` peaking at exactly
1.0, and `ft2` at rms 0.76 where the arithmetic through `alpha1_f` and `alpha2`
wants about 0.06.

**So the port is wrong and the version question is closed.** These weights are
the client's, the client applies them, and the result works. The reference pair
exists on demand, so the work from here is bisection: where does the factor of
thirty-two enter?

## Companion: RETRACTED -- the client was not applying it

An earlier version of this section claimed the client runs these weights and
comes out neutral, and that the port is therefore what is wrong. **Withdrawn.**
The client was not applying the Companion in the configuration tested.

Registering the weights, and registering them scaled by 1.05 and by 1.2,
produce **byte-identical output** -- same md5 -- each differing from
registering nothing by **two samples out of 174720, by one LSB**. Weights a
fifth larger cannot give identical audio. The apparent graded response was a
threshold: flat and bit-exact to 1.2x, then 1.5x moves 115 samples and 2.0x
moves 3.7%. That is something leaking past a guard at absurd values, not a
filter scaling with its weights.

The mechanism is in the disassembly: the chain runs under a transition machine
where `mode == 0` copies the dry signal and a computed `ramp` modulates
intensity. Registration sets two flags (`+0x10a68`, `+0x10dac`) and nothing
drives the mode, so the dry path runs.

**What stands:** the client's codec runs on an ordinary Linux box (see
`native/COMPANION-EVIDENCE.md`), the registration path through
`opus_decoder_ctl(dec, 4085, blob, len)` is real and reaches the decoder, and
the next step is finding what drives the mode. **What does not:** any claim
about the port or the weights drawn from that neutrality. The version question
is open.

**And the lesson.** The control was built to tell "running and neutral" from
"not running", and it used a perturbation violent enough to answer a different
question. The discriminating test was the cheap one -- scale by a fifth and
compare the bytes. A control has to move the thing it tests by a little, not by
a lot.

## Companion: where each value comes from

Every claim, graded by evidence, is in `native/COMPANION-EVIDENCE.md`. Read it
before changing anything here: the grades matter more than the values, and the
one failure so far came from acting on an inferred claim as though it were
measured.

The Companion is NoLACE, and that identification rests on the client binary,
not on resemblance: the filterbank centres recovered from the client match the
published `center_bins_clean` bin for bin (64 arbitrary integers), the tensor
names in the `.pte` are the NoLACE layer names, and `af1_gain_bias=2` /
`af4_gain_bias=1` match `af1=(1->2)` / `af4=(2->1)`.

That licenses the structure. It does not license the constants. The client's
model is a *pruned* NoLACE — it ships `af1`, `af4` and `tdshape1` where the
reference has `cf1, cf2, af1..af4, tdshape1..3` — so this build already differs
from the reference, and whoever pruned the topology may have retuned numbers.

Rules that follow, and that cost us once already:

- A value measured from the client wins over the reference default. The
  adaptive-filter gain span is the live case: measured at 12 dB in the client,
  6 dB in the reference. Do not "fix" it to 6 dB.
- A value taken from the reference and *not* confirmed in the client is a
  hypothesis. Mark it as one where it is defined.
- Structure that two independent sources agree on (measurement plus reference)
  can be relied on: the 93-wide slice layout, the L2 kernel normalisation per
  output channel, the shaping branches adding rather than concatenating.

Measured in the client, and not to be replaced by a reference default:

- Adaptive-filter gain span `1.3815510273` (12 dB, twice the reference), read
  from the constant itself; the tanh feeds it with no hidden halving, so gains
  run over `[0.2512, 3.9811]`.
- Bit-count range `[10, 650]`, recovered from the clip bounds and their
  midpoint (`ln 10`, `ln 650`, and the half-sum) rather than assumed.
- One bit-count embedding, eight wide, over the *raw* count. The reference
  embeds a smoothed count beside it; this build has a single scalar and a
  single log, and no smoothing anywhere in the forward pass. Its eight scale
  factors sit in two SIMD quads, which read like two embeddings of four and are
  not — they multiply the same value.
- Those eight scale factors themselves. In the reference they are a *trained*
  parameter initialised to `(i + 1) * pi / (log high - log low)`, so the closed
  form describes only where they started. Do not regenerate them from it.
- Pitch index as `round(lag * 0.5 + 32)`, falling back to a fixed value when
  unvoiced — and the unvoiced check has to come *before* the offset, or a zero
  lag lands on a row that a real lag also uses.
- The cepstrum's DCT carries `1/sqrt(2)` on the output coefficient `c0`, with a
  global `sqrt(2/18)`.
- Kernel cross-fade over 15 samples under a raised cosine.
- The adaptive filter reads its kernel layer with no activation and applies
  tanh only to the gain. This one is worth stating because getting it wrong
  changes the filter's shape and not its level, so no amount of measuring
  output level would have caught it.

The last eleven slots were the reference's layout and are no longer: `[87:89]`
take two adaptive-codebook gains copied through, `[89:92]` take three
quantities through a `log10` and an affine step, and `[92]` takes an index with
no transform at all. Measured; see `native/COMPANION-EVIDENCE.md`.

**What those three quantities are is contested and the code's answer is not
settled.** They have been read as energies and as pitch lags, and both
identifications rested on a `x * 0.5 + 32` before the logarithm that a read of
the client's disassembly says is not there. The affine steps themselves are
confirmed twice over. Do not treat `lag_context` as established.

Still taken from the reference: the analysis window, and the inter-frame kernel
cross-fade, which came from a description rather than a measurement.

None of this is verifiable without a reference (input, output) pair produced by
the client itself. Property checks (`native/companion_test.c`) pin what the
maths must satisfy regardless, but they cannot tell a faithful port from a
plausible one. Such a pair now exists -- the client decoding the same packets
-- and the Companion is wired in against it; see "current state".

## Companion: the int8 weights are SIMD-blocked, not row-major

The weights are laid out for the client's SIMD kernel: blocks of 8 output
channels, and within a block, 4 contiguous inputs per channel. Reading them
row-major — which this code did — keeps every weight's magnitude and destroys
which input each belongs to. That was the root of the saturated activations:
15% of the GRU's outputs and 32% of `ft2`'s sat at +-1, against 1.9% and 5.6%
once fixed.

**The float layers have an oracle too, where their input has known order.**
`conv1` reads a 64-band spectral envelope, so neighbouring bands' weight rows
resemble each other under the right layout and not under the wrong one: the
correlation decays 0.747, 0.476, 0.262 with separation under `[in][out]` and
sits flat at zero under `[out][in]`. That confirms a layer which had no
evidence at all. The negative control is in the same layer -- over the
cepstrum's rows, where neighbours are quefrencies rather than frequencies, it
reads -0.199 and no decay. It weakly supports `alpha1_t` and cannot see
`pitch_embedding`, whose rows are flat at every separation.

**Half of the int8 layout is still unverified, and `subias` cannot verify
it.** `subias[o]` is a *sum* over one output channel's inputs, so it settles
which weights belong to a channel and is blind to their order within it: every
permutation gives the same sum. Reversing the four inputs inside each group
reads 1.42e-06 on it, byte for byte the same as the layout in use, and is worth
**4.7 dB** against recorded speech. The client's kernel reads them **forward**,
read from its disassembly, so the 4.7 dB is not a layout at all.

It is the trap this file keeps meeting, and the general form is worth carrying:
**in a chain where one stage is harmful, any change that destroys information
on the way into that stage improves the metric.** Reversing any single one of
`alpha1_f`, `ft1` or `ft2` lands at the value for switching the shaping off,
because each feeds the shaping and nothing else. `[out][in]` with no blocking
at all reads -0.02 dB, nearly the best number in this project, while failing
the oracle by a factor of 90.

So an improvement from a change that degrades information is not evidence —
it measures how much of the harmful stage the change switched off. Only a
change that preserves the filter's strength and improves quality is even a
candidate, and it still needs ground truth.

`subias` is what identified it, and is no longer unexplained. The client
compensates the input's zero point in the accumulator and cancels it with
`subias`, so `subias[o] = -127 * scale[o] * sum_i q[i][o]` — a per-output-channel
sum, which any layout mixing channels gets wrong while keeping the right
magnitude. That is why it measured as equal rms with nil correlation for so
long, and it makes it an oracle: scoring candidate layouts against it gives
r = 0.997 to 0.9998 with slope 1.00 across all nine int8 layers for the
blocking above, and nothing else close.

The input quantisation is `round(127x) + 127`, confirmed in the binary, so the
expansion `w = 127 * scale * q` and the zero point on the bias are both right.
There is no runtime weight normalisation — also confirmed — so the earlier
hypothesis about pre-normalisation weights is dead.

**The port is now fully audited against the client** — every constant, weight
layout, ordering and the whole signal chain read in the binary and agreeing
with this code. Four faults were found and fixed along the way: the int8
weights are SIMD-blocked rather than row-major, the filter taps run backwards
in time, the LPC envelope inverts the *squared* magnitude, and the pitch index
is the mean of two lags with no offset.

That last one is the cautionary tale. The correct value was already recorded
in this project's own provenance table, read from the client — and the code
did something else because it "measured better". A number was preferred over a
reading, and the discrepancy was written down instead of resolved.

**The output level was still wrong when this was written, and is no longer.**
Both readings offered here -- that the regime is real, or that something lives
in the exported weights -- were wrong: it was the envelope's mean reaching the
shaping exponent, which made the filter level-*dependent* rather than
mis-scaled. See the next section. What remains of it is a constant, located in
two gain stages.

A reference pair of (input, output) from the client is still what would settle
fidelity, and this work has never had one. Details, and the hypotheses tested
and not applied, in `native/COMPANION-EVIDENCE.md`.

## Companion: CTL 4058 is the LPC postfilter, and NoLACE is mode 6

**`opus_decoder_ctl(dec, 4058, n)` is `OPUS_SET_USE_LPC_POSTFILTER`**, a
documented request in the pinned `opus_mlow`, not a Companion mode. At 16 kHz
values 1 and 2 enable `smpl_lpc_postfilter` and 0 and 3 disable it -- which is
exactly what was measured on the client (0 and 3 dry, 1 and 2 byte-identical at
rms 301) before anyone read the enum. **This library can enable that
postfilter with one CTL**; there is nothing to port.

So every "client Companion" figure this project quoted in mode 1 -- identity
plus seven percent, peak +0.8512, +0.45 dB -- measured the classical
postfilter. In mode 1 the network runs for the two frames when the mode
engages and never again. **NoLACE runs every frame in mode 6**, which the pin
rejects (it accepts 0 to 3) and the client accepts. Its target, over steady
state: peak +0.9012, DC +1.1192, residual 8.25%, contribution rms 278.

Before measuring anything from the client, **count how often the code you are
reading actually runs.** Two readings today were taken from a network that was
running twice in 546 frames.

## Companion: the feature extractor is exact against the client

Compared vector for vector against the client's own 165 features, read from
its memory in mode 6 on voiced frames with a warm decoder: the clean spectrum
and the cepstrum correlate **1.000**, the autocorrelation matches to 1e-7
wherever it is given the client's pitch lag, and the whole vector 0.966.

Two fixes got it there. The predictor polynomial subtracts (below). And **the
cepstrum and the pitch correlation read the decoder's excitation** --
`fcb + adaptive + noise`, what drives the LPC synthesis filter -- **not the
decoded speech**: from the speech the cepstrum correlated 0.599 and its `c0`
averaged -5.17 against the client's -10.06; from the excitation, 1.000 and
-10.063. `CompanionFrameState` carries it as `excitation[COMPANION_FRAME]`.

Not the encoder's residual of the clean input (`reslpc.f32`): that correlates
0.994 only because a CELP excitation approximates it, and a decoder never has
it.

## Companion: what is exact (superseded -- see "current state")

Verified against the client's live values, from its own inputs:

- **The gain layers**, to 4.6e-4 over 96 gains (correlation 1.000000), given
  the client's conditioning.
- **`conv1 -> conv2`**, correlation 1.00000, the residual error being the
  client's int8 input quantisation.
- **`af1` and `af4` read the same conditioning**, in steady state as well.

And the conditioning is **`ft1`'s output**: `h = tanh(ft1 . [state || input])`,
exact over 160 sub-frames. `ft1`'s input is the GRU's state for the sub-frame
and its older input the previous one; the four buffers once labelled "tconv"
are those GRU states. Fixed -- see "current state".

## Companion: the predictor polynomial subtracts

**`A(z) = 1 - sum a_i z^-i`.** The codec dumps *predictor* coefficients, so the
whitening polynomial subtracts them. This build added them, which put `A(DC)`
near 2 instead of near 0 on voiced speech and flattened 64 of the 93 features.
Fixed in `companion_features.c`.

It was found by reading the client's own feature vector out of its memory and
comparing band by band. On a voiced frame the client's band 0 reads +2.64;
with the plus this build read -0.41, with the minus +2.67. The sixteen lowest
bands went from correlating **0.115** with the client to the whole block
correlating **0.995**, at rms 1.085 against the client's 1.122.

This convention was recorded as ruled out because negating it "measured
worse" -- on the decibel oracle, which scores an inert filter like silence and
so cannot see a wrong envelope. **Do not re-litigate it on decibels.**

## Companion: reading the client by ptrace, and what that did not settle

`fork` + `PTRACE_TRACEME` + an `INT3` at a known offset reads any value in the
client's memory without a debugger, which this WSL does not have
(`wsl/peek.c`, `wsl/peek.sh`). Offsets come from the disassembly; **values come
from here**, and three disassembly readings changed meaning once their values
were read -- the loop at `c3e30` is the inter-frame kernel cross-fade this
build already has, not a dry/wet mix.

Confirmed from the client's memory, structurally: `af1` and `af4` read the
**same** conditioning bit for bit, so the reference's chained wiring is wrong
for this model; tap 0 of each 16-tap block is zero; the normalised kernel is
the raw one times `gain / ||kernel||`.

**The tracer only survives two frames, and those are silent.** Three claims
made from them were withdrawn the same day: that the gains sit at their floor
(on speech they read **2.14 and 1.99**); that the client's conditioning is half
saturated (on speech 8.1%, comparable to this build's 6%); and that `af1` is a
low-pass/band-pass filterbank. **Check that a trace reached voiced material
before reading anything signal-dependent from it.**

Feeding the client packets from a voiced frame gets past that but starts its
decoder cold, and then only the bitstream-derived features can be compared --
they match at 0.976 to 0.997, the signal-derived ones do not. Inserting the
breakpoint mid-run to trace a warm decoder kills the child with `SIGSEGV` before
the first hit; that is the open problem.

## Companion: the decibel bar was silence, and the biases are the filter

**Output identically zero reads +0.00 dB against `clean.s16`.** The measure
divides `clean`'s energy by the error's, so emitting nothing scores zero --
not minus infinity. Every figure in this project near zero has to be read with
that in mind, and one of them was load-bearing:

| | rms / input | dB |
| --- | --- | --- |
| output identically zero | 0.000 | **+0.00** |
| the shaping switched off | 0.057 | -0.07 |
| **not filtering** | **1.000** | **+4.78** |

So the `+0.22` bar was **annihilation, not neutrality**, and the forty
configurations that converged on it were not all converging on inertness.
**Print output rms against input rms beside every decibel**; it is the one
column that tells the two apart, and it was never printed.

**The `af` chain alone removes the signal.** With the shaping off, the two
adaptive filters emit 5.7% of their input at a DC gain of 0.02.

**Their biases do the opposite, and have zero delay.** Normalise each kernel
layer's bias per output channel as `adaconv` does and cascade the two stages
-- pure arithmetic over the container: the peak lands on tap 30 of 30, which
is **delay zero**, matching the client's peak at lag zero. That confirms the
tap order and `COMPANION_FILTER_OFFSET 0` in one measurement, and it means the
**20-sample delay is a symptom**: the adaptive perturbation drags the kernel's
mass from tap 15 to tap 4, eleven samples per stage. An offset of 10 does move
the fitted peak to tap 0 and must **not** be applied -- that is fitting a
constant to a symptom.

**And bias domination is worth exactly the client's numbers.** `out = x + g *
conv(...)` is what a bias-dominated REPLACE already computes, so it measures
what fixing the perturbation would buy. With the shaping off it produces an
**interior maximum above not filtering** -- `+4.862` at `g` 0.075 against the
identity's `+4.779`, falling away on both sides. Nothing in this project had
ever beaten the unfiltered baseline. At `g` 0.15 the contribution is 302
against the client's 301, with `peak^2/energy` 0.985 against 0.977 and a
residual of 4.4% against 7.0% -- every axis in its neighbourhood at once.

It is a **proxy, not a structure to adopt**: the client's `adaconv` is REPLACE,
read from its disassembly. What it gives is a target with a number on it --
the perturbation has to come down to something equivalent to `g` 0.10 to 0.15,
from the 8.15 and 9.47 times the bias it sits at now.

**Two of the three gains are pinned at their floor**: `af1` channel 1 at
0.2793 and `af4` at 0.2646 against a floor of `exp(-1.3815510273)` = 0.2512,
where `af1` channel 0 sits at 1.0323. No trained gain saturates permanently.
The weights say why -- every one of the fifteen layers has a weight rms
between 0.077 and 0.149 **except the two gain layers**, at 0.277 and 0.406.
With a fan-in of 160 that is a pre-activation near 2.8 and `tanh` has no
choice. The kernel layers show the same disease one stage over, so it is
probably one cause, and it is what this work is now chasing.

Refuted on the way, so they are not re-run: the reference's feature-net order
(`conv2 -> GRU -> tconv`, the GRU once per frame with `tconv` upsampling its
state) is worse on every axis -- residual 93.4% against 38.0% -- and a scale on
the conditioning trades the peak against the DC and never brings both.

### Getting the decoder's own features out

The codec dumps them itself. Configure a native build of the pinned source with
`-DSMPL_DUMP_FEATURES=1` and `opus_decoder_init` calls `smpl_open_dec_files` on
its own, writing one file per feature into the working directory plus
`coded.s16`, the decoded signal. Encode and decode with `OPUS_SET_USING_SMPL(1)`
on *both* ends -- without it on the decoder, MLow packets come back as
`OPUS_INVALID_PACKET`.

Build it against a **copy** of the pinned source, not against `.cache`: the
build there is WebAssembly and cannot run a dump, and patching that tree would
feed the patch to the next wasm build.

    cmake -G Ninja -DCMAKE_C_COMPILER=gcc -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_C_FLAGS=-DSMPL_DUMP_FEATURES=1 -DOPUS_BUILD_SHARED_LIBRARY=OFF \
      -DOPUS_BUILD_TESTING=OFF -DOPUS_BUILD_PROGRAMS=OFF <copy of the source>

Three of the dumps are not what their names say:

- `features_num_bits` comes out as a constant 1 rather than the payload size,
  so record the packet size yourself.
- `features_period` keeps every other lag, because the client keeps both and
  averages them.
- **`features_gain` is not a gain.** The decoder writes
  `gain_tab[fcbg_idx[sf]] + nrgres[sf]` -- the *sum* of two quantities the
  Companion consumes as separate features, in slots `[89]` and `[91]`. Any
  measurement that fed it fed a sum.

To separate them, give the pair to `features_offset`, which otherwise writes
only zeros and is the spare channel for exactly this:

    /* smpl/smpl_core_decoder.c, replacing the fp_features_offset block */
    CelpTables* pTblO = (CelpTables*)g_smpl_celp_tables;
    float* gtab_o = lb_params.voiced ? pTblO->fcbgains_v : pTblO->fcbgains_uv;
    float pair[2];
    pair[0] = gtab_o[lb_params.fcbg_idx[sf]];
    pair[1] = lb_params.nrgres[sf];
    fwrite(pair, sizeof(float), 2, dec_state->fp_features_offset);

Their sum reproduces `features_gain.f32` to float precision, which is the check
that the split is the right one.

## Companion: measure it against `clean.s16`, not against a level ratio

The feature dump writes `clean.s16`, what went into the encoder, beside
`coded.s16`, what came out of the decoder. A post-filter's job is to move the
second towards the first, and that is checkable here without the client. **No
level ratio can say it** — a filter can land any level you like while
destroying the signal, and this one did.

Measured over a real decode, aligned by cross-correlation and clipped at
`+/-1` as the client's int16 stage would: the decoded signal sits at **+2.45
dB** from clean and the filtered one at **-5.01**. The Companion makes the
signal worse in every configuration tried, and with both the shaping and the
`af` gains forced to unity — leaving only the normalised kernels — it still
costs 1.8 dB.

**Confirmed on recorded speech**, eleven seconds of it through the pinned codec
at 15.3 kbps, because a harmonic synthesis might have been material the model
was never meant to see. It is worse there, not better: **+2.90 dB unfiltered
against -12.48 filtered**, a cost of 15.4 dB where the synthesis cost 7.5.

And the decomposition is clean. **Turning the shaping off recovers 12.7 of
those 15.4 dB** and reads +0.22 -- which is *not* "nearly neutral", it is near
silence: that configuration emits 5.7% of the signal's level. With the `af`
gains also at unity it reaches +0.94. So the two adaptive FIRs cost about 2 dB
between them and the shaping's per-sample gain costs the rest. That is where
the remaining work is.

To generate the dump from a recording rather than a synthesis, see
`dump_real.c` in this session's scratchpad: it takes a 16 or 48 kHz mono WAV.
A Telegram voice note converts with
`ffmpeg -i <note> -ac 1 -ar 16000 -sample_fmt s16 out.wav`, which leaves
`clean.s16` slightly lossy — it arrived as Opus — and that flatters every row
equally rather than explaining a 15 dB gap.

It also arbitrates. The envelope-mean fix below is worth **16.9 dB** on it —
an oracle it was not chosen against. And the int8 bias fix *costs* 4 dB on it
and is still right, because it is verified against the container to float
precision: what it does is expose something the doubled bias was compensating.
When a metric and ground truth disagree, ground truth wins and the metric has
told you where to look next.

## Companion: the shaping was level-dependent, and that is now fixed

At the median frame, real speech comes out at **0.27** times the level that
went in, where it came out at **1.2e6** before, and the filter is now
scale-equivariant to 9%. The change is one line: the envelope branch no longer
carries the pooled log-magnitude's mean.

The reason it took so long is worth more than the fix. Every measurement asked
whether the output level was *right*, at one input level, and that question
cannot tell a wrong filter from a level-*dependent* one. This filter was
level-dependent: the shaping's exponent is exponentiated, so an absolute level
reaching it makes the output move with the *exponential* of the input's. Over a
64x sweep of the input the ratio ran 1.7e11 down to 12.5 -- a slope of -4.61
where 1 is equivariant.

**And measure it at the median frame.** The aggregate ratio is a tail statistic
once the shaping gain spreads a hundredfold inside a frame, and it misreads
badly enough to have sent this work down a wrong path for an hour: in aggregate
the same sweep looks non-monotone, which is not a level dependence at all.

**And sweep the input through the codec, not past it.** Scaling the decoded
signal while the decoder's features stay put is not a quieter call — it is a
quiet signal carrying the loud signal's LPC, gains and energies, and the
network answers the mismatch. Re-encode at each amplitude instead. Done that
way the filter holds to 1.11x over 16x with a slope of 1.02; done the other
way it reports 0.41 and blames the cepstrum's `c0`. The envelope mean's defect
survives either sweep, by seven orders, because it is a direct path from the
signal to the gain rather than a feature that can fall out of step.

**So sweep the input level.** A post-filter has to be close to
scale-equivariant, and that follows from what a post-filter is, not from
anything the client has to confirm. It is the only claim in this work that
needed no reference, and it is the one that found the defect. Ten
configurations had been tried against single-level metrics and every wrong one
improved one and worsened the other -- which is also what a level-dependent
filter does whenever you shift its operating point.

`native/companion_test.c` now runs the same speech at two levels eight times
apart and fails if the ratios disagree by 2x. Reinstating the mean gives 4.4e8.

Two things not to redo:

- **Do not "stop demeaning" to match the reference.** The reference feeds the
  log envelope raw and does not demean at all, so that reads like the obvious
  correction. Read from the weights, the mean's coefficient is 0.3640 through
  its own slot and 0.6414 raw across all 21 channels: the reference convention
  is **1.76x worse**. The demeaning was already protective.
- **Do not put something in the twenty-first slot without measuring it.** The
  model has 21 envelope channels per tap where pooling gives 20, so the slot is
  real. It holds zero, which is the neutral value for a demeaned feature and is
  not a claim about what belongs there.

The tone's crest, which this work chased for a long time, turns out not to be
distortion. Per sub-frame the output reads 1.577 against an input of 1.436 and
a sine's 1.414 — the waveform is barely touched. The 2.80 measured over a whole
file is the output's *level* moving 2.56x between sub-frames while the input's
moves 1.07x, and most of that appears at `af1`. So the hypotheses aimed at a
distortion mechanism — the exponent clamp, the cross-fade, the tap order — were
aimed at the wrong thing.

What remains is **not a dependency but a constant**. The slope is 0.91 and the
0.09 left is the cepstrum's `c0` -- zeroing it reads 1.00 exactly -- but `c0`
is computed correctly: the client's transform has been read off its
disassembly, a `1/320`-normalised FFT whose `x 320` cancels it, leaving the
magnitude of a direct DFT, which is what this build computes. Five rescalings
of the band magnitudes were measured and every one makes the level worse.

**Every point either the disassembly or the weights can check now agrees with
this build** — the SIMD input order, the int8 scale and zero point, the output
channel assignment, `ft1`/`ft2`'s `tanh`, `alpha1_f`'s `[previous || current]`
input assembly, what both state taps hold, that neither resets per frame, that
nothing clamps the exponent or the gain, `alpha2`'s column structure and the
absence of upsampling, `conv1`'s layout, the container's integrity and the
model's identity. And it still costs 15.4 dB.

So the leading hypothesis is no longer a piece of the implementation: the
client loads a **versioned** ExecuTorch `.pte`, and a version this work has
never seen would produce exactly this — every structural check passing because
the structure is right, and the output wrong because the numbers are not. What
that needs is the version string the client requests.

**The bar is not +0.22 dB and never was** -- see "the bar was silence" below.
`+0.22` is a fifth of a decibel above emitting *nothing*, and "switching the
shaping off" emits 5.7% of the signal. The bar is the value for **not
filtering**, `+2.90` on this dump. About forty configurations have been tried — clamps, smoothing
widths, conditioning scales, weight layouts, wirings, state buffers,
activations — and **none has ever cleared it**. So the shaping is not mis-tuned
in a way a different constant recovers, and the one thing measurably out of
place, the magnitude of `h`, comes from weights and an input both verified
against the client.

What is left is a **tail**. On real speech the shaping exponent reaches 20.570
where its median is -1.528, which is a gain of 8.6e8; five percent of active
frames come out more than ten times their input and the worst comes out 1.7e5
times it. **Every level figure this project has ever quoted was a reading of
that tail**, because a ratio of energies is a sum of squares and a handful of
frames own it.

Stated the way the client would experience it, since it converts to int16 and
therefore clips: **26% of active frames saturate something** and the worst
saturates 18% of its samples. Clipping turns the 1.7e5 into audible distortion
rather than removing it, and the clipped level still spans 0.21 to 3.52 across
frames.

The rule that covers this, and the aggregate-versus-median trap above, is one
rule: **match the statistic to the non-linearity downstream of it.** A gain
that gets exponentiated answers to its top hundredth of a percent, not to its
median. Today this file both mistook a tail for a centre and, an hour later,
a centre for the whole.

The one before it was found too, and it was **not** `af4`'s gain. Every int8
layer was running with twice its bias: `subias` is `bias - zero_point`, not the
zero point negated, so adding it to the bias added the bias to itself. Verified
against the container across all 2224 output channels of the nine int8 layers,
where `zero_point + subias` reproduces the `_bias` chunk to 4.5e-06. Fixing it
takes the median frame from **0.30 to 1.43**.

Do not chase `af4`'s gain. Its median of 0.30 is by design — the client has no
output scale on the gain convolutions, read from its loader and its matmul —
and `af1`'s channel 1 does exactly the same thing with the same weights, while
`af1`'s channel 0, the pass-through, is built eight times smaller and sits at
1.13. Forcing `af4` to 1 does move the level, because over-amplifying moves the
level. That was a symptom read as a cause, and it cost a detour.

The rest is the shaping's exponent, whose median sits at -1.9 where its own
bias is +0.105. Force both gains to 1 and the median frame lands at 0.88 of its
input, so those two stages are the whole of what is left.

That section of `COMPANION-EVIDENCE.md` used to conclude the opposite — that a
pinned gain could not explain the level. It was right then: the output was
sixteen orders too *loud*.

**This is the pattern worth carrying, not the instance.** A refutation measured
under a dominant defect expires when the defect is removed, and three did today
— the pinned gain, "normalise the windowed signal", and "something bounding the
exponent is missing". Each was sound against its own evidence. Before citing
any refutation in `COMPANION-EVIDENCE.md`, check what the level ratio was when
it was made: if it reads 1e17, it was measured under the envelope defect and
has to be re-run.

Also recorded there, and it invalidates the *precision* of every level measured
before this: `state->lag_context` and `state->side_index` are never written by
the measurement harness, so slots `[89:92]` were pinned at 5.205, 3.080, 0.773
and 0. Slot 89 carries the largest weight norm in the whole model.

## Companion: feed all four predictor sets, and the test now fails

`CompanionFrameState.lpc` is **one set per sub-frame**. Both harnesses filled
`SUBFRAMES / 2` of them with stride 2, which gave sub-frame 1 the coefficients
of sub-frame 2 and left sub-frames 2 and 3 at zero -- and a zero polynomial
makes the clean spectrum, 64 of the 93 features, identically flat for half of
every frame. The codec's dump carries four distinct sets per frame; it was the
reader that was wrong. Fixed in `native/companion_test.c`.

**`native/companion_test.c` now fails and must not be made to pass by feeding
half the sets again.** With all four fed, a proper codec sweep gives median
ratios of 31.3, 8.1, 9.8, 4.0 over 16x of input -- a spread of **7.7x** where
1.11 is recorded here. The equivariance was the degenerate half.

The cause is the **cepstrum's `c0`**, the mean of the log band magnitudes and
therefore the absolute level, reaching the shaping exponent by the same path
the envelope's mean did. Zeroing it gives 2.27, 2.17, 2.13, 2.09 -- a spread of
1.09 -- and 1.04 dB. It is **not applied**, because slot 64 is confirmed to be
in the client's vector and deleting a feature contradicts a structure two
sources agree on. And the way to keep both, "normalise the windowed signal",
is re-refuted under this fix: it inverts the dependence, 2.9 to 115.7, and
costs 1.87 dB.

**The clean spectrum is the only harmful group of the 93.** Zeroing `[0:64]`
recovers 4.9 dB; zeroing the cepstrum costs 3.1, the autocorrelation 1.5, the
ltp gains 0.6, the decode context 0.7, and the side index does nothing.
Zeroing all 93 recovers 10.8 and the embeddings another 1.5, which measures
sensitivity rather than offering a filter -- fed nothing, the network emits
`exp(0.105)` and is neutral by construction.

**Computed exactly as the reference computes it, the group is still harmful.**
The filterbank tables are byte-identical to `center_bins_clean` and
`band_weights_clean`, the accumulation matches line for line, the `0.3 * log`
is there, and the reference's `mag_spec_320_onesided` returns `320 * |FFT|`
over a `1/320`-normalised transform -- the plain DFT magnitude this build
computes, which settles the `320` from the source. The only difference left is
the square; dropping it gains 1.6 dB and the group still costs 3.3. The feature
is no longer in question, what consumes it is.

The square's provenance is weaker than it reads: it comes from the same client
reading that produced the `320`, and that half is confirmed wrong by 8.9 dB.
Left in place -- a metric does not overturn a reading -- but it is a hypothesis
now, and marked as one where it is defined.

**The whole extractor is now audited against `osce_features.c`.** The slice
layout, the polynomial's sign, the filterbank tables (byte-identical), the
accumulation, the magnitude normalisation, the `0.3 * log`, all three `1e-9`
epsilons, the cepstrum's `frame - 160` window and its even/odd refresh, the
autocorrelation, the unvoiced pitch row 7 with hangover disabled, the bit-count
`sin(scale * x - 0.5)` with its clip and midpoint, and `tanh` on `conv1`,
`conv2` and `tconv` all match. Three things differ and all three are
deliberate: the squared inversion (ASSUMED), the pitch index as the mean of two
lags (measured), and the `[87:93]` layout (measured).

**But matching stock OSCE is not matching the client.** The client is a fork
and its model was trained against what the fork computes. Every row of that
audit is somewhere a fork could differ without this comparison noticing, which
is why the square matters out of proportion to its 1.6 dB: it is the one row
where a divergence is already suspected.

A near-miss worth keeping: the reference embeds the bit count twice, raw and
smoothed, and the codec dumps `features_num_bits_smooth` and implements the
same `0.9 / 0.1` smoothing -- which reads as evidence that the Companion wants
both. It does not. `compute_nolace_numbits_embedding` ignores its `dim` and
writes eight per call, and `fnet_conv1` takes 165 = 93 + 64 + 8. One call. A
codec dumping a feature is not evidence that this model consumes it.

Two rescalings of that group were measured and neither is the answer: the
reference's unsquared `1/|A|` gains 1.6 dB and demeaning the 64 bands gains
2.5, against the 4.9 that removing the group gives. It is wrong in kind, not
in size. The client's `320` is confirmed not to belong -- applying it costs
8.9 dB.

## Companion: the envelope may not be inverted at all

The single largest result in this work, and it is held rather than applied.
`0.3 * log(|A|)` in slots `[0:64]` -- the predictor polynomial's magnitude,
band-pooled and logged, with **no reciprocal and no square** -- reads **-3.12
dB** against recorded speech where the `1/|A|^2` in place reads -12.34.

Three measures move together, and a fourth that was claimed here does not
discriminate:

| | as built | no reciprocal |
| --- | --- | --- |
| dB from clean | -12.34 | **-3.19** |
| the group is worth | -4.9, harmful | **+4.3, useful** |
| median peak shaping gain | 331 | **0.954** |
| sub-frames peaking over 1000x | 41.3% | 2.4% |

The second row is the structural one: zeroing the group reads -7.48 whatever
is in it, so what is there is *worse than absent* and this is worth 4.3 dB of
its own. Nothing else tried has crossed that line. And it destroys no
information -- a sign in the log domain -- so the trap that governs every other
result here does not apply.

**Scale equivariance does not distinguish the two and was claimed here as
though it did.** Zeroing the cepstrum's `c0` restores it to 1.09x with the
reciprocal in place. The LPC is not carrying level either: predictor
coefficients are scale-invariant by construction, and the dumps confirm it over
a sixteen-fold codec sweep -- coefficient rms 0.374, 0.389, 0.389, 0.392, the
feature's median -0.086 to -0.092 and its deviation 0.310 to 0.315.

**All the damage is above 4 kHz.** Zeroing `[0:32]` reads -12.37, which is
nothing; zeroing `[32:64]` reads -7.17, better than zeroing all 64.
`centres[32]` is bin 80 of a 320-point transform at 16 kHz, which is 4000 Hz.
Not the codec's band split -- `features_hb_lpc.f32` is zero bytes at 16 kHz --
and not a misbehaving feature, whose per-quarter deviation runs 0.12, 0.25,
0.28, 0.49 inside `[-1.61, 2.43]`.

**Discarded, and the dataflow closed it rather than the opcode.** The `rcpps`
writes **in place** into the same stack buffer the filterbank then reads, so
there is no second path and no other feature: the client's `[0:64]` is
`0.3 * ln(sum w * 1/(|A|*320)^2)`, which is what this build computes. And
there is no LPC normalisation anywhere -- the coefficients enter the transform
raw, the scale-invariance coming from the predictor being gain-free.

**So `k = -0.5` is the less-filter trap in its purest form, and calling it the
largest result here was wrong.** A sign flip in the log domain destroys no
information, which is why it passed the test this file usually applies. The
trap has a wider mouth than that: **a change that preserves information can
still improve a metric only by weakening a stage that is wrong.**

Two more ways the same group refuses to be repaired. Demeaning `[32:64]` with
a running average reads -8.76 and freezing it at that average reads -11.25,
against -7.17 for zeroing it -- so it is more the mean than the spread, and
neither beats not having the feature. And a constant added to those bands goes
-10.65, -8.54, -6.15, -4.49, -2.87, -1.00 at +2, then -8.67 at +3, -1.03 at +5
and **+0.20 at +10**, which is the shaping switched off: a large constant
saturates the layer's `tanh` and disables the filter. No constant to explain.

**Both platforms compute the feature the same way, and that was worth checking
because the weights and the disassembly come from different binaries.** The
weights came from Android (`libopus_mlow.so`, which the model MANIFEST names)
and every read of the chain was on the desktop DLL. Feeding desktop-shaped
features to Android weights would give exactly this symptom. It needs no
disassembler to rule out -- `libopus_mlow.so` carries `center_bins_clean` as 64
int32 at `0x1aaf0`, **identical** to this build's value for value, the band
weights at `0x1abf0` identical to 2e-08, the cepstrum's tables at `0x1acf0` and
`0x1ad40`, `320.0` as a double, `0.3` and `1e-9` as floats, `0.5^16` and the
gain span `1.3815510273`. One external model file serves both platforms, so a
convention that differed would leave one broken. The same binary also carries
all four of the bit-count embedding's constants -- `ln(10)`, `-0.5`, `ln(650)`
and `-4.38977909`, the last being the half-sum of the two bounds to float
precision. The midpoint is what makes them a formula rather than a
coincidence, and it confirms `sin(scale * (clip(log x) - 4.389779) - 0.5)`
exactly as built. Only the source of `x` is open.

**And every boundary of the 165-wide vector is confirmed from the weights.**
An input group with a natural order gives neighbouring `fnet_conv1` rows that
resemble each other. Adjacent-row correlation: `[0:64]` **+0.75**, `[64:82]`
-0.20, `[82:87]` **+0.69**, `[87:89]` +0.59, `[89:92]` +0.09, `[93:157]`
-0.05, `[157:165]` +0.09 with **+0.83** between its first two. The transitions
are sharp -- `63 -> 64` drops to +0.03, `156 -> 157` to -0.08 -- so the
assembly `[93 || 64 || 8]` is right, and the autocorrelation block at
`[82:87]` is confirmed for the first time.

Worth knowing where the damage lives: above 4 kHz the decoded signal carries
**0.45%** of its energy and the clean one 0.62%, and the codec tracks the band
(-1.64 dB at 4-6 kHz) rather than discarding it. The noisiest part of the
feature vector -- deviation 0.49 over 6-8 kHz against 0.12 over 0-2 --
describes the quietest part of the signal, and `fnet_conv1` gives those rows
the group's largest norms. A model trained on this feature knows what that
noise means; one that was not is where its errors surface first.

**Which makes this the strongest version argument in the project**, since the
feature is now confirmed correct against the client and is still worse than
absent. Every op of the client's chain matches this build -- the filterbank
boundaries `2, 5, 8, 10, 12, 15 ... 160`, the weights
`0.6667, 0.4, 0.3333, 0.4, 0.5 ...`, the Nyquist bin doubled into band 63 at
0.333, the `0.3 * ln(x + 1e-9)` with a natural log, and no clamp or extra op
anywhere.

The `320` is the one place the descriptions look different and are not: the
client multiplies `|A|` by 320 before squaring, which is a constant `-3.46` in
the log. Applied here as a pure shift -- one line, transform untouched -- it
reads -21.21, and the opposite shift reads -9.49. It un-normalises the client's
transform; this one is unnormalised already.

Scaling the 64 logged features by `k` maps it: 1 (as built and as the client
computes) -12.34, 0.5 (the reference's formula) -10.76, 0 (absent) -7.48,
**-0.5 -3.19**, -0.75 -3.69, -1 -5.75. A smooth curve with one maximum, and
`k = -0.5` is exactly `0.3 * ln|A|`. The model wants minus half of what the
client computes.

Ruled out on the way: the polynomial's sign convention (negating it is worse in
the cell that matters), the clean spectrum as the signal's band energy
(`|FFT|^2` reads -18.44), and the last eight of the 165 as a pitch encoding
rather than the bit count (-15.01 against -12.34; the clip bounds `[10, 650]`
fit a 20 ms payload and not a pitch lag).

## Companion: hang the conclusion on the clipping, not on the dB

The argument that these weights are not the client's runs: the feature is
confirmed correct on both platforms, the consumer is confirmed correct from the
weights, and the model treats the feature as **worse than absent** -- which a
shipped model cannot do. That last step is unsound as stated. "Worse than
absent" is measured in dB against `clean.s16`, and NoLACE-family post-filters
are trained on perceptual and adversarial losses; such filters routinely lower
SNR while raising perceived quality. A negative dB is not by itself evidence
that anything is broken, and every measurement here inherits that caveat.

**What carries the conclusion is the gain, which no choice of oracle touches.**
The median sub-frame's peak shaping gain is **331**, 41.3% of sub-frames peak
above 1000x, and the client converts to int16: over recorded speech, **5.62% of
output samples exceed full scale and 50.5% of frames contain at least one.** A
post-filter that clips one sample in eighteen and touches half of every second
is broken under any metric, and no training objective produces it.

So the dB oracle earned its place by **localising** the fault -- to one feature
group, then to the half of it above 4 kHz -- and not by proving it exists. Keep
the two jobs apart.

## Companion: the shaping gain is uninformative, not mis-scaled

The defect is not a level and not an alignment. Scaling `alpha2`'s input by `k`
converges to +0.22 dB -- the shaping switched off -- with a best point of +0.26,
so **no missing scale factor rescues it**. Rotating the 80 gain values across
the sub-frame, reversing them, or reading them as 20 positions by 4 phases all
land within 0.4 dB, and at a non-destructive spread the *correct* alignment is
worse than three of four rotations.

Measure any of this at `k=0.25`, not at `k=1`. At `k=1` the gain spreads 794x
inside a sub-frame at the median, so every arrangement destroys the signal
equally and the comparison is empty. The same control reverses the
conditioning-lag result: at `k=1` delaying the conditioning by 285 ms *improves*
the filter, at `k=0.25` it costs 0.10 dB. **The conditioning carries 0.10 dB
where 12.7 dB is missing.**

And all three stages are harmful, not just the shaping: shaping off reads +0.22
and the `af` gains at unity as well reads +0.94, both below the +2.90 of not
filtering. `af1`, `tdshape1` and `af4` read the same conditioning and nothing
else, so the fault is upstream of it.

Two leads that measured out, recorded so they are not re-run: the assignment of
the three quantities in slots `[89:91]` spans 0.86 dB across five readings and
is not the defect, even though `sum(adaptive codebook^2)` matches slot 89's
normaliser to 0.12 dB; and no permutation of `alpha2`'s outputs onto the
sub-frame's samples beats the consecutive one.

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

## The client's own codec runs on an ordinary Linux box

`libopus_mlow.so` from the WhatsApp Android bundle loads under glibc and
decodes real MLow. A plain `dlopen` fails with ``version `LIBC' not found``,
which looks like a missing library and is not: bionic tags its symbols with
the version `LIBC` where glibc uses `GLIBC_2.x`, and the names all match.

On a **copy**, neutralise `DT_VERSYM`, `DT_VERNEED` and `DT_VERNEEDNUM` in
`.dynamic` and mark `.gnu.version`/`.gnu.version_r` as `SHT_NOBITS`. The
dependency closure is four libraries (`libar-bundle3`, `libc++_shared`,
`libfbjni`, `libglog`), all needing the same treatment. Of the 256 symbols
they import, glibc and friends provide 233; the remaining **23** are
bionic-only -- the `__android_log_*` family, the `_chk` fortify variants,
`__errno`, `__sF`, `_ctype_` -- and a hundred-line shim covers them. Load the
shim `RTLD_GLOBAL` first, then the library `RTLD_LAZY`.

**The divergence is entirely in MLow; plain Opus is bit-identical.** Encoding
the same speech and decoding each packet set in both implementations, with and
without `OPUS_SET_USING_SMPL(1)`: plain Opus comes out **byte for byte
identical**, all 174720 samples, zero delay. MLow comes out with a 48-sample
offset, correlation 0.957 and SNR 10.6 dB. So the pinned build's Opus core *is*
the client's -- same arithmetic, same tables -- and only its **MLow** is a
different version. This library wraps `opus_mlow v1.0.1`; its plain Opus is
what WhatsApp runs and its MLow is not.

**And the pin is not the client's codec.** Given the same packet bytes, the
vendored `opus_mlow v1.0.1` and the client's library differ by **48 samples of
delay** and 10.6 dB of SNR once aligned, with only 5 frames of 545 identical.
It is not a filter difference -- the mean spectrum matches to 0.4% in every
quarter of the band and no 65-tap FIR closes the gap -- and not state escaping,
since the per-fifth SNR is flat at 9.9 to 14.1 dB. Against the clean signal the
pin reads +4.37 dB and the client +1.94.

So reference vectors and comparisons made against the pin describe a close
relative of what WhatsApp ships, not the same build. The Companion does **not**
run inside the client in this configuration, because the weights are external
and nothing registered them -- though do not reach for the client's +1.94 and
this build's -12.34 as a pair: they come from different encodes against
different references. Only the pin-versus-client row is a comparison, since it
shares its packets and its reference.

**And the instrumented codec destroys the dump it is run beside.** `libopus.a`
built with `SMPL_DUMP_FEATURES=1` calls `smpl_open_dec_files` from
`opus_decoder_init`, which truncates every dump file in the current directory.
Any tool linking it and run inside the dump directory silently replaces the
dump with its own. It happened here and moved the baseline from +2.90 to +4.73;
regenerating restores it bit for bit, since the dump run is deterministic, and
every figure reproduced. Run such tools somewhere else.

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
