# The Companion: what is measured and what is assumed

Every claim this implementation rests on, graded by how we came to believe it.

This exists because the grades were mixed together in comments and got treated
as equally solid, and one of the weakest turned out to be load-bearing: the
int8 dequantisation rule, inferred from matching chunk sizes, produces layers
that cannot work. Several rounds of structural changes were aimed at a level
that was never going to come right, because the network underneath was broken.
A claim's grade has to travel with the claim.

## Grades

**Measured** — read out of the WhatsApp client binary. The client is the only
authority on what the client does.

**Codec source** — read out of `opus_mlow`, the codec this library builds
against. Authoritative for what the *codec* produces, which is what feeds the
Companion. Not authoritative for what the client's post-filter does with it.

**Reference** — taken from the published NoLACE implementation in `xiph/opus`.
The client's model is a *pruned* NoLACE with retuned constants, so this is a
starting hypothesis, never a conclusion. Of the constants where the two could
differ and we have checked, **most differed**.

**Inferred** — deduced from tensor dimensions, byte counts, or plausibility.
The weakest grade. The one failure so far came from here.

## Identification

| Claim | Grade | Basis |
| --- | --- | --- |
| The model is NoLACE | Measured | Filterbank centres recovered from the client match the published table across all 64 arbitrary integers; tensor names are the NoLACE layer names; `af1_gain_bias=2` / `af4_gain_bias=1` match `af1=(1→2)` / `af4=(2→1)` |
| It is a pruned NoLACE | Measured | Ships `af1`, `af4`, `tdshape1`; the reference has `cf1, cf2, af1..af4, tdshape1..3` |

Identification is solid. It licenses the *shape* of the thing and nothing
about its numbers.

## Constants — all measured

| Claim | Basis |
| --- | --- |
| Gain span `1.3815510273` (±12 dB, twice the reference) | Constant read at `DAT_0010276c`, bytes `aa d6 b0 3f`; no hidden halving anywhere on the path |
| Bit-count range `[10, 650]` | Clip bounds and midpoint recovered: `ln 10`, `ln 650`, half-sum `4.389779` |
| One bit-count embedding, eight wide, over the raw count | One log, one scalar, no smoothing in the forward pass; the eight scales sit in two SIMD quads that read like two embeddings and are not |
| The eight scale factors | Dumped. In the reference these are a *trained* parameter merely initialised to `(i+1)·π/(log high − log low)`, so the closed form must not be used to regenerate them |
| Pitch index is the rounded mean of two lags, with a fallback when unvoiced | Read from the client |
| DCT carries `1/√2` on output coefficient `c0`, global `√(2/18)` | 18×18 matrix dumped and compared, max error 0 |
| Kernel layer takes no activation; tanh applies only to the gain | Activation argument read at the call site (`0` = linear, `2` = tanh) |

This block is the strongest part of the implementation. Nothing here should be
"corrected" toward a reference default.

## Structure — mostly reference, and unvalidated

The 93-wide layout is corroborated in its *widths* by measurement, but the
meaning of the last eleven slots comes from the reference alone.

| Claim | Grade | How to validate |
| --- | --- | --- |
| Slices `[0:82]`: 64 clean spectrum, 18 cepstrum | Reference (widths corroborated) | Confirm the write offsets |
| Slice `[82:87]`: 5 autocorrelations | **Measured** | Traced in the client's extractor |
| Slices `[87:93]` | ❌ **Conflict — the code is wrong here** | See below |
| Clean spectrum is the LPC envelope, inverted, `0.3·log` of the **squared** magnitude | **Measured** | Read at instruction level: the `0.3` is in the client, and the envelope is `1/((|A|·320)² + 1e-9)`. The `×320` cancels the client transform's `÷N` and does not transfer to the unnormalised transform here |
| Cepstrum window opens 160 samples before the sub-frame | Reference | Check the pointer offset the client passes to its windowing |
| Autocorrelation over an 80-sample window at offsets −2..+2 | **Measured** | `Σxy/√(Σx²Σy² + 1e-9)` over lags `pitch ± 2`, confirmed in the client; the measured rms matches this build's |
| Four sub-frames per frame | **Forced by dimensions** | `tconv` emits 640 and the GRU consumes 160 per step; 640/160 = 4, with no freedom left |
| `conv2` is kernel 2 over *frames*, consuming all four sub-frames of each | **Forced by dimensions** | `gru_input` takes 160 per step and `tconv` emits 640, so there are exactly 4 sub-frames; `conv2` takes 768/96 = 8 conv1 vectors, so 2 frames. 8 sub-frames per frame would need `tconv` to emit 1280 |
| GRU steps once per sub-frame | **Forced by dimensions** | `tconv` emits 640 and the GRU consumes 160 per step, so it runs exactly four times per frame |
| Filterbank **weights** | Measured | Dumped from the client's `.rodata`, and they match the published table — including the two edge bands, `0.6667` and `0.25`, which were the suspect part. This entry previously said they were unmeasured; that was my error. Two independent sources agreeing makes this one of the strongest claims here |
| Analysis window `sin(π(n+0.5)/320)` | **Measured** | Confirmed in the client: sine window, unnormalised, and applied only to the cepstrum — the clean spectrum is unwindowed |

## Codec-side inputs

| Claim | Grade | Note |
| --- | --- | --- |
| LTP is `acb_gains` in the pattern `[0, g1, g0, g1, 0]`, zero when unvoiced | Codec source | Confirmed in a real decode: `[0, 0.171, 0.644, 0.171, 0]` |
| The gain dump is `gain_tab[fcbg_idx] + nrgres` | Codec source | Read from the decoder |
| That gain is in **decibels**, so the feature needs `10^(dB/20)` before its log | ❌ **Probably wrong** | The client was traced applying `log10(energy)` followed by an affine step, with no `10^(dB/20)` first. See the conflict below |
| `features_num_bits` dumps a constant 1, not the payload size | Codec source | Verified against 189 bits/frame of real packets; use the packet size instead |
| `features_period` keeps every other lag | Codec source | Consistent with the client keeping both and averaging |

## Container and weights

| Claim | Grade | Status |
| --- | --- | --- |
| Chunk walk and 128-byte alignment | Inferred | Closes byte-exact on both files. Note this validated the *walk* and not the *contents* once already — an earlier offset bug still closed exactly while shifting every tensor's data by up to 127 bytes |
| `dtype` 0 = float32, 3 = int8 | Inferred | Consistent with every size, unverified otherwise |
| `scale`/`subias`/`bias` are per output channel | Inferred | From dimensions matching the output width |
| The dequantisation rule | **Measured** | The client runs an integer GEMM: input quantised as `round(127x) + 127`, accumulated against the int8 weights, scaled per output channel. In floats that is `w = 127·scale·q` and `b = bias + 127·scale·Σq`. The factor of 127 was the whole of the 85× discrepancy — weights load at rms 0.103 where they were 0.0009 |
| What `subias` is for | ⚠️ **Open conflict** | See below |
| Samples are on the int16 scale | **Measured** | Not a free convention: the shaping stage takes a logarithm of the signal envelope, so the scale shifts its output rather than scaling it. Feeding normalised samples drove the following exponential past 1e12; the int16 scale brought the same measurement to 13× |

## The bias conflict

The int8 forward was traced adding whatever `desc+0x08` holds — the
instruction is unambiguous about that — and the decompiler named that slot
`_subias`. Implementing it that way measures **21.1× RMS / 102× peak**, against
**1.60× / 10.7×** for adding the trained `_bias` instead. That is not a margin,
it is thirteen times.

What is confirmed in the client is the *slot*, not which chunk the loader puts
in it, and the name came from the decompiler. Three independent measurements
point the same way:

- `_subias` has rms 1.8–3.0 where a trained bias has 0.06–0.11.
- It does not correlate with the row sums under any layout or sign convention
  tried, so it is not a pre-computed zero point waiting to be matched.
- Every variant including it measures worse.

The economical explanation is that the loader stores `_bias` at `desc+0x08` and
the decompiler's label is wrong — in which case the traced formula is right and
is exactly what is implemented here.

This is decidable by value rather than by name: the two chunks cannot be
confused. For `ft1` they begin `0.028390…` and `1.277565…` respectively, and
they sit 0x600 apart in the file. Reading either the pointer or the first float
settles it. Pending that, the measured variant stands.

## The `[87:93]` conflict

The published reference puts five long-term predictor coefficients at
`[87:92]` and a log gain at `[92]`. Tracing the client's extractor gives
something else:

| Offset | Reference | Traced in the client |
| --- | --- | --- |
| `[87:89]` | LTP coefficients | Two values copied straight through |
| `[89:92]` | LTP coefficients | Three `log10` of energies, each with its own affine step — measured as `+3.7`, `×0.769 + 1.923`, and `×0.286 + 0.343` |
| `[92]` | log gain | A single int16, copied raw |

The counts and the transforms both differ. **The implementation followed the
reference layout when this was written, so those six slots were wrong. It now
follows the traced one** -- `companion.c`, `build_subframe_features`. They are being fed
long-term predictor gains where the client computes logarithms of energies, and
nothing about that shows up as a crash, a NaN, or an out-of-range value — the
widths still add to 93 and the network still runs. This is precisely the silent
failure the audit was written to find.

Worth recording how it was nearly missed: the peer's original reading of these
eleven slots was "5 correlations, 2 parameters, 3 log10, 1 int16", which is
what the trace now confirms. I replaced it with the reference layout on the
strength of the widths matching, and told the peer his reading needed no
correction on a *different* point while quietly overriding it on this one.
Matching widths were never evidence about order or transform.

Pending the slot-by-slot re-confirmation before changing the code, since
getting this wrong twice costs more than waiting.

## Where the measurement stands

Filtering a real decode, output over input by RMS:

| | RMS | peak |
| --- | --- | --- |
| features invented, weights degenerate | ~1e14 | |
| int8 weights given the factor of 127 | ~1e14 | |
| signal on the int16 scale | 13.4 | |
| shaping driven by ft2 rather than ft1 | 2.24 | 20.5 |
| transforms run on the GRU state, not the upsampler | **1.60** | **10.7** |

Peak stays far above RMS, so what remains is concentrated in transients rather
than spread across the signal — consistent with the feature slots that describe
energy and pitch still being wrong.

The conditioning chain, as now confirmed in the client:

```
GRU state ──> af1          (and af4: both filters read the GRU directly)
          └─> ft1 ─> ft2 ─> shaping
af4 takes af1's signal and history, but not its conditioning
```

Note this is *not* the reference's chain, where each stage consumes the
transform the previous stage produced. Running it that way measures 2957. The
pruned model here wires its filters and its shaping differently, which is why
the chain had to be measured rather than inherited.

This is a sanity measure, not a fidelity one. A post-filter should leave the
level roughly alone, so a ratio far from 1 means something is wrong; a ratio
near 1 does not mean anything is right.

## The three energies -- CONTESTED, and the argument on both sides is void

This section was marked withdrawn in favour of a pitch-lag reading, and that
marking was itself wrong. Both readings rested on the same step, and a read of
the client's disassembly says the step does not exist.

**The lag reading's whole argument** (`companion.h`, `lag_context`) is that
after `x * 0.5 + 32` the lags span 32 to 192 where every energy in this codec
spans at most 38. It identifies by comparing spans *under that transform*.

**The disassembly gives the transform with no such step**, as
`(10 * log10(E) + offset) / divisor`:

| slot | read from the client | reduces to |
| --- | --- | --- |
| 89 | `(10 * log10(E) + 37) * 0.1` | `log10(E) + 3.7` |
| 90 | `(10 * log10(E) + 25) / 13` | `0.769 * log10(E) + 1.923` |
| 91 | `(10 * log10(E) + 12) / 35` | `0.286 * log10(E) + 0.343` |

The right-hand column is, to every digit, the affine step already measured and
recorded here, which is what makes the read credible on that code path: two
independent readings of the same instructions agreeing on four constants. It
also answers a question left open below -- the offset is **added, on the
output side of the `log10`**, positive.

So the argument that identified lags is void, and so is the search below that
identified `nrgres`, because it picked its candidate *for spreading best under
`x * 0.5 + 32`*. Neither reading is wrong because of this. Both are unsupported.

**Measured here, over the real decode, all four combinations:**

| source and transform | slot 89 | 90 | 91 | span of 89 | 89 against the clean spectrum |
| --- | --- | --- | --- | --- | --- |
| lag, with `x*0.5+32` (what the code does) | 5.21 | 3.08 | 0.77 | 0.78 | 87.6x |
| lag, `log10` direct | -5.30 | -5.00 | -2.23 | 11.51 | 89.2x |
| `nrgres`, with `x*0.5+32` | 5.21 | 3.08 | 0.77 | 0.35 | 87.6x |
| **`nrgres`, `log10` direct (the disassembly)** | **2.71** | **1.07** | **0.03** | **6.39** | **44.7x** |

Only the last row improves both things at once: the span widens eighteen-fold,
which is what resolves a network giving its largest weight norm to something
that never moves, and the contribution halves. Under the same transform the
lag source is worse than what the code does now. So source and transform move
together, and the coherent pair is the last row.

**Not acted on yet, and the reason is the standing rule rather than doubt.**
The disassembly is a measurement of the client, but it arrives second-hand and
it reverses an identification written into three files here. What would settle
it is one thing: whether the buffer it reads `E` from is the per-sub-frame
residual energy. Two of the three sources have never been identified at all.

**And there is a factor left over.** Even in the last row, slot 89 contributes
44.7x what the clean spectrum does, where three independently built slices of
the vector calibrate at 1.0x. If the client's `E` were energy *per sample*
rather than the sub-frame's sum, that is a division by 80: `log10` falls by
1.9, slot 89 lands near 0.81, and the contribution falls to about 13.6x. That
is where to look next, not a claim -- one line of the disassembly decides it,
and it is worth a factor of three on the most heavily weighted feature in the
model.

What follows is the original search, kept because its table of every
per-sub-frame quantity this codec produces is still the fastest way to test a
candidate -- but read it knowing that the column it decided on is the one now
in question.

Slots `[89:92]` each take an energy, scale and offset it by `x * 0.5 + 32`,
take its base-10 logarithm, and apply an affine step — `+3.7`, `x0.769+1.923`,
`x0.286+0.343` respectively. That shape is measured; the *sources* are not.

One is the residual energy. The other two are unidentified, and the search is
narrowed by two things:

- The scale-and-offset has to leave a positive argument for the logarithm. That
  rules out the codec's residual energy in its dB Q14 form, which runs to
  -1.4e6 and stays negative through the transform.
- The candidates have to vary comparably. The codebook gain measured
  `[0.00, 0.06]` against the residual energy's `[0.00, 77.68]` — it is
  numerical noise, so its logarithm would carry nothing.

Candidates tried, with what ruled each out:

Every per-sub-frame quantity in this codec has now been measured against the
transform. The column that decides is the last one: the scale-and-offset has to
spread the values out before the logarithm, and only one candidate does.

| candidate | range | after `x*0.5 + 32` |
| --- | --- | --- |
| residual energy `nrgres` | `[0, 77.7]` | **`[32.0, 70.8]`** — identified |
| same, in dB Q14 | `[-86, 0]` | `[-11.0, 32.0]` — negative, no logarithm |
| codebook gain | `[0, 0.06]` | `[32.0, 32.03]` |
| excitation before any gain | `[0, 0.056]` | `[32.0, 32.03]` |
| LPC residual after the codebook gain | `[0, 0.082]` | `[32.0, 32.04]` |
| synthesised signal | `[0, 3.31]` | `[32.0, 33.7]` |
| codebook indices | `[0, 66]`, `[0, 15]` | indices, not energies |

The pre-gain candidates were tried because the scale argument predicted they
would work, and they are the *worst* of the set — the excitation spans 0.03
after the transform where the identified energy spans 38.8.

The last two are the quantities the reverse engineering suggested, computed
per sub-frame from the decode with the codec's own energy function. They fail
the same test as the codebook gain: after `x * 0.5 + 32` they span 32 to 32.04
and 32 to 33.7, so their logarithms are nearly constant and the features would
carry almost nothing. The identified energy spans 32 to 70.8 over the same
material.

The useful constraint is one of **scale**: all three sources sit where the
identified one does, roughly 0 to 78.

An earlier reading of this note claimed that range "reads as decibels". It does
not, and the codec says so: `smpl_decode_resnrg` computes
`10^(0.1 * dB) * subframe_length`, so the identified quantity is a **linear**
energy, and the codec's own energy function sums squares without averaging, so
every candidate above is already on that normalisation.

What actually separates them is the signal each measures. Divided by the 80
samples of a sub-frame, the identified energy corresponds to an RMS near 1.0,
the synthesised signal to 0.2, and the LPC residual to 0.03. So the other two
sources measure something at **unit scale** — a normalised or pre-gain signal —
rather than the decoded audio. That is a sharper filter than "logarithmic",
and it is what the failed candidates have in common: they are all measured
after the gain is applied.

**The search of this codec is exhausted.** No per-sub-frame quantity it
produces, before or after gain, sits on the scale the transform needs except
the one already identified. Either the other two are derived rather than
decoded, or they come from somewhere this codec does not have — which fits the
unresolved discrepancy below.

That discrepancy is worth settling before anyone searches further. The reverse
engineering describes the client filling this buffer from a *SILK* decode,
while MLow decodes through SMPL. If the label is accurate, the quantities do
not exist in this codec and cross-referencing it was always going to fail. If
it is a decompiler's guess — the same kind that was wrong about the
dequantisation rule, the feature layout and `subias` — then they should be
here, and they are not.

## The three energies are not where the remaining error is

A sensitivity test settles this, and it should have been run before any of the
candidate hunting.

Feeding the three slots deliberately wrong values, including an absurd one:

| what the three slots get | RMS | peak |
| --- | --- | --- |
| all zero | 0.776 | 4.33 |
| pitch lags 4, 5 and 6 | 0.693 | 3.69 |
| a constant 1000 | 0.577 | **2.65** |

The absurd constant gives the *best* peak of the three, and zeroing them gives
the best RMS. Across every candidate tried the two metrics move in opposite
directions, and the whole range spans 0.58 to 0.78 and 2.65 to 4.33 — the slots
shift the balance between the two, they do not close either.

So identifying the two remaining sources will not bring the measurement to 1.
Whatever accounts for the peak sitting near 3 is elsewhere, and three of 165
features are not it. That reframes what is left: the sources are worth getting
right for fidelity, but they are not the outstanding defect.

Candidates for where it actually is: the analysis window is the last table
still taken from the reference rather than measured, and the inter-frame kernel
cross-fade was implemented from a description rather than a measurement.

A third candidate was ruled out by measurement. An earlier note here claimed
the test material runs the codec in low-rate mode, producing two sub-frames
replicated to four — inferred from a dump's size, and wrong. Instrumenting the
decoder to report the count directly gives **four sub-frames at both 16 and 32
kbps**, so they are four genuine ones. Their values sit close together because
the test signal is stationary, not because they are copies, which is also why
this material cannot distinguish per-sub-frame indexing.

## The two feature branches run at different rates

Measured in the client: the 64-band spectrum is computed for **every**
sub-frame, while the 18-band cepstrum is computed only on **even** ones and
repeated on odd ones. Two branches of the same vector, two rates.

Getting either wrong is a systematic error across the whole signal in opposite
directions — repeating the spectrum discards three quarters of what the
predictor says, recomputing the cepstrum invents detail the client does not
have. We had the cepstrum right and the spectrum repeated.

Correcting it moves the measurement by 0.3%, because the four predictors of a
stationary test signal are nearly identical. It is kept because it is what the
client does, not because it measures better — the same reason the pitch source
was kept when its offset was uncertain.

Also measured, and confirming what is implemented: the spectrum's transform
takes **no window**, and the cepstrum's is windowed with
`sin(pi*(n+0.5)/320)`. Both over 320 points.

## Where the remaining error is, and two hypotheses ruled on

Tracing each stage's peak over the whole signal puts the excess in one place:

```
input (int16 scale)    10983
af1 out                15720    1.43x — within the +-12 dB the gain allows
after adashape         58280    +3.7x — this is where it appears
af4 out                52011
final                  40659    3.70x of the input
```

So it is not the adaptive filters, the inter-frame cross-fade, or the way the
branches combine — all of those are well behaved. It is the time-domain
shaping. Inside it, the envelope branch dominates:

```
envelope        11.1
alpha1_f         6.4    features branch
alpha1_t        20.6    envelope branch, three times larger
alpha2          24.6    before the exponential
```

The asymmetry worth noticing: the adaptive filter's gain is bounded, passing
through `exp(1.38155 * tanh(.))` for a range of `[0.25, 3.98]`, while the
shaping applies a bare `exp`.

**Normalising the signal before the envelope — ruled out.** The envelope
subtracts its own mean and stores it separately, so normalising shifts every
bin by the same constant, leaves the deviations untouched, and moves only the
stored mean — by `log(32768)`. Testing it costs one subtraction, and it sends
the output to 1.6e18. The envelope belongs on the int16 scale.

**Bounding the exponential — helps, does not close, not applied.** Giving the
shaping the same limit the filter has: `±12 dB` gives 0.639 / 3.46 and `±6 dB`
gives 0.622 / 2.14, against 0.695 / 3.70 unbounded. The peak improves and the
level drifts further from 1, which is the signature of a wrong quantity rather
than a missing bound — and the reference has no bound here, so adding one would
be choosing by the number.

**Input pre-emphasis and output de-emphasis — ruled out.** The reference
filters the signal with `x[n] - 0.85 x[n-1]` before the network and undoes it
with `y[n] + 0.85 y[n-1]` after. The two cancel at DC, but the network in
between sees a different signal either way, so it is not cosmetic. Applying
both gives 1.70 / 5.93 against 0.695 / 3.70 without — worse on both metrics,
and worse in the opposite direction on level. This build does not use them,
which had been recorded as an inference and is now a measurement.

**Re-run under the quality oracle and the fixed predictor feed**, because the
figures above are from the level-ratio era and this file's own rule retires a
refutation measured under a dominant defect. It holds: `-15.35 dB` with
pre-emphasis against `-12.77` without.

**And the rule applies to this re-run too.** It was made while the
conditioning is still an order of magnitude too strong, and under a defect that
large almost any change to the signal measures worse. The refutation stands for
now and has to be tried once more when the conditioning is right.

Also confirmed against the reference and already correct here: the shaping
operates on the *second* of the two channels the filter fans out to, not on
both and not on the first.

**The whole shaping formula has since been measured in the client, and this
implementation already matched it** — the envelope's pooling, epsilon, natural
log, mean subtraction and appended mean; the paired-frame context on all three
dense layers (320, 42 and 160 wide); the leaky ReLU at 0.2; no activation on
`alpha2`; and a bare per-sample `exp`. Nothing diverged.

The peak `alpha2` of 24.6 quoted above is a global maximum on a near-silent
sample, not a typical one. Over ordinary frames it sits at 5 to 8 and the
shaping's net effect is the 3.7x seen in the chain, which corresponds to a
typical `alpha2` of `ln(3.7) ≈ 1.3`.

### The target has now been measured, and the output is wrong

A capture of the client's final post-filter PCM settles it. Over a known
stretch — a clean decoded sinusoid — the client's output has a **peak-to-RMS
ratio of 1.414**, which is exactly what a pure tone has. Its post-filter does
not distort.

Feeding a pure tone through this implementation gives **13.19**. So the output
is not merely different, it is distorted, and the earlier reasoning that "3.7x
might be legitimate" was wrong — a ratio near 1 was the wrong thing to chase,
but so was accepting the level as possibly fine.

Tracing the crest factor stage by stage puts it in one place:

| stage | peak | crest |
| --- | --- | --- |
| input block | 7299 | 1.461 |
| filter output, channel 0 | 8122 | 1.573 |
| filter output, channel 1 | 9966 | 1.512 |
| **after shaping** | 32903 | **5.562** |
| after the collapsing filter | 12770 | 2.075 |

The adaptive filters keep the tone clean. The shaping turns a crest of 1.5 into
5.6, and the reason is visible in the gain it applies: within a single
80-sample sub-frame it ranges from **0.0005 to 8.1, a spread of about 9000x**.
A gain swinging that far between neighbouring samples wrecks any signal.

Two things tested and rejected as the cause: smoothing the gain across samples
makes it worse (16.1), and the inter-frame cross-fade makes no difference at
all. Removing the shaping entirely gives 6.5, so it accounts for about half of
the excess and the rest is upstream of it.

So `alpha2` genuinely varies that much here, which means its input does —
and every stage of the shaping formula has been checked against the client and
matches. The defect is in what reaches it, not in what it does.

Both branches feeding it are equally spiky, which rules out a single culprit:

```
alpha1_f   span 8.9 to 10.5 across the 80 outputs
alpha1_t   span 12.0 to 13.5
```

Neither is smooth, so this is not one branch misconfigured — something common
to both, or something about their shared input scale.

A missing normalisation was the obvious candidate for a shared factor of ten,
and it does not hold. Every form tried falls far short of 1.414:

| variant | crest |
| --- | --- |
| unchanged | 13.19 |
| RMS-normalise `h` | 9.10 |
| RMS-normalise `alpha2` | 9.55 |
| layer-normalise `h` | 12.20 |
| mean-centre `alpha2` | 16.86 |
| **`alpha2` forced to zero — no shaping at all** | **6.51** |

The last row is the important one: with the shaping's gain fixed at 1, the
output is *still* at 6.51 against a target of 1.414. So the shaping accounts
for roughly half the distortion and the rest is already present in what reaches
it — no amount of correcting the shaping alone can fix this.

The cross-fade is correct and was verified by sweeping it. An earlier test
that appeared to show it made no difference was wrong — the expression used to
disable it evaluated to an overlap of 1, not 0:

| cross-fade length | crest |
| --- | --- |
| 0, disabled | 18.20 |
| **15, as implemented** | **13.19** |
| 30 | 19.35 |
| 79 | 21.84 |

Fifteen is a minimum, so both the length and the raised-cosine window are
doing their job. Worth knowing why it matters: the predicted kernel changes by
**34% to 412% of its own magnitude** between neighbouring sub-frames, so the
blend is carrying a lot.

Two more measured while looking for what inflates the predicted kernel, both
coming back normal. The filter's gains stay inside the ±12 dB the constant
allows, at 0.25 to 1.2, varying about fivefold between sub-frames — which is
what accounts for the kernel's apparent 412% change, since the kernel is
L2-normalised and the gain is folded into it afterwards. Two unit vectors
cannot differ by more than 200%, so the excess is level, not direction.

And normalising the signal that feeds the cepstrum — the one feature whose
range, ±27, dwarfs every other, which sit within ±2 — moves the result from
13.19 to 12.50. Marginal, so the cepstrum's scale is not the inflation either.

Treating the history as the previous convolution's tail — filtering
pre-block samples with the old kernel rather than the new one, which is what
overlap-add would do — measures 19.49, worse than the 13.19 of overlap-save.

Two further things measured and ruled out. The filter's gain varies only 1.3x
between sub-frames, so it is not level jumps at boundaries. And the offending
samples are not at sub-frame edges: of those above five times the RMS, 11% fall
in the sixteen edge positions where chance alone would put 20%. The distortion
is spread through the signal, affecting about 1.7% of samples, not concentrated
at seams. Note the two have
different characters: `alpha1_f` is int8 and takes a tanh output bounded to
±1, while `alpha1_t` is float32 and takes the envelope, whose stored mean sits
around 5 on the int16 scale. A spread of 10 across the outputs of both, from
such different inputs, points at the inputs rather than the weights.

### An earlier note: the target was assumed before it was measured

Worth stating plainly, because a lot of work was aimed at it: **nobody has
established that the ratio should be near 1.** That was my assumption about
what a post-filter ought to do, and it propagated — including into what the
reverse engineering was asked to look for.

An enhancement network may legitimately raise peaks; reconstructing what a low
bitrate discarded is the entire purpose. Of the hypotheses tested above, only
the two that moved by orders of magnitude are conclusive. The rest moved
against an imagined target and prove nothing either way.

What settles it is an (input, output) pair from the client: one decoded frame
and the same frame after its post-filter, or even just the peak-to-RMS ratio
the client produces over known material. Until then, "3.7x" is a measurement
without a reference, and the implementation matches the measured formula at
every stage that can be checked.

## The property suite now fails against a real container, on purpose

`companion_test.c`'s level check fails with `COMPANION_MODEL` set, at a ratio
of 5.8e5 against a bound of 50. That failure is the open defect above, not a
regression, and the bound is left where a working filter belongs.

It used to pass, and the reason it did is worth keeping. The test fed its
signal on the int16 scale, citing the contract in `companion.h` — the same
contract that turned out to be a deduction from the symptom rather than a
measurement. Feeding int16 shifts the shaping's envelope logarithm by
`ln(32768)`, which is exactly the shift that makes the level look reasonable.
So a wrong contract and a test written to match it hid the defect from the one
check that would have caught it.

Without `COMPANION_MODEL` the suite passes, and nothing in CI sets it.

## The float layers have no oracle, and one of them is implicated

The `subias` trick settles the int8 layers and cannot say anything about the
float ones, because only int8 layers carry a `subias`. Six layers are float —
`pitch_embedding`, `conv1`, `af1_gain`, `af4_gain`, `tdshape1_alpha1_t` and
`tdshape1_alpha2` — and their storage order has never been checked against
anything.

Measurement puts the remaining error squarely in one of them. Switching off the
shaping's envelope branch entirely, on speech:

| | p50 gain | p90 gain | level ratio |
| --- | --- | --- | --- |
| `alpha1_f` alone (int8, layout fixed) | 0.38 | 2.48 | **3.75** |
| both branches (current) | 12.2 | 3.3e3 | 2.8e17 |

So the int8 half of the shaping is sane and produces post-filter-like gains.
The envelope branch is what takes the level to 1e17 — even though every
constant feeding it is now confirmed against the client (`|sig|`, pool 4,
floor `2^-16`, raw mean, no output scale). Its weights are the one thing about
it that nothing has checked.

Reading `alpha1_t`'s weights as `[out][in]` rather than `[in][out]` moves the
level ratio from 2.8e17 to **2.82** — seventeen orders of magnitude.

### The kernel-2 window order and the mean's slot are both already right

Two more candidates eliminated from the model itself, without the binary.

**Window order.** A trained causal conv1d weights the *current* step more than
the previous one, so whichever half carries more weight energy is the current
one. All five kernel-2 layers agree, and not marginally:

| layer | 1st half rms | 2nd half rms | ratio |
| --- | --- | --- | --- |
| `ft1` | 0.966 | 1.521 | 1.58 |
| `ft2` | 1.313 | 1.762 | 1.34 |
| `alpha1_f` | 0.498 | 0.842 | 1.69 |
| `alpha1_t` | 0.506 | 1.770 | 3.50 |
| `alpha2` | 0.501 | 1.628 | 3.25 |

Second half dominates in all five, so the window is `[previous || current]`,
which is what this code builds.

**The mean's slot.** The mean is on a different scale from the deviations
(-5.18 against rms 0.64), so a trained layer compensates with a distinctly
different weight there. In `alpha1_t` the deviations sit at 0.037 to 0.060
while slot 20 is 0.134 and slot 41 is 0.329 — 1.08x and 2.65x the layer
average. Both stand out from their neighbours, and the later one weighs more,
as the window order predicts. That is where this code puts the mean.

### An observation, held as an observation

The envelope is computed over what the shaping multiplies — `af1`'s second
channel — which is about 9.7x smaller than the Companion's input. In logs that
is 2.27, and the offset being hunted in the pre-exponential is 2.50.

The two are close and that may mean nothing: the mean passes through a weight
column before reaching the exponential, so a direct correspondence would need
that column's effective weight to be near 1. It is recorded because it is
cheap to check in the binary — **is the client's envelope computed over the
same buffer it multiplies, or over the Companion's input?** The reference
computes it over the signal it shapes; the client may not.

Eight numerical coincidences in this session have looked like answers and been
wrong, so this is written down rather than acted on.

**Tested by prediction, and it does not close it.** The path from the mean to
the exponential is linear apart from the leaky ReLU, so the effect is
computable from the weights alone:

    d(pre_exp[o]) = d(mu) * sum_j w_a1t[41][j] * w_a2[j + shape][o]

That gain averages **-0.989** — near enough to -1 that the coincidence above
had the mechanism it needed. Predicted result of running the envelope over the
Companion's input instead: the pre-exponential's median moves from 2.500 to
**+0.255**, a gain of 1.29.

Measured: **+1.206**, a gain of 3.34. The fall is 0.58 of the predicted one.

That lands inside the 0.2-to-1 band allowed for the leaky ReLU, which means
the prediction was **too weak to falsify** rather than confirmed — a band that
wide cannot distinguish a real mechanism from a partial coincidence. Stated as
a lesson about the method, not only about this hypothesis.

Storing the pre-ReLU activation as the shaping's "previous" step, rather than
the post-ReLU one this code and the reference both store, was tried for the
same reason: it is the same class of error as the tap order. Median 2.500 to
1.916. Another partial move that does not fix it.

That is now the pattern worth naming. Every single candidate tried moves the
median part of the way and none arrives: the envelope's source gives -1.29,
the pre-ReLU store -0.58, the leaky ReLU's removal -0.54, and 2.5 is needed.
Adding unvalidated corrections together until they reach the target is exactly
how a wrong answer gets built, so they are recorded separately and none is
applied.

What the measurement does say is firmer: changing the envelope's source moves
the median the right way and **does not fix it**. The gain is still 3.34 where
a post-filter wants 1, and the largest value entering `exp` gets slightly
worse, 58.4 against 56.8. So even if the client's two pointers turn out to
differ, that difference is not the whole defect.

### Balancing the features does not move the exponent's spread

Tested directly: normalising every feature slice to rms 1 before any layer —
which is the strongest form of the "the client balances its features and this
does not" hypothesis — leaves the exponent essentially unchanged.

| | p1 | p50 | p100 |
| --- | --- | --- | --- |
| as built | -3.857 | **1.724** | 57.020 |
| every slice at rms 1 | -4.921 | **1.723** | 57.613 |

The median is identical to three decimals and the tail is slightly worse. So
the spread does not come from the features being out of proportion with each
other, however much the cepstrum dominates the vector. Whatever produces it
survives the features being made uniform, which points at the layers rather
than their input.

Worth recording how this nearly went wrong: the first attempt patched an
anchor that did not match, the build silently reused the previous binary, and
both columns came back byte-identical — which reads exactly like "balancing
changes nothing". The same failure mode appeared earlier in this work. Any
before/after where the two sides match perfectly should be suspected of not
having run.

### Fixed: the LPC envelope is the reciprocal of the *squared* magnitude

Read from the client at instruction level, and applied. The envelope is
`1 / ((|A| * 320)^2 + 1e-9)`, not `1 / (|A| + 1e-9)`, so the log that follows
carries twice what this code produced. The feature is effectively
`-0.6 * log|A|`.

The `320` does not transfer. The client's transform divides by the size and
multiplies it back; `companion_mag_spectrum` here is unnormalised to begin
with, so applying it as well would be a factor of the transform size too much
— which the comment in that function already warned about, and which a first
attempt walked straight into.

The numbers settle which reading is right, and this is the strongest
cross-validation in this document: squaring alone takes the feature's rms from
0.191 to **0.3827**, against **0.38** predicted independently from the client.
Squaring *and* scaling gives 3.68, an order out.

Two other constants in the same path were confirmed unchanged: the `0.3` on
the log **is** in the client, so it was never a missing factor, and the epsilon
is `1e-9` at both points rather than `2^-16`.

Effect on the open defect, measured on speech: the exponent's median falls from
2.500 to 1.724, the level ratio from 2.8e17 to 1.6e17, and crest rises from 98
to 109. Applied anyway, on the same basis as the weight layout and the tap
order — a correction read from the client stands on its own, and a metric
moving the wrong way means the remaining defect was partly compensating for
this one.

It also retires the twenty-to-one disproportion as a target in its own right:
the client applies the `0.3` to the LPC bands and not to the cepstrum, so a
gap between them is partly by design.

### Two features are out of scale with each other, by twenty to one

Following the spread upstream, measured over 195 frames of speech through
`companion_last_features`:

| slice | values | rms | share of energy |
| --- | --- | --- | --- |
| clean spectrum | 64 (39%) | **0.191** | 0.7% |
| **cepstrum** | 18 (11%) | **3.815** | **79.3%** |
| acorr | 5 | 0.514 | 0.4% |
| ltp | 5 | 2.727 | 11.3% |
| log gain | 1 | 0.000 | 0.0% |
| pitch embedding | 64 | 0.608 | 7.2% |
| numbits | 8 | 0.699 | 1.2% |

Eleven per cent of the values carry seventy-nine per cent of the energy, while
thirty-nine per cent carry under one. A trained network is normally fed
features of comparable scale, and a twenty-to-one ratio between two of them is
what would inflate everything downstream — which is where the exponent's
spread comes from, if it comes from the features at all.

This is a measurement of disproportion, not of error: nothing here says which
of the two is wrong, or that either is. But it lands on an item this document
already flagged. The clean spectrum's `0.3 * log` is listed in the table above
as coming from the **reference**, with "look for the reciprocal and the `0.3`
in the client's extractor" as the thing to check — and it has never been
checked. Dropping that factor would make the clean spectrum 3.33x larger, rms
0.19 to 0.64: not the whole twenty-to-one, but the right direction on the one
constant in this path known to be unvalidated.

That is the shape of an inferred value that was never confirmed finally
showing up in a measurement, which is what this document exists to catch. The cepstrum's own scaling was
measured in the client and is not in doubt (`1/sqrt(2)` on `c0`, global
`sqrt(2/18)`); what is not established is the scale of the log-magnitudes it
transforms, or of the LPC spectrum beside it. Both are worth one reading of
the binary.

An earlier round normalised the cepstrum and found it moved crest from 13.19
to 12.50 — marginal, and taken as evidence against. That test predates the
weight-layout fix, so it was run on a network whose int8 layers were
permuted, and it should not be treated as settled.

### Re-measured with the codec's real state, and a hole that remains

The first version of the feature breakdown above used **fixed** lag, gain and
bit-count, which makes exactly the slices that depend on them artificial. Redone
with everything read from the dumps, as the main harness does:

| slice | rms | share |
| --- | --- | --- |
| clean spectrum | 0.360 | 2.4% |
| cepstrum | 3.815 | 74.7% |
| acorr | 0.452 | 0.3% |
| ltp | 2.735 | 10.7% |
| log gain | **0.000** | 0.0% |
| pitch embedding | 0.769 | 10.8% |
| numbits | 0.726 | 1.2% |

`c0` is 61.4% of the whole rather than the 65% quoted from the fixed-state run.
The conclusions above survive, but the earlier numbers were measured on partly
invented input and are superseded by these.

**The hole that remains** is the `log gain` at slot 92. The client puts a raw
int16 there, measured; every harness here puts zero, because that value is not
in the dumps. So one of the seven feature groups has never been exercised by
any measurement in this document, and nothing here can say what the network
does when it is present. It does not explain the level being too high — feeding
zero should excite the network less, not more — but it is a real difference
between these measurements and the client that no amount of care elsewhere
compensates for.

Measured across plausible values rather than left as an unknown: feeding 0, 1,
5, 20 and 100 into that slot gives level ratios of 1.6e17, 8.9e16, 7.6e15,
8.7e18 and 1.4e15 — three orders of variation, non-monotonic, and none within
fifteen orders of the target. So the hole matters for measuring cleanly and is
not the defect. Knowing the client's value would close a gap in the harness; it
would not close this one.

Separately: the `log gain` slot reads 0 in every harness here, because it is
fed from a codec value the dumps do not carry. That feature has therefore
never been exercised by any measurement in this document.

### A `tanh` before the shaping's exponential: refuted by the binary

**Refuted.** The client's `alpha2` activation is **linear**, read at
instruction level: the activation is not in the layer descriptor but the sixth
argument of the dense call, and all four `tdshape` calls pass `0`. Between the
dense and the multiply there is no `tanh`, clamp or span — the exponential
takes the dense output raw. The asymmetry against the adaptive filters, which
do bound their gain, is real and deliberate.

So the seventeen orders were curve-fitting, and the 44.5% saturation measured
below is why that was suspected before the byte arrived rather than after. The
unbounded `exp` works in the client because its `alpha2` stays around O(1);
this build's reaches 40, which is a scale problem upstream and not a missing
activation.

One caveat recorded rather than assumed: that byte comes from the desktop
binary. If the target for parity is a different build, its activation could
differ — though the Opus reference and everything else measured agrees with
linear.

### The GRU's gate order: confirmed correct as built

Found while the byte was being read, and now the strongest live candidate.

This code reads the GRU's three weight blocks as **update, reset, candidate**.
PyTorch's `nn.GRU` stores them as **reset, update, candidate** — the first two
swapped. The provenance table in this document does not list the gate order at
all: it was never recorded, so it was never validated.

**Settled against the client: `[z,r,n]` as built is right.** The first third
of the weight block feeds the update sigmoid, the second the reset, the third
the candidate. PyTorch's `nn.GRU` does store them `[r,z,n]`, but the `.pte`
itself is laid out `[z,r,n]`, so reading it straight — which is what this code
does — is correct.

So the nine orders of magnitude below were curve-fitting, and the fourth line
of evidence, that `rzn` made the network's internal regime worse, was the one
that pointed the right way. Three arguments favoured `rzn` and the binary went
against all three. That is the whole case for not applying on argument count or
improvement size.

Measured on speech:

| gate order | exponent p50 | level ratio | crest |
| --- | --- | --- | --- |
| `z,r,n` (as built) | 1.724 | 1.6e17 | 109.1 |
| `r,z,n` (PyTorch's) | -3.585 | **1.2e8** | 125.1 |

Nine orders of magnitude. It does not close the gap either — it overshoots,
taking the median gain to 0.028 where 1 is wanted — so it is **not applied**,
and a movement this large in the wrong final position is as likely to mean two
errors interacting as one error fixed.

All six permutations of the three blocks were then measured, to separate "the
right one" from "one that happens to fit":

| order | exponent p50 | level ratio |
| --- | --- | --- |
| `zrn` (as built) | 1.724 | 1.6e17 |
| **`rzn` (PyTorch's)** | -3.585 | **1.2e8** |
| `znr` | 2.185 | 2.9e21 |
| `nzr` | 0.061 | 1.6e12 |
| `rnz` | 0.336 | 4.7e15 |
| `nrz` | 1.229 | 3.5e11 |

`rzn` is the best by more than three orders of magnitude over the next one, and
it is the only one with a mechanism behind it. Had several landed close
together the result would mean little; one winning by that margin, and it being
the convention a PyTorch export produces, is a different kind of evidence.

Worth noting what the table also shows: `nzr` puts the median at 0.061, nearly
dead on, and still leaves a ratio of 1.6e12. Median and level do not track each
other, because the level is driven by the spread. Any future candidate has to
be judged on both.

And there is an internal-consistency argument that does not depend on the
binary at all. A GRU's semantics differ between implementations in three
places, and this code follows PyTorch in two of them:

| | this code | PyTorch `nn.GRU` |
| --- | --- | --- |
| reset gates the recurrent projection, `r * (W_hn h)` | yes | yes |
| convex update `z*h + (1-z)*n` | yes | yes |
| **block order** | **update first** | **reset first** |

The first two are exactly the points where PyTorch differs from other common
formulations — and the comment beside the candidate line, "reset gates the
recurrent projection, not the hidden state before it", shows that whoever
wrote it knew that distinction. So the implementation adopts PyTorch's
convention wherever it was thinking about the maths, and contradicts it in the
one place that is a pure storage detail nobody wrote down.

That is the shape of a real mistake rather than a coincidence: the formula was
taken from one source and the layout assumed from another.

**A fourth line of evidence, and it points the other way.** If `rzn` were the
right order, the network should run in a healthier regime under it, not a worse
one. Measured on speech, independently of the output level:

| order | GRU hidden | ft1 | ft2 |
| --- | --- | --- | --- |
| `zrn` (as built) | 0.592 / 6.3% at the rails | 0.742 / 11.9% | 0.744 / 11.3% |
| `rzn` | 0.714 / **14.4%** | 0.800 / **20.0%** | 0.784 / **16.3%** |

Under `rzn` the activations run hotter and saturate more than twice as often.
A trained network does not sit at 14 to 20% at the rails. So the level improves
by nine orders while the internal regime degrades, which is a genuine conflict
and not a detail: a correct gate order should not make the network less
healthy.

Three arguments favour `rzn` — the margin over other permutations, the PyTorch
export convention, the internal consistency of the rest of the GRU — and this
fourth opposes it. That is precisely the situation where the binary decides and
neither the count of arguments nor the size of the improvement should.

Worth noting that both orders are worse here than the 1.9/3.8/5.6% recorded
earlier: those predate the `1/|A|^2` fix, which is confirmed correct and made
saturation worse. Another instance of a correction exposing what it was partly
compensating for.

But unlike every other large movement in this document, this one has a
mechanism behind it: two conventions exist, the model was probably exported
from one of them, and nothing here ever checked which. That makes it the
question to settle next.



The largest single movement measured in this work, and it is a hypothesis
awaiting confirmation, not a finding.

The adaptive filters bound their gain as `exp(span * tanh(.))`, which is why
they never run away. The shaping's exponential is unbounded here, and in the
Opus reference, where all three of its denses use `ACTIVATION_LINEAR`. But the
client is a *pruned and modified* NoLACE, and it uses `tanh` on backbone layers
generally. If its `alpha2` does too, the exponent is bounded by construction.

Measured on speech:

| | level ratio | crest |
| --- | --- | --- |
| linear, as built and as the reference | 1.6e17 | 109.1 |
| `exp(tanh(x))` | **0.603** | **25.7** |
| `exp(1.3815 * tanh(x))` | 0.714 | 30.9 |
| `exp(2 * tanh(x))` | 1.167 | 33.8 |

Seventeen orders of magnitude, and crest from 109 to 26 against an input of
5.0. Nothing else tried here comes close.

**And it would not be the whole story even if confirmed.** With the
pre-activation this code produces, **44.5%** of the values would saturate that
`tanh` — p90 is 7.15, where `tanh` reaches 1.0000 to four figures. A trained
layer ending in `tanh` does not run with half its outputs at the rails; the
other `tanh` layers here sit at 2 to 6% once the weight layout was fixed.

So a `tanh` at `alpha2` would *bound* the damage rather than remove it, and
the gain would come out bimodal — 0.37 or 2.72 — instead of varying smoothly.
For saturation to look like the rest of the network, the pre-activation would
still need to come down by about a factor of three. That is much less than the
twelve the unbounded version needs, but it is not nothing, and it means this
hypothesis being confirmed would leave a second, smaller defect underneath —
the same one-error-masking-another pattern that this work has already hit
twice.

It is **not applied**, for the reason everything else in this document was not:
a number that large is exactly when to be most careful. What would settle it is
one reading — **is the client's `alpha2` dense activation linear, or `tanh`?**
The circumstantial case is strong (every other layer measured in the client
uses `tanh`; the adaptive filters bound their gains the same way), and the
reference's own choice of linear is not evidence about a model that was pruned
away from it.

Also checked while looking for a global scale: the container holds 48 chunks
and **every one is consumed** by this loader. There is no unused scale tensor
hiding in it, so any missing global factor would have to live in the client's
code rather than its weights.

### The cepstrum's DC term is two thirds of everything the network sees

Decomposed coefficient by coefficient over 195 frames of speech:

| coefficient | rms | share of cepstrum energy |
| --- | --- | --- |
| **c0** | **14.675** | **82.2%** |
| c1 | 6.206 | 14.7% |
| c2 | 2.047 | 1.6% |
| c3 and beyond | below 1.3 | under 1% |

The cepstrum is 79% of the feature vector's energy and `c0` is 82% of the
cepstrum, so **`c0` alone is about 65% of everything entering the network**.

`c0` is the DCT's DC term: the mean of the log-magnitudes, which is the
signal's **absolute level**. So the dominant feature driving this network is
not spectral shape at all — it is loudness, and everything downstream inherits
its scale.

That is a specific and checkable thing to be wrong. The DCT's own constants are
confirmed in the client, and so is the filterbank's magnitude sum, so what is
left is whether the signal reaching the cepstrum is normalised first. If the
client divides by a frame gain or energy before transforming, its `c0` would be
small and its features would be dominated by shape rather than level — which is
what a post-filter conditioned on spectral detail ought to look like.

**Settled against the client.** It does not normalise the signal by energy
before the cepstrum, and it does not discard `c0` — all eighteen coefficients
are used. The dominance is by design, and this build's magnitude sum matches:
`companion_mag_spectrum` returns `sqrt(re^2 + im^2)` and the filterbank
accumulates it linearly, with no squaring anywhere. Had it squared, `c0` would
have come out at exactly twice the client's, which would have been the fault —
it does not.

So `c0`, the gate order and the absence of normalisation are all confirmed
correct here, and the hot activations come from somewhere else entirely.

**Tested, and the network wants that term.** Zeroing `c0` after the DCT makes
the level ratio worse, 1.6e17 to 7.9e17, and leaves the GRU's saturation
untouched at 6.3%. Normalising the windowed signal before the transform — the
other way to remove the level — is worse still at 8.1e22. So the imbalance is
not simply a feature that should not be there.

The weights say the same thing more precisely. Weighting each feature group by
what `conv1` actually does with it:

| group | weight rms | feature rms | product |
| --- | --- | --- | --- |
| clean spectrum | 0.140 | 0.383 | 0.054 |
| **cepstrum c0** | **0.060** | 14.675 | **0.885** |
| cepstrum c1+ | 0.121 | 1.600 | 0.193 |
| acorr | 0.257 | 0.514 | 0.132 |
| ltp | 0.256 | 2.727 | 0.698 |
| pitch embedding | 0.051 | 0.608 | 0.031 |
| numbits | 0.093 | 0.699 | 0.065 |

`conv1` gives `c0` the second-smallest weights of any group, so the network
*does* compensate for receiving it large — it was trained on features with this
shape. But it compensates only partly: `c0`'s effective contribution is still
sixteen times the clean spectrum's.

So the hypothesis that `c0` is spurious is withdrawn. What the numbers leave
open is narrower and quantitative: `c0` measures rms 14.675 here, and for its
contribution to sit among the others it would need to be around 3.3 — a factor
of four. Since `c0` is a mean of logs, a factor there is an *additive* constant
on every log-magnitude, which is what a different transform normalisation
produces. That is a question with a number attached: what is `c0`'s magnitude
in the client?

**Measured across candidate transform scales**, since the client's cepstrum
path also carries a `x320`:

| scale on the magnitudes | c0 rms | level ratio | crest | GRU at rails |
| --- | --- | --- | --- | --- |
| x1 (as built) | 14.675 | 1.6e17 | 109.1 | 6.3% |
| x sqrt(320) | 5.947 | 3.6e16 | 122.5 | 5.0% |
| **x320** | 12.444 | **7.0e20** | 159.5 | 9.4% |

Applying the client's `x320` makes everything worse, which is the same result
the clean spectrum gave: the factor belongs to a normalised transform and does
not transfer to an unnormalised one.

**And a flaw in the reasoning above, recorded rather than quietly dropped.**
The target of "c0 should be around 3.3" came from assuming every feature group
ought to contribute equally through `conv1`, which is an assumption and not a
measurement. Worse, `c0` is a mean of logs and the current mean is negative, so
its magnitude passes through **zero** near a scale of 31.8 and grows again
beyond it — "make c0 smaller" is not a well-formed goal at all. Zeroing it was
measured earlier and is worse. What matters is c0 being *right*, which only the
client can say, and none of the scales tried here is obviously it.


Nothing here establishes that it does. But a single feature carrying two
thirds of the input energy, and that feature being a loudness term, is the kind
of imbalance a trained network would not normally be given.

### No single feature carries the factor, and the directions conflict

Scaling each slice on its own, against 1.724 unchanged:

| slice | x0.5 | x2.0 |
| --- | --- | --- |
| clean spectrum | 2.502 | **1.382** |
| cepstrum | **1.151** | 2.322 |
| acorr | 1.504 | 2.111 |
| ltp | 2.542 | 2.618 |
| pitch embedding | 2.235 | 2.388 |
| numbits | 1.622 | 2.322 |

None of them reaches a gain near 1 on its own — the best is the cepstrum at
1.151, where the target is 0. So the factor is not hiding in one feature, and
the global scale of 0.5 that does close it works through the combination.

The two useful slices pull in **opposite** directions: the clean spectrum
improves by growing, the cepstrum by shrinking. That matters for what to look
for, because the obvious hypothesis — the cepstrum's filterbank summing power
rather than magnitude, mirroring the `|A|^2` just confirmed for the clean
spectrum — would make the cepstrum *larger*, which measures worse here, not
better.

And growing the clean spectrum further has no mechanism left: its `0.3` and
its `|A|^2` are both confirmed in the client, and doubling the feature would
mean either `0.6` or `|A|^4`. So the direction that helps is the one with
nothing behind it.

This also resolves an apparent conflict between two tests here. Balancing every
slice to rms 1 lowers the global feature rms from 1.43 to 1.0 and changes
nothing, while a uniform 0.7 moves the exponent from 1.724 to 0.815. There is
no contradiction: balancing raises the slices whose growth helps and lowers the
ones whose reduction hurts, so its effects cancel. The response to a uniform
scale is smooth and monotonic — 0.9 gives 1.452, 0.8 gives 1.147, 0.7 gives
0.815, 0.6 gives 0.453, 0.5 gives 0.107 — and the non-monotonic look of an
earlier table came from sampling it only below 0.5, where the `tanh` layers
leave saturation and the network changes regime.

### The gap is a factor of two in the features, not twelve in the exponent

Three measurements together, and they narrow the search a great deal.

**No weight is out of scale.** Against the `1/sqrt(n_in)` a well-scaled layer
would use: `conv1` 1.28x, `alpha1_f` 1.50x, `alpha1_t` 0.94x, `alpha2` 1.70x,
`ft1` 1.97x, `ft2` 2.39x. Nothing is orders out.

**No layer amplifies anomalously.** Median over 800 sub-frames of speech,
against `sqrt(n_in) * rms_w * rms_in`, which is what independent inputs would
give:

| dense | in | out | predicted | measured/predicted |
| --- | --- | --- | --- | --- |
| `alpha1_f` | 0.746 | 1.414 | 1.032 | 1.37 |
| `alpha1_t` | 1.329 | 1.982 | 1.253 | 1.58 |
| `alpha2` | 1.354 | 3.452 | 2.305 | 1.50 |

All three sit at 1.4 to 1.6, which is what correlated inputs give. The two
branches are also comparable — an earlier note that the envelope branch's input
was 5.7x the feature branch's was read off the first trace lines, which are the
startup transient, and is withdrawn.

**But scaling the features alone closes it.** Multiplying every feature by a
constant before any layer:

| feature scale | exponent p50 | median gain |
| --- | --- | --- |
| 1.0 | 1.724 | 5.61 |
| **0.5** | 0.107 | **1.11** |
| 0.2 | 0.354 | 1.42 |
| 0.1 | 0.260 | 1.30 |
| 0.03 | -0.104 | 0.90 |

So the exponent needs to come down by a factor of twelve, but the *features*
only need a factor of about two — the chain multiplies the rest. The response
is not monotonic, because the `tanh` layers saturate, which is why the middle
of that table wanders.

That is a much smaller target, and it is the size of error this work has
already found twice: `1/|A|` against `1/|A|^2` was exactly a factor of two.
The scale is *not* a correction to apply — it is a sensitivity measurement,
and picking 0.5 because it lands on 1.11 would be curve-fitting. What it says
is where to look: one more factor-of-two in how a feature is computed, most
plausibly in the cepstrum, which carries 79% of the feature energy.

### The defect is the exponent's spread, not its offset

This reframes what to look for, and it retires the hunt for a bias.

Centring the shaping's exponent per sub-frame — which zeroes the level error
by construction — takes the level ratio from 2.8e17 to 3.0e13 and makes crest
*worse*, 98 to 132. An offset cannot be the fault if removing it entirely
leaves thirteen orders of magnitude.

What is left is the spread. The exponent runs from -3.6 at p1 to +19.1 at p99,
so its standard deviation is about 4.9. For a roughly normal `x`, the rms of
`e^x` is inflated by `e^(sigma^2/2)` regardless of the mean:

| sigma | inflation of rms |
| --- | --- |
| 4.89 (measured) | 1.5e5 |
| 2.0 | 7.4 |
| 1.0 | 1.65 |
| 0.5 | 1.13 |
| 0.3 | 1.05 |

So the measured spread alone accounts for the centred test's 3.0e13, and a
working filter needs sigma near 0.3 to 0.5 — a factor of ten to sixteen
smaller than what this produces.

That also rules out `exp2` by arithmetic rather than measurement, which was
worth checking because it was the only closed form fitting the offset: using
base 2 takes the median gain from 12.2 to 5.66, not to 1. For the median gain
to be 1 the exponent must be 0, in any base — and the exponent's *offset* is
not the problem anyway.

**What to look for instead:** anything that scales the activations feeding
`alpha2` down by roughly an order of magnitude. `alpha2` sees an input of rms
1.43 through weights of rms 0.135 over 160 taps, which is what produces an
exponent of this width; the input would need rms near 0.18. Its two sources
are `alpha1_f` and `alpha1_t`, whose spreads were each checked and found
consistent with their own weights and inputs — so the excess is inherited from
further upstream, where the `tanh` activations still run at rms 0.47 to 0.66.

### Both persistent contexts are correct, checked value by value

The last structural candidate was that one of the shaping's two cross-frame
contexts carried something other than the previous step — zeros leaking from
the first call, a copy of the current step, or a reset in between. Since the
mean is large, a wrong "previous" would displace `alpha1_t` systematically,
which is the shape of the defect.

Checked by comparing what arrives as "previous" on call N against what was
"current" on call N-1, over 780 sub-frames of speech:

| context | mismatches | mean zeroed | equal to current |
| --- | --- | --- | --- |
| `alpha1_t` envelope-previous | **0** | **0** | **0** |
| `alpha2` activation-previous | **0** | — | — |

The second was also checked for scale: if it stored the pre-leaky activation,
its negatives would be about five times deeper than the current step's. None
are, confirming it stores the post-leaky value — which the client does too.

So both contexts persist exactly as specified. Every constant, every layout,
every window order, every slot position and both cross-frame states are now
confirmed, and the branch still misses by a factor of about `e^2.5`.

### Settled: the float layout here is already the client's

Read from the client's matmul pointer arithmetic: the weight pointer advances
by `n_out` per input, so it computes `out[o] = sum_i buffer[i * n_out + o] * x[i]`,
and the loader does not transpose. Uniform across all the float layers.

`companion_dense` here indexes `weights[i * out_size + o]`. That is the same
expression. **The float layout was never wrong**, and the transposition tried
above — `weights[o * in_size + i]` — is the opposite of the client's.

Worth stating in formulas rather than labels, because the labels caused a
round of confusion: `n_out`-contiguous is the *transpose* of PyTorch's
`nn.Linear` storage, so "the transposed one" means opposite things depending on
which convention is the reference.

So the seventeen-order-of-magnitude improvement came from a layout the client
does not use. That is the eighth time this session a change improved a metric
while being structurally wrong, and the second oracle called it correctly: the
norm spread put the untransposed reading inside the int8 layers' range and the
transposed one far outside, which is what the binary now confirms.

The envelope branch's defect is therefore not its weight layout, and not any
of its input constants, all of which are confirmed. What is left is narrower
and unidentified.

### Why that is not applied, even at seventeen orders of magnitude

Because one layer improving under a transposition is what curve-fitting looks
like, and the check that would make it structural fails. If the container
stores float weights transposed, that is a property of the container, so it
should hold for all six. Transposing all of them gives a median gain of
**1.09** — the closest to unity any variant has produced, and what a
post-filter should do — while taking the level ratio to 2.4e5, worse than
transposing `alpha1_t` alone.

Every combination now improves one metric and degrades another, which is the
signature of a missing fact rather than an unfinished search.

And a second, weaker oracle argues against the transposition outright. The
int8 layers now have a settled layout, so they calibrate what a correctly-read
layer looks like: their per-output-channel norms spread by 2.6x to 4.5x. Read
`[in][out]`, `alpha1_t` spreads by 4.5x and `alpha2` by 3.4x — inside that
range. Read `[out][in]`, they spread by 13.5x and 20.2x, far outside it.

That is a heuristic and not a proof: the calibration sample is nine layers,
and a spread is a ratio of extremes. But it points the opposite way from the
seventeen-order-of-magnitude improvement, which is reason enough not to act on
that improvement. The `pitch_embedding` was tried as a third check — a pitch
index is continuous, so neighbouring rows should have similar vectors — and it
came back inconclusive, 0.977 against 0.995 for neighbour-to-distant distance,
meaning the embedding is not smooth under either reading. The fact needed
is narrow and the binary has it: **are the float layers stored `[in][out]` or
`[out][in]`?** Nothing here can answer it, because the float layers carry no
`subias` to check against.

Two things that were ruled out along the way, both by measurement:

- **Order within the SIMD block.** `subias` is a sum, so it is invariant to how
  the four inputs of a block are ordered, and the client packs int16 pairs, so
  the order could differ. All 24 permutations were tried: the best takes the
  level ratio to 8.1e9, against 2.8e17 for the identity. None comes near 1, so
  intra-block order is not the fault.
- **The leaky ReLU.** It makes the shaping's input mostly positive, so with
  `alpha2`'s columns summing to +1.83 it contributes a systematic offset.
  Removing it moves the median from 2.500 to 1.958 and does not fix the level,
  so it is not the source either. The offset is also not in a bias: `alpha2`'s
  bias averages **-0.105**, nowhere near the +2.5 being looked for.

### Two inferred structural claims are now forced by arithmetic

Both were flagged here as inferred and listed among the things to confirm in
the client. Neither needs the client: the layer dimensions leave no freedom.

- `gru_input` has 160 inputs, so the GRU consumes 160 values per step.
- `tconv` emits 640. `640 / 160 = 4`, so there are exactly **four sub-frames
  per frame**. Eight would require it to emit 1280.
- `conv1` emits 96 per sub-frame, and `conv2` takes 768 inputs. `768 / 96 = 8`
  conv1 vectors, and with four per frame that is **two frames** — kernel 2 over
  frames, as built.

The alternative factorisation that motivated the caveat, `768 = 8 × 96` read as
eight sub-frames of one frame, is arithmetically impossible against `tconv`'s
output width.

This assumes only that `conv2` consumes `conv1`'s outputs and that the GRU's
input width is one step, both of which the chain's wiring already requires. The
provenance table is updated from "Inferred" to "Forced by dimensions".

### The signal chain is confirmed op by op, and matches

Audited against the client's caller, all five points:

| | client | this build |
| --- | --- | --- |
| stage order | `af1(input) → 2 streams → tdshape(channel 1, in place) → af4(both) → output` | same |
| overlap | overlap-**save**: output is exactly `frame_size`, history is the last 16 samples, no tail accumulated | same |
| what the shaping touches | channel 1 of `af1`, raw and in place; channel 0 passes untouched to `af4` | same |
| `af4`'s inputs | the two streams separately, summed by its `in_channels = 2` loop, not pre-mixed | same |
| each filter's history | the **input** of that stage | same |

No intermediate stage, no other order. Batching the stages across sub-frames
is equivalent to interleaving them, since nothing crosses stages within a
sub-frame, so that choice is free.

**This closes the audit.** Features, shaping, adaptive filters, GRU,
dequantisation, weight layout and now the signal chain have all been read in
the client and all agree with this code. The overlap-add experiment above was
worth running precisely because this was the last structural unknown; it is
now known, and it is `save`, which is what was already here.

## Three more things ruled out, and an API inconsistency

**The container holds more than this reads, and it does not matter.** The
`v2` package is three times the size of `v1` and carries 371 chunks against
48 — a full encoder/decoder, a `sig_net` and a `cond_net`, none of them
prefixed `mlowcompanion_`. Its fifteen Companion layers are the same fifteen,
which is why both files produce identical output here. Nothing is missing from
what this loads.

**The defect is systematic, not occasional.** An earlier note guessed the
level ratio might be an average dominated by a few frames, since individual
frames had been seen at sensible levels. Measured: exactly **1 of 195 frames**
comes out within 10x of its input, and the median frame is 3.7e7 times too
loud. The handful of sane frames are the exception, not the rule, and that
earlier impression is withdrawn.

**The spectrum is consistent with itself.** Checked against Parseval: for
white noise at the measured speech rms, the filterbank's bands average a log of
-0.40, while speech gives -3.14 because its energy sits in the low bands and
the high ones run quiet. No band reaches the `1e-9` floor in any sub-frame. The
`c0` of -14.675 follows from a mean log of about -3.4, which is what the bands
actually measure — so the cepstrum is internally consistent and its DC term is
the signal's genuine loudness.

### The `gain` field is declared, documented, and never read

`CompanionFrameState.gain` carries a comment saying "linear gain per sub-frame;
**the feature is its logarithm**", with a note to whoever fills it about
converting from decibels. Nothing in the library ever reads it. The only
reference anywhere is the test writing a value into it.

Meanwhile slot 92 — the one the client fills with a raw int16 that the binary
suggests is a gain or energy — is fed from `side_index`, a separate field whose
identity the header admits is unidentified, and which no dump can supply. So
the library asks for a value it ignores and uses a value nothing can provide.

Feeding the gain into slot 92 was tried in three forms — raw decibels, the log
of the linear gain, and decibels normalised to `[0,1]` — and all three make
crest worse (96.6 to between 101 and 114). So this is not the missing piece.
But the inconsistency is real and should be resolved by whoever learns which
field the slot wants: either `gain` feeds it and `side_index` goes, or `gain`
is vestigial and should be removed from the API rather than documented as
feeding a feature it never reaches.

## The defect decomposed: which stage contributes what

Ablation, on speech. Each row disables one thing and leaves the rest intact.

| configuration | level ratio | crest |
| --- | --- | --- |
| as built | 1.9e17 | 96.6 |
| **envelope branch zeroed** | **1.158** | 131.1 |
| shaping neutral (gain forced to 1) | 0.240 | 36.2 |
| shaping neutral + features zeroed | 0.155 | **7.65** |
| features and envelope zeroed | 0.090 | 9.05 |

Two separate faults, not one:

**The level comes entirely from the envelope branch.** Zeroing it takes the
ratio from 1.9e17 to **1.158** — essentially correct. Every constant feeding
that branch is confirmed against the client, so this is not a wrong value; the
branch is wired right and still contributes seventeen orders. Adding a constant
to its mean also fixes the level (`+8` gives 0.68) while leaving crest
untouched, which confirms level and shape are separable here.

**The shape comes mostly from the adaptive filters, not the shaping.** Forcing
the shaping's gain to 1 takes crest from 96.6 to 36.2 — a factor of 2.7. Also
zeroing the features, which is what conditions the filters' kernels and gains,
takes it from 36.2 to **7.65**, against an input crest of 5.0 — a factor of
4.7. So the filters distort nearly twice as much as the shaping does.

### The filters' kernels change 67% between sub-frames

Measured over 1598 transitions: the predicted kernel's relative change from one
sub-frame to the next is 38.9% at p10, **67.2% at the median**, 115.5% at p90
and 994% at worst. The cross-fade covers 15 of the sub-frame's 80 samples, so
81% of each sub-frame is filtered by something substantially different from
what filtered the one before, with no transition.

A change above 200% cannot come from direction alone, since the kernel is
L2-normalised — so the gain is swinging too, consistent with the measured range
of 0.25 to 1.2.

The cross-fade length was re-tested on the corrected build, since the earlier
sweep predates every fix: 15 samples gives crest 96.6, 30 gives 94.8, 50 gives
118.8 and 80 gives 146.7. Fifteen is near optimal and longer is worse, which
agrees with the value read from the client and rules the cross-fade out.

## Measured against the one real client output: the envelope's mean

The only output this work has from the client is a pure tone, where its crest
is **1.414**. That is the single fidelity target available, and it had not been
measured against the corrected build.

| pure tone | level ratio | crest |
| --- | --- | --- |
| as built | 149.4 | 12.37 |
| **with the envelope's mean removed** | **0.219** | **2.44** |
| the client | — | **1.414** |

And on speech, removing it takes the level ratio to **1.0027**.

Removing the mean is what `beta = 1` does in the running-mean test: the value
is subtracted from itself, so the slot reaches the network as zero. Sweeping
the smoothing constant from 0.01 to 1.0 changes nothing on the tone, because a
steady tone has a steady mean — so this is not a tuned parameter. It is the
mean's presence or absence.

That is uncomfortable, because the client is confirmed to append the mean raw:
all eighteen coefficients are used, nothing is normalised beforehand. Two
readings survive:

- **The client's mean is naturally near zero** where this build's is -5.18.
  That needs its signal at the envelope to have a mean magnitude near 1, where
  this build's is 0.0056. The input's is 0.054 and the adaptive gain is capped
  at 3.98, so no combination of the confirmed constants reaches it — something
  about the scale at that point is still not understood.
- **There is a normalisation with state** somewhere the constant-by-constant
  audit could not see, because it is not a constant.

Either way the level is no longer the open question: it is one scalar, its
effect is measured, and both candidate explanations are narrow.

**The shape is not fixed by this.** On speech, crest stays at 113 against an
input of 5.0, and on the tone 2.44 against the client's 1.414. Two further
things were tried and both make it worse: smoothing the kernel between
sub-frames (crest 96.6 to 152) and fixing the adaptive gain at 1.0 (96.6 to
163). The adaptation is internally coherent and interfering with either half
unbalances it, so the filters are doing what their weights say.

### How the mean actually acts: it modulates, it does not offset

The two columns the mean multiplies — slot 20 for the previous step, slot 41
for the current — were checked for whether the layer reads a *change* in level,
in which case the absolute value would cancel:

| | rms | sum over the 80 channels |
| --- | --- | --- |
| slot 20 (previous mean) | 0.134 | +0.090 |
| slot 41 (current mean) | **0.329** | +1.250 |
| correlation between them | **+0.074** | |

Near-zero correlation, so the layer reads the absolute level and nothing
cancels. But the more useful number is the contrast between rms and sum: the
weights are large individually and nearly cancel when added. So the mean

- **offsets** every channel by `mu * sum / 80` = -0.087, which is negligible;
- **modulates** the channels against each other by `|mu| * rms` = **1.7**.

A factor of twenty between the two. The mean does not shift the shaping's
exponent — it spreads it across the 80 channels, and that spread is what
becomes gain varying *within* a sub-frame, which is the mechanism for the crest
rather than the level.

That ties the two halves together: the same scalar that is too large produces
both the level error, through the exponential of a displaced mean, and part of
the shape error, through modulation. It also explains why centring the exponent
did not help earlier — centring removes an offset, and the damage here is not
an offset.

### The mean the level needs is arithmetically out of reach

The suggestion that `af1`'s second channel comes out too small, and that this
alone explains the mean, can be checked without measuring anything further.

A FIR whose kernel is L2-normalised to `g` produces `rms_out = g * rms_in`.
With the input at rms 0.0682:

| gain | output rms | mean magnitude | its log |
| --- | --- | --- | --- |
| 0.32 (measured on channel 1) | 0.0218 | 0.0175 | **-4.05** |
| 1.0 | 0.0682 | 0.0546 | -2.91 |
| **3.98 (the ceiling)** | 0.2714 | 0.2172 | **-1.53** |

The level needs a mean near **+2.8**. At the maximum gain the constant
`exp(1.3815 * tanh(.))` permits, the log only reaches **-1.53** — still more
than four away, or a factor of seventy in linear terms.

So the scale of that channel cannot be the explanation: no kernel, no gain and
no combination of the two can produce the mean the level requires, because the
gain is bounded by a constant read from the client. Three normalisation schemes
were also tried and none closes it — unit-RMS on the input per frame (ratio
8.1e7), per sub-frame (1.0e8), and unit-RMS on the signal the envelope pools
over while leaving the shaped signal intact (2.2e4). All three improve the tone
to a crest near 2.4 and none fixes speech.

That leaves the mean's *effect* rather than its value as the thing that does
not fit: `alpha1_t` gives the mean's slot the largest weights in the layer,
2.65x the layer average. A network trained on a mean around -5 would not
weight it most heavily. Either it was trained on a mean near zero — which the
arithmetic above says this signal path cannot produce — or something about that
slot is not what it appears.

## The shaping's float layers: fifteen orders, and a conflict

The client reads `alpha1_t` and `alpha2` in the **blocked** layout the int8
layers use — `w[(oc/8)*8*IN + i*8 + (oc%8)]` — not row-major. Reading them
row-major puts `mu * w` on the wrong channel and inflates the exponent.

Measured effect, on speech: the level ratio falls from **1.9e17 to 93.4**.
Fifteen orders of magnitude. On the tone, 149.4 to 23.3.

And it is specific rather than a general win: applying the same blocking to
*all* six float layers makes speech worse again, 93.4 to 3220. Only these two
are blocked.

Tested layer by layer, which sharpens it further:

| blocked layout applied to | level ratio |
| --- | --- |
| nothing | 1.9e17 |
| **`alpha2` alone** | **38.1** |
| `alpha1_t` + `alpha2` | 93.4 |
| `alpha1_t` alone | 227.1 |
| `pitch_embedding` alone | 1.1e18 (worse than nothing) |
| `conv1` alone | 9.8e15 |
| all four whose output is a multiple of 8 | 3220 |

`alpha2` alone beats the pair — adding `alpha1_t` takes it from 38 back to 93.
So if this is real it is **one** layer, not two.

And the obvious structural explanation does not hold. Four of the six float
layers have an output size that is a multiple of eight — `pitch_embedding` at
64, `conv1` at 96, and both shaping layers at 80 — so SIMD packing cannot be
why only some want the blocked read. `pitch_embedding` is a lookup table rather
than a matmul, which could explain that one, but `conv1` is an ordinary dense
and blocking it still costs two orders.

**But this build's own oracles disagree with each other about it**, and that is
recorded rather than resolved:

| check | says | reading |
| --- | --- | --- |
| level ratio | blk8 (1.9e17 → 93.4) | but a metric, not structure |
| norm spread, calibrated on the int8 layers' 2.6–4.5x | **row-major** (4.5x and 3.4x, against 11.6x and 8.5x) | against blk8 |
| the mean's slot weight | blk8, weakly (2.65x → 1.16x, nearer the deviations' 0.99x) | for blk8 |

The norm-spread oracle is the one that called the GRU's gate order correctly
when three other arguments and a nine-order improvement pointed the other way.
It is heuristic — a ratio of extremes over nine calibration layers — but it has
been right before against exactly this kind of pressure.

So this is **not applied yet**. The binary reading is the strongest evidence
available and it says blk8; but the same source previously reported all six
float layers as row-major and has now corrected that for two of them, so a
second confirmation is worth waiting for rather than repeating the pitch
index's mistake in the opposite direction.

## The "it is just the model's regime" reading is refuted by the tone

Tempting, and wrong. After clamp, blocked layout, pool width, decoder scale and
the mean's target all fell, the remaining explanation on offer was that this
build is correct and the high crest is simply what a pruned NoLACE does to
quiet speech. That would close the hunt with the port declared right.

The tone refutes it:

| | crest | level ratio |
| --- | --- | --- |
| input | 1.544 | — |
| **the client** | **1.414** | — |
| this build | **12.365** | 149.4 |

A pure tone is stationary. There is no quiet-speech regime, no envelope
dynamics and no level compensation that explains multiplying the crest by 8.7
on a signal the client hands back essentially unchanged. The client preserves
the tone; this build does not.

So the port is not correct, whatever the speech statistics say, and any
reasoning that ends in "there is no bug" has to account for this number first.
It is worth stating plainly because the conclusion was a comfortable one and
arrived when both sides were tired of the search — which is exactly when a
comfortable conclusion deserves the most scrutiny.

It also means the speech measurements, for all their precision, are the weaker
evidence. They have no reference to be compared against; the tone does.

## The remaining gap, decomposed to a single factor

Every statistic of the shaping path, measured on speech, for comparison
against the same quantities in the client:

| quantity | measured here |
| --- | --- |
| `alpha1_f` output rms | 1.3191 |
| `alpha1_t` output rms | 2.0488 |
| `h` (the `alpha2` window) rms | 1.4491 |
| exponent rms | **4.5701** |
| `alpha2` weights rms | 0.1346 |
| roughness of `h` | 1.379 |
| adjacent correlation of the output | 0.332 |

The client's exponent measures **3.26** for the same `mu`, so the gap is
**1.40x** — and it has to live in `h`, since the weights come from the same
container and the layout is confirmed.

Two decompositions narrow where:

**`alpha2` amplifies 1.85x beyond independence.** `sqrt(160) * 0.1346 * 1.4491`
predicts 2.467 and the measured exponent is 4.570. That factor is `h`'s own
correlation structure, not a fault — but it means any excess in `h` arrives at
the exponent multiplied.

**Inside `alpha1_t`, the mean accounts for 69% of the variance.** Its
contribution is `|mu| * 0.3286` = 1.702 out of 2.049, leaving 1.140 for
everything else. And both of those numbers are now confirmed: `mu` at -5.18 is
what the signal produces, and the weight of 0.3286 on that slot is the correct
layout's.

So for the exponent to fall to 3.26, `h` needs to be 1.034 rather than 1.449.
If the whole difference sits in `alpha1_t`, it would need 1.132 instead of
2.049 — **1.81x smaller** — which is almost exactly removing the mean's
contribution and leaving the remainder. But the mean and its weight are both
confirmed correct, so that route is closed, and the excess has to be somewhere
these measurements have not separated.

## The alpha2 layout is confirmed correct, to four decimals

The decisive test, run on this build's own weights. Output columns of adjacent
channels should correlate if the layout is right, because those outputs are
consecutive gains within a sub-frame:

| layout | adjacent columns | distant columns |
| --- | --- | --- |
| **`[in][out]`, what this code uses** | **+0.6373** | +0.2566 |
| `[out][in]` | -0.0076 | +0.0218 |
| blk8 | +0.4108 | -0.0396 |

The client measures **0.637**. Agreement to four decimal places, on a
statistic neither side chose in advance. The layout here is right, and the
blocked reading is dead for the third and last time — it was curve-fitting, as
the norm-spread oracle said before the binary confirmed it.

### And the shaping's input is supposed to be rough

The natural next suspicion was that `alpha2` expects a smooth `h` and receives
noise. Measured, it does not:

| | roughness |
| --- | --- |
| `h` reaching `alpha2` | 1.379 |
| `alpha1_f`'s output | 1.432 |
| `alpha1_t`'s output | 1.424 |
| white noise between neighbours | 1.414 |

All three are white to within measurement. And `alpha2`'s **rows** — its input
weights — do not correlate between neighbouring inputs either: +0.002 and
+0.031 for the two halves. So the layer is not built to receive a smooth input,
and feeding it a rough one is correct.

What the correlated *columns* do is make the layer's **output** smooth despite
that. Empirically the output's adjacent correlation measures 0.332 against the
0.637 the weights alone would predict, the difference coming from `h`'s own
temporal structure rather than from a fault.

So the shaping's wiring, layout and input character are all as they should be,
and the remaining excess variance is not explained by any of them.

## Scaling the mean: it owns the level and not the shape

The mean was scaled directly, which isolates it from any question of signal
levels or pool widths.

On speech:

| `mu` scaled by | resulting mu | level ratio | crest |
| --- | --- | --- | --- |
| 1.0 | -5.18 | 1.9e17 | 96.6 |
| 0.5 | -2.59 | 2.5e7 | 152.8 |
| 0.25 | **-1.29** | **608** | 99.3 |
| 0.125 | -0.65 | 22.2 | 115.8 |
| 0 | 0 | **1.0027** | 113.4 |

On the tone, against the client's crest of 1.414:

| `mu` scaled by | level ratio | crest |
| --- | --- | --- |
| 1.0 | 149.4 | 12.37 |
| 0.5 | 0.231 | 3.04 |
| 0.25 | 0.221 | **2.47** |
| 0 | 0.219 | 2.44 |

Three things follow, and one of them closes a line of reasoning.

**The predicted target of -1.2 does not land.** At `mu = -1.29` the level ratio
is 608, not 1 — three orders out. Only `mu = 0` reaches unity. So the backward
solve through `alpha2` that produced -1.2 is wrong by more than the physical
argument alone showed; even granting a mean that the signal cannot produce, it
would not fix the level.

**On speech the mean owns the level and not the shape.** The ratio moves
fifteen orders across this sweep while crest stays near 100 throughout, and
moves the wrong way in the middle of it. Whatever distorts speech is not the
mean.

**On the tone it owns both**, because a steady tone has a steady mean, so
removing it removes a constant rather than a varying quantity. That is why the
tone has looked so much more tractable all along — and why it is the weaker
test of the two despite being the one with a real client number attached.

## It is not the scale of the envelope window, it is the concentration

Three measurements from the weights, which reframe what is wrong:

**The shaping is centred near unity, not attenuation.** `alpha2`'s bias
averages -0.105, so with everything else at zero the gain is `exp(-0.105)` =
**0.90**. A design meant to attenuate to 0.1 would not have that bias. The
premise that the post-filter preserves level survives.

**`alpha1_t` is dimensioned for an input of rms 1.** Its weights measure rms
0.1455 against the `1/sqrt(42)` = 0.1543 a well-scaled layer of that width
would use — a ratio of 0.943.

**And the window it receives has rms 1.298.** That is close to what the layer
expects, and nowhere near the fifty-fold gap the earlier reasoning implied. The
envelope window's *scale* is not the fault.

What is wrong is how that energy is distributed. Two of the forty-two slots —
the two means — carry **76%** of the window's energy, because `mu` is -5.18
while the deviations sit at rms 0.653, a ratio of nearly eight to one. A layer
dimensioned for rms 1 expects that energy spread across its inputs, not
concentrated in two of them, and it has no way to compensate because its
weights are uniform in scale.

So the quantity that is out of place is **`mu` relative to the deviations**,
not `mu` in absolute terms. For the window to look like what the layer was
trained on, either the mean would have to be near 0.65 — which requires
`mean|sig|` near 0.5 and runs into the same physical ceiling as before — or the
deviations would have to be several times larger than they are.

That second possibility has not been examined, and it is the one that does not
require impossible signal levels: the deviations come from the log of a
four-sample pooled magnitude, and how spiky they are depends on the pool width
and on what the signal looks like at that point.

## The mean the network appears to want is physically impossible

**Still true, and it was the wrong question.** The mean the network appeared
to want is impossible because the network does not want a mean at all. See
"Resolved: the envelope's mean was the defect" below.

Worth stating plainly, because two rounds of work were aimed at closing a gap
that may not be a gap.

The reasoning ran: the shaping's gain should sit near 1; solving backwards
through `alpha2` gives an envelope mean near **-1.2**; this build measures
**-5.18**; therefore the signal reaching the envelope is about fifty times too
quiet, and the fault is upstream.

Follow that through to the input and it does not survive:

- The network is centred for `af1`'s channel 1 at `mean|x| ~ 0.30`.
- Its measured gain is 0.289, so the Companion's input would need
  `mean|x| ~ 1.04`, which is an **rms near 1.30**.
- On the int16 scale that is **42598**, where the maximum is 32767.

An rms of 1.30 in a `+-1` representation is a signal nineteen times above full
scale. No decoder produces that, and no audio format holds it.

Meanwhile the signal actually being fed measures **-23.3 dBFS** with peaks at
-9.5 dBFS — an ordinary speech level, comfortably inside range, with no sign
of being attenuated.

So one of the steps is wrong, and it is not the input's scale. The candidates:

- **The gain-near-1 premise.** A post-filter usually preserves level, but this
  one was pruned from a reference and its shaping may not be unity-centred.
- **The backward solve through `alpha2`.** It assumed a representative mean
  rather than a distribution, and this document has already shown that median
  and spread do not track each other here.
- **What feeds the envelope.** If the client's envelope reads something other
  than `af1`'s second channel at the scale assumed, every number after that
  shifts.

Recorded before chasing a decoder bug: the decoder's output is at a normal
speech level, and demanding otherwise would require it to clip.

## 86% of the exponent's variance comes from the envelope's mean

**This measurement is why the fix works.** See "Resolved: the envelope's
mean was the defect" below.

The exponent's spread is what drives both failures — the level through
`e^(sigma^2/2)` and the shape through gain varying within a sub-frame. Measured
where that spread comes from:

| configuration | mean | sigma | rms inflation |
| --- | --- | --- | --- |
| complete | 3.307 | **4.650** | 4.95e4 |
| **without the envelope's mean** | -1.255 | **1.770** | **4.79** |
| without the envelope branch | -1.036 | 1.660 | 3.97 |
| without the feature branch | 5.211 | 4.204 | 6.88e3 |

Removing the single scalar `mu` takes sigma from 4.65 to 1.77 — **86% of the
variance**. Removing the entire feature branch barely moves it, from 4.65 to
4.20. So the shaping's exponent is almost entirely driven by one number, and it
is the one measured at -5.18 where the network is centred for about -1.2.

Scaling that contribution by `1.2 / 5.18` puts sigma at 2.03 and the rms
inflation at 7.9, against 4.9e4 today. That does not reach the 1.05 a
well-behaved shaping would have — the residual 1.77 from everything else is
still too wide — but it accounts for four of the five orders.

This is why the clamp improves both halves and closes neither: it truncates the
tail that `mu` creates, which fixes the level, while the spread `mu` puts
through the middle of the distribution survives and keeps the shape wrong. The
clamp treats the symptom; `mu` is the cause.

## A clamp on the shaping's exponent moves both halves at once

The first change measured here that improves the level *and* the shape
together. Every previous candidate traded one for the other.

On speech:

| clamp on the exponent | level ratio | crest |
| --- | --- | --- |
| none (as built) | 1.9e17 | 96.56 |
| **\|x\| <= 3** | **1.186** | **41.52** |
| \|x\| <= 3.66 | 1.946 | 47.26 |
| \|x\| <= 5 | 6.26 | 55.98 |
| \|x\| <= 8 | 79.6 | 70.47 |

On the tone, where the client's real output is crest 1.414:

| clamp | level ratio | crest |
| --- | --- | --- |
| none | 149.4 | 12.37 |
| \|x\| <= 2 | 0.253 | **3.68** |
| \|x\| <= 3 | 0.386 | 4.35 |
| \|x\| <= 5 | **1.164** | 7.35 |

**It does not close either, and the two pull apart.** A tighter clamp improves
crest and overshoots the level downward; a looser one lands the level and
leaves the shape. No value gives both, and the tone's crest never reaches 1.414
— the nearest is 3.68 at a clamp that drops the level to a quarter.

So this is recorded, not applied. Choosing a clamp by which number it improves
is exactly the curve-fitting this document exists to refuse — and with two
metrics pulling opposite ways, any choice would be fitting one of them. What
the measurement does establish is that **something bounding the exponent is
missing**: an unbounded `exp` of a value this wide cannot produce a sane output,
and the reference's unbounded `exp` works only because its exponent is narrow.

The value has to come from the binary. Both the presence of a clamp and its
limit are readable there, and the range worth looking at is 2 to 5.

## The adaptive filters are correct; the shaping is where it explodes

Measured per channel, tracing magnitude through the chain on speech:

| stage | gain | input mean\|x\| | output mean\|x\| | ratio |
| --- | --- | --- | --- | --- |
| `af1` channel 0 | 1.566 | 0.0200 | 0.0242 | 1.21 |
| `af1` channel 1 | 0.289 | 0.0200 | 0.0059 | **0.294** |
| `af4` | 0.255 | 0.0242 | **16834.9** | 697212 |

`af1` does exactly what its gains say — channel 1's measured ratio of 0.294
against a gain of 0.289 is agreement to within the correlation of the signal.
There is no factor lost inside it, and the `mean|sig|` of 0.0059 that the
envelope sees is precisely what a gain of 0.289 produces from an input of
0.020.

`af4` is not amplifying either. Its two inputs are `af1`'s channel 0, at
0.0242, and channel 1 **after the shaping** — and for its output to reach
16834 at a gain of 0.255, that second input must be arriving at roughly 66000.

So the chain is: `af1` correct, the shaping inflates channel 1 by four to five
orders, and `af4` faithfully passes on what it is handed. This is the same
conclusion the ablation reached, now confirmed by following the magnitude
rather than by switching things off — the two methods agree.

It also settles what the `af4` gain being pinned at its floor means. It is not
a cause: with its input arriving at 66000, a gain of 0.251 is the network doing
the only sensible thing available to it. The saturation is a *response* to the
shaping's output, not an independent fault.

### What the input scale would have to be

The network is centred for `af1`'s channel 1 to arrive around 0.30. At the
measured gain of 0.289, that needs an input of 1.04 — an input rms near 1.3,
which is **19x** what this build feeds. Raising the input was measured earlier
across a sweep and it improves the level monotonically without ever closing
it, so the scale alone is not the answer either.

## The af4 gain is pinned at its floor two thirds of the time

The clearest single anomaly found in the signal path, measured over 800
sub-frames of speech.

| | pre-tanh p50 | saturates | resulting gain p50 | at the floor |
| --- | --- | --- | --- | --- |
| `af1` | +0.145 | 7.2% | 1.220 | 12.4% |
| **`af4`** | **-2.592** | **46.9%** | **0.255** | **67.0%** |

**That `af1` row is both of its channels together, and they are nothing alike.**
Separated, over the same material with the decoder's own features fed:

| | `tanh` p10 | p50 | p90 | at either rail | gain p50 |
| --- | --- | --- | --- | --- | --- |
| `af1` channel 0, which passes through | -0.1855 | **+0.0875** | +0.5998 | **0.0%** | 1.1285 |
| `af1` channel 1, which gets shaped | -0.9963 | -0.8131 | +0.9759 | 28.4% | 0.3252 |
| `af4` | -0.9987 | -0.8682 | +0.6980 | 25.8% | 0.3014 |

That eight-fold split is also what confirms `af1_gain`'s layout, by an
argument that cannot go the other way. Its 320 weights read as `[in][out]`
give channel standard deviations of 0.0469 and 0.3889, a ratio of 8.3. Read as
`[out][in]` they give 0.2722 and 0.2801, a ratio of **1.0**. The wrong reading
interleaves the two channels and must return them equal; only the right one
can find an asymmetry. So the asymmetry is real and the layout is settled.

`af1` channel 1 and `af4` are the same layer twice over: 28.4% against 25.8% at
the rails, gains of 0.3252 against 0.3014, and weight distributions of standard
deviation 0.3889 against 0.4050. Channel 0 is the one that differs, at 0.0469 --
**eight times smaller** -- and it is the branch that passes through, where a
gain that stays near 1 is what the chain needs.

So `af4` is not an anomaly against `af1`. It is an anomaly against `af1`'s
*pass-through* channel, and it matches `af1`'s *shaped* channel exactly. Two of
the three gains are built large and sit low; one is built small and sits at
unity. Whether that is design or defect, it is one question about two channels
rather than a singular fault in the output stage.

They are also not pinned in the sense that word implies. `af1` channel 1 runs
from -0.9963 at p10 to +0.9759 at p90 and `af4` from -0.9987 to +0.6980: both
use most of the range and lean low, rather than sticking.

`af4` is the final stage, collapsing both streams into the output, and its gain
sits at the floor `exp(-1.3815) = 0.251` in two thirds of sub-frames. A trained
layer does not spend two thirds of its time against a rail.

**It is not a biased GRU.** The hidden state's mean measures -0.054, near zero
and healthy, so the systematic negative is not an offset being fed in. The
layer's bias is also small at +0.0897.

**It is magnitude.** `af4_gain` takes 160 inputs of rms 0.589 through weights
of rms 0.406, which gives a pre-activation of rms ≈ 3.0 — and `tanh` saturates
past 2.65. For it to sit in its linear range the pre-activation would need rms
near 1, meaning either the GRU's state or these weights are about three times
too large.

One structural note: `af4_gain`'s weights sum to **-4.638**, against **-0.730**
for `af1_gain`'s second channel at a comparable rms. That asymmetry is in the
model and is what tilts this layer negative rather than positive when it
saturates.

This is the same "runs hot" signature as the activations, now localised to the
one place it does visible damage: the output stage's gain.

### This now explains the level, and the sentence that said otherwise was right at the time

What used to stand here was that a gain pinned low could not explain the level,
"a gain pinned low would make the output quieter, and the output is far too
loud". That was true of a build whose envelope branch was driving the output
sixteen orders too loud. With that gone the output is too **quiet**, and a
gain pinned at 0.255 is exactly the size of what is missing.

Measured by forcing the gain, at the median frame of a real decode:

| `af4` gain | level ratio |
| --- | --- |
| as it runs, p50 0.255 | 0.2695 |
| forced to 0.5 | 0.3929 |
| **forced to 1.0** | **0.7859** |
| forced to 2.0 | 1.5718 |
| forced to 4.0 | 3.1436 |

Exactly linear, as it must be, and unpinning it recovers **2.9 of the 3.7**
that separate this build from unity. What remains after that is 1.27, which is
a different and much smaller question.

The chain, per sub-frame, at the median, as rms against the block going in:

| stage | rms in | crest |
| --- | --- | --- |
| input block | 1.0000 | 1.966 |
| `af1` out, channel 0 (passes through) | 1.1353 | 2.407 |
| `af1` out, channel 1 (gets shaped) | 0.3351 | 2.498 |
| after the shaping | 0.0705 | 3.777 |
| `af4` out | 0.1881 | 2.646 |

`af4` emits less than the pass-through branch alone carries into it, which is
the pinned gain showing up as a stage.

### What is anomalous is the weights, not what feeds them

`af1_gain` reads the same hidden vector and sits at 7.2% saturation, so the
state cannot be globally wrong. Column norms across every layer in the model,
which is what multiplies a hidden vector of rms 0.589:

| layer | column norm |
| --- | --- |
| everything else | 1.25 to 2.34 |
| `af1_gain` | 2.757 |
| **`af4_gain`** | **5.135** |

(`pitch_embedding` at 17.0 is excluded: its input is a one-hot lookup, so a
column norm does not mean the same thing there.)

At 5.135 against a hidden of rms 0.589 the pre-activation lands at 3.02, and
`tanh` is past 0.99 from 2.65. For this layer to sit in its linear range its
column norm would have to be near 1.7 — a factor of three, on a **float** chunk
of exactly 160 values read raw, with no scale to misapply and no layout to get
wrong at one output channel.

Its column sum of 4.638 is *not* a second anomaly: for 160 weights of rms
0.406 a random walk gives about 5.1, so the sum is what the rms implies and
carries no alignment of its own. The earlier note contrasting it with
`af1_gain`'s -0.730 compared sums at different rms and should not be read as
structure.

**Grade: measured** that the gain is pinned, that unpinning it recovers 2.9 of
the 3.7, and that the cause is this layer's own weight magnitude. **Open:** why
a float chunk read raw is three times what the rest of the model is.

## Where this leaves the open defect

The level ratio and the crest are still wrong, and after this audit the honest
reading is narrower than "something is broken somewhere".

Every constant, every layout, every ordering and the whole signal chain match
the client. So the defect is not a value read wrongly and not a structure
assembled wrongly — those categories are exhausted. What remains is one of:

- **The regime is real.** A pruned model may simply run with 6% of its GRU
  outputs at the rails and produce an exponent this wide, and the expectation
  of 2-6% saturation and a near-unity gain is an assumption of this document,
  not a measurement. That assumption has already been wrong once here: the
  target of `c0 ≈ 3.3` came from the same kind of reasoning and did not
  survive.
- **Something outside the structure.** Anything that lives in the exported
  weights rather than in the code — a quantisation detail below the layer
  level, a layer this container carries that nothing reads — would be
  invisible to every method used here, because every method compares *code*
  against the client.

Both are open. What would settle it is the one thing this work has never had:
a reference pair of (input, output) produced by the client itself. Every
measurement in this document constrains the port; none of them can confirm it.

### Overlap-add against overlap-save: measured, and it is not the difference

The adaptive convolutions here are overlap-save — each sub-frame reads the
signal's history and emits exactly `frame_size` samples. The alternative is
overlap-add, where each sub-frame convolves only its own block and the tail
carries into the next. With a fixed kernel the two are identical; with a kernel
that changes every sub-frame, which is the case here, they differ in *shape*
while barely touching the level. That made it the best remaining candidate for
a crest problem.

Measured on speech:

| | level ratio | crest |
| --- | --- | --- |
| overlap-save (as built) | 1.565e17 | 109.12 |
| overlap-add | 1.429e17 | 108.37 |

Eight per cent on the level, under one per cent on crest. Whatever the client
does here, it is not what separates this build from it.

**The test nearly reported the opposite.** The first run had the two columns
byte-identical, which this document already warns should be suspected of not
having run — and it had not: the control case passed `COMPANION_OLA=` with an
empty value, and `getenv` returns an empty string rather than `NULL` for that,
so both columns ran overlap-add. The rule written down earlier caught it.

## Fixed: the pitch index is the mean of two lags, with no offset

Read from the client, and the most uncomfortable finding here because the
mistake was documented in this very file while the code did something else.

The client averages the sub-frame's two recorded lags and indexes the table
directly: `round((lag_a + lag_b) / 2)`, no offset. This code halved *one* lag
and added 32. The provenance table above already said "pitch index is the
rounded mean of two lags — read from the client", and the comment beside the
code said the quiet part out loud:

> the halving may therefore be their mean rather than a scaling of one ...
> **scaling measures better**, so that is what this does

A number was preferred over a reading, and the discrepancy was written down
rather than resolved. That is precisely the failure this document exists to
prevent, committed inside the document itself.

Measured effect of correcting it:

| | level ratio | crest | GRU at rails |
| --- | --- | --- | --- |
| half a lag + 32 | 1.6e17 | 109.1 | 6.3% |
| **mean of two, no offset** | 1.9e17 | **96.6** | **5.6%** |

Crest and saturation both improve while the level ratio is essentially
unchanged — which is exactly the pattern that made the wrong version look
better under whichever metric was being watched at the time.

The rest of the sweep came back clean. `acorr` is a normalised correlation over
the pitch lags and matches; `numbits` is `sin(k_j * X - 0.5)` over eight
frequencies and matches; `ltp` is two adaptive-codebook gains copied raw plus
three lags scaled by `x * 0.5 + 32`, logged **base ten**, each with its own
affine step — all as built. Every bias in the backbone is small (0.06 to 0.14),
so nothing runs hot by design and the hot activations are inherited from the
features rather than injected by a layer.

One consequence for the reader: the `x * 0.5 + 32` used by those three lags is
*not* the same convention as the table index, though this file and the code
both described them as one thing. They are separate scalings that happened to
be written alike, and only the index was wrong.

Two property checks encoded the old convention (`100 -> row 82`) and were
updated with it. They tested the convention rather than a property, so they
follow the reading; the checks that do test properties — the unvoiced fallback
and the table bound — were untouched and still pass.

## The weight layout was wrong, and `subias` is what found it

This resolves the saturation recorded below, and it is the strongest result
here because the model validates it without reference to the client.

The weights are not row-major. They are laid out for the client's SIMD kernel:
blocks of **8 output channels**, and within a block, **4 contiguous inputs per
channel** — index `((ob * in_blocks + ib) * 8 + p) * 4 + q`, with `ob = o/8`,
`p = o%8`, `ib = i/4`, `q = i%4`. Reading them row-major keeps every weight's
magnitude and destroys which input each belongs to, which is a permutation of
the matrix.

`subias` is what identifies it, and it stops being a mystery in the process.
The client compensates the input's zero point in the accumulator and cancels it
with `subias`, so

    subias[o] = -127 * scale[o] * sum_i q[i][o]

That sum is **per output channel**, so any layout that mixes channels gets it
wrong while keeping the right magnitude — which is exactly the signature
recorded below: equal rms, nil correlation. That makes `subias` an oracle. Nine
candidate layouts were scored against it:

| layout | result |
| --- | --- |
| row-major `[i][o]` (what this code did) | r ≈ 0.1, no structure |
| 8 out-channels x 4 inputs, inputs contiguous | **r 0.997 to 0.9998, slope 1.00** |
| every other blocking tried (2, 8, 16; either inner axis) | well below |

Slope 1.00 with r ≈ 0.999 on all nine int8 layers is identity, not
resemblance. Worst per-channel deviation runs 0.07 to 0.41 of the target's rms,
so a few channels are off while the population matches.

Measured effect of fixing it, on the pure-tone dump:

| | GRU | ft1 | ft2 | output rms |
| --- | --- | --- | --- | --- |
| row-major (before) | 15.2% | 25.2% | 32.0% | 0.062 |
| SIMD layout (after) | **1.9%** | **3.8%** | **5.6%** | 2463 |

The saturation is gone and the internal scale is healthy at 0.47. `af1` now
behaves: it takes a signal of crest 1.998 to 2.223, where it previously
inflated. **The output level is still wrong**, and that is the next section.

The tap order was applied at the same time, on the client reading that
`k[0]` weights the oldest sample — see the section on the zeroed tap 0, which
the model corroborates independently.

## What is left is one number: the envelope's mean

**Resolved.** It was that number, and the resolution was to stop feeding
it rather than to find its right value. See "Resolved: the envelope's mean
was the defect" below.

With the layout fixed, tracing by stage puts the whole remaining error in the
shaping's envelope branch, and measuring the distribution of what reaches its
`exp` narrows it to a single scalar.

### It is not a tail, it is the centre

On speech, the value entering `exp` is distributed like this:

| percentile | value | gain |
| --- | --- | --- |
| p1 | -3.645 | 0.026 |
| p50 | **2.500** | **12.2** |
| p90 | 8.108 | 3.3e3 |
| p99 | 19.086 | 1.9e8 |
| p100 | 56.787 | 4.6e24 |

The *median* gain is 12x. A post-filter's gain should sit near 1, so this is
not an outlier problem — the whole distribution is displaced and spread.

### The difference between the two candidate scales is exactly the mean

The envelope is `log` of the pooled magnitude, split into deviations from its
own mean plus the mean itself, with a floor of `2^-16` inside the log. That
floor is half an int16 LSB, so it belongs to the signal's scale and has to
scale with it. Doing both together is an identity:

    log(32768 * x + 2^-16 * 32768) = log(32768) + log(x + 2^-16)

So feeding the branch int16-scaled signal *with the floor scaled to match* is
exactly the +-1 case with every envelope entry shifted by `ln(32768) = 10.397`
— and since the first twenty entries have their own mean subtracted, the shift
cancels in all of them. **The only thing that changes is the last entry, the
mean.** Everything below follows from that one number.

Measured, on the same speech:

| | p50 | p90 | p100 | level ratio |
| --- | --- | --- | --- | --- |
| mean as-is (+-1 scale) | 2.500 | 8.108 | 56.787 | 2.8e17 |
| mean shifted by ln(32768) | **-1.912** | **0.184** | 6.358 | 0.128 |

The catastrophic tail disappears — the largest value entering `exp` drops from
56.8 to 6.4 — and p90 lands at a gain of 1.2, which is what a post-filter
should do.

### Two things the local measurement does rule on

With the shift applied, the two branches come into balance — `alpha1_t`'s span
runs 1.52x `alpha1_f`'s at the median, against roughly 5x before. And both
spans are what their own weights and inputs predict: `alpha1_f` takes 320 tanh
inputs through weights of rms 0.084, which gives a pre-activation of rms ~1 and
a span over 80 outputs of ~5.6 against the 6.18 measured. So the layer is doing
what its weights say, and there is no missing output scale on the envelope's
dense to look for. Whatever remains is in what the envelope is fed, not in how
it is projected.

What the local measurement will *not* rule on is magnitude against energy.
Summing `sig^2` rather than `|sig|` moves the level ratio from 0.128 to 0.918 —
essentially what a post-filter should do — while moving crest the wrong way,
from 53 to 98. Neither form is better on both, so this one needs the binary
too.

### The scale is +-1, and the shift is the wrong direction

Settled against the client, and it reverses what the shift above appeared to
show. The client's decoder converts float to int16 in its *final* stage, so
everything upstream — features, adaptive filters and this envelope — runs on
+-1. The harness here already feeds +-1, so the scale was never the difference.

That means the `ln(32768)` shift that improved every number is the *opposite*
of what the client does: adding it is equivalent to feeding int16, which the
client does not. The improvement was real and the explanation was wrong, which
is exactly why it was not applied.

The API contract in `companion.h` said the opposite — int16 — and cited the
client for it. That citation does not survive: the reasoning recorded with it
argues from the symptom, that normalised input drives the shaping's exponential
past 1e12. That is a deduction from the bug, written down as a measurement.
Corrected there.

Measured on speech at +-1, per sub-frame:

| | p10 | p50 | p90 |
| --- | --- | --- | --- |
| envelope mean (mu) | -7.874 | **-5.183** | -3.613 |
| deviations, rms | 0.373 | **0.643** | 0.963 |

The deviations are small. What drives `alpha1_t` is the mean, at -5.18 times
that layer's weights, which acts as a large level-dependent bias. So with the
scale now fixed by the client, the 12x median gain cannot be explained by it,
and the remaining error is in `alpha1_t`'s own weights or in what follows —
not in what it is fed.

### Why this is recorded and not applied

It is still a guess about the client. The shift has the right size and a
principled form, but `ln(32768)` being the size of a discrepancy does not prove
the client uses int16 there, and two internally consistent readings exist:
`+-1` with a `2^-16` floor is just as self-consistent as int16 with a half-LSB
floor. They differ only in this mean, which is precisely why the binary has to
settle it rather than a sweep.

It also does not close the gap: with the shift applied, speech still comes out
at crest 53 against an input of 5.0, so something after this remains wrong.
Applying a guess that improves a number without closing it is how a wrong value
gets frozen in as though measured.

An earlier and weaker version of this test — int16 scale *without* scaling the
floor — moved the pure tone's crest from 89.8 to 2.95 and looked far better
than it was: on speech it gave a level ratio of 1208 and crest 117. Pure tone
alone is not enough to judge this branch, because its pooled log-envelope is
genuinely spiky and flatters a wrong answer.

## The activations are saturated, and the zero point is why

Measured 2026-09-21, after a peer reading the client binary predicted it. The
share of activations pinned at the rails, over the pure-tone dump:

| stage | rms | at the rails |
| --- | --- | --- |
| GRU hidden | 0.749 | 15.2% |
| ft1 output | 0.819 | 25.2% |
| ft2 output | 0.858 | 32.0% |

A trained network does not run with a third of its `tanh` outputs at ±1. The
peer's reading of the client puts its filter gains within about 30%, which is
`exp(±0.3)` — nowhere near the rails.

The cause is the zero point, not the input. Every int8 layer's constant term
has rms 2 to 3 where its *trained* bias has rms 0.06 to 0.11, so the constant
outweighs the trained one twenty to thirty times and drives the `tanh` before
the signal gets a vote. Dropping it desaturates the network completely:

| variant | GRU | ft1 | ft2 | output rms |
| --- | --- | --- | --- | --- |
| zero point added (current) | 15.2% | 25.2% | 32.0% | 0.062 |
| zero point dropped | **0.0%** | **0.8%** | 6.6% | 4.2e5 |

The internal scale that comes back — GRU rms 0.42, nothing at the rails — is
what a trained network looks like. But the output level then explodes by a
factor of 2.7 million, and per-frame tracing shows it is not a runaway: frame 0
is already 400x high and the level oscillates without trending. So a second
fault was being masked.

Tracing by stage finds it in the shaping, which multiplies by 65x in a single
sub-frame where the adaptive filters, bounded by `exp(1.3815 * tanh(.))`, can
only reach 3.98. The shaping's `exp` is unbounded — and that is *correct*, the
reference does the same — so what is wrong is the value reaching it, which
comes through `alpha1_f`, itself an int8 layer whose constant term the variant
just removed.

That is as far as measurement gets without the client: the two candidate
dequantisations each leave the network broken in a different place, and
choosing between them needs the client's input quantisation read from the
binary. The question is narrow — whether it is `round(127x) + 127`
(asymmetric, which is what the current code assumes and what produces this
constant) or `round(127x)` (symmetric, no zero point at all).

### `subias` has the zero point's magnitude and none of its structure

Worth recording because the coincidence is striking and still means nothing.
Layer by layer, `subias` and the computed zero point have almost the same rms —
`af1_kernel` 1.320 against 1.321, `fnet_conv2` 3.032 against 2.900,
`gru_input` 1.920 against 2.081. Four significant figures on the first one.

But the correlation is nil under every layout tried: `+0.12` reading the
weights as `[in][out]`, `+0.05` as `[out][in]`, `-0.01` on the unscaled row
sums. Equal magnitude is what two sums of n similarly-scaled values give
whether or not they are the same quantity, so this is a coincidence with no
structure behind it. `subias` stays unexplained, and stays unused.

### Fourteen candidate forms for `subias`, all nil

Summing over the whole input axis is invariant to permutation, so `[in][out]`
and `[out][in]` exhaust the groupings — what was left was how the bytes are
read, whether the sum is partial, and where the scale enters. Fourteen forms
were tried against `subias`: the sum as int8, as `uint8 - 128` and as raw
uint8, on both groupings; with and without the factor 127; over one tap rather
than both; the trained bias and the channel scale on their own; and
`trained_bias - 127 * scale * sum(q)` on both groupings.

The best correlation anywhere is `0.363`, and the winning form differs layer by
layer — one picks the trained bias, another a single tap, another the raw
uint8 sum. That pattern is what noise looks like when fourteen candidates
compete over a few hundred samples, not what a real relation looks like. So
`subias` is not derivable from these weights by any of these routes.

One consequence is worth stating because it narrows where the fault can be. If
the client quantises its input as `round(127x) + 127`, then expanding the GEMM
puts `127 * scale * sum(q)` on the bias, which is exactly what this code adds —
and the stored bias cannot already contain that compensation, because it has
rms 0.06 to 0.11 where the compensation has rms 2 to 3. A pre-compensated bias
would be dominated by it. So the stored bias is the trained one, and adding the
zero point is the algebraically correct expansion of that quantisation.

Which means that if the `+127` is confirmed in the binary, the fault is not in
the compensation. It is upstream of it: in the weight scale itself. That points
back at runtime weight normalisation, and it would also explain `subias` —
a zero point computed over the weights *before* normalisation would have the
right magnitude and no correlation with the weights after it, which is exactly
what is measured. That last step is inference, not measurement, and is recorded
as such.

## The peer's routing, measured both ways

The peer reads the client's caller as feeding `ft1` and `ft2` the *same*
buffer — the GRU output — where this build chains `ft2` onto `ft1`, and as
conditioning `af1` on `tanh(ft1(GRU))` where this build conditions it on the
GRU directly.

Under the current dequantisation every variant is worse, which is what the
peer's own mechanism predicts: with the GRU already saturated, routing a
saturated vector into the gain layers pins them at the ceiling. Under the
desaturated dequantisation one piece of it is corroborated independently of
output level — chaining is what saturates `ft2`:

| routing | ft2 saturated |
| --- | --- |
| `ft2` chained onto `ft1` (current) | 6.6% |
| `ft2` reading the GRU (peer) | **1.3%** |

That is a structural signal and not a level measurement, so it survives the
fact that neither variant fixes the crest. Nothing here is settled enough to
change the code: the output level is wrong in every combination tried, and the
routing cannot be judged while the dequantisation underneath it is unresolved.

## Both kernels zero their tap 0, which anchors the tap order

Measured over the layer norms, and the cleanest structural fact found so far.
In both `af1_kernel` and `af4_kernel`, and identically in the v1 and v2
containers, exactly two of the thirty-two coefficients have every weight zero:
indices 0 and 16. The kernel is out x in x taps = 2 x 1 x 16, so those two are
**tap 0 of each output filter**. Nothing else in any layer is zero.

That is deliberate, and it reads on the tap order, which is a real difference
between this build and the reference.

The reference convolves causally with the kernel running backwards in time:
`left_padding == kernel_size - 1`, and the correlation works out to
`out[i] = sum_t k[t] * x[i + t - 15]`, so `k[15]` multiplies the current sample
and `k[0]` the oldest one. This build indexes `i - t`, so `k[0]` multiplies the
current sample. The two conventions are mirror images.

Under the reference's order a zero at tap 0 drops the oldest sample, leaving a
filter of fifteen effective taps — and the kernel cross-fade is over fifteen
samples. Under this build's order it drops the *current* sample, leaving a
filter that never sees its own input. The second reading is strange enough to
be worth resolving.

Reversing the tap order and measuring does not settle it: crest goes from 8.72
to 13.52 on the current dequantisation and is unchanged on the desaturated one.
But no level measurement can settle it while the network underneath is
saturated, and reversing a FIR's taps preserves its magnitude response and
changes only its phase — which is precisely the class of error that output
level cannot catch, the same reason the kernel activation is called out
separately in `AGENTS.md`.

So this is recorded as an open question with a hard anchor, not as a finding:
whichever order the client uses, its tap 0 is zero, and that is checkable in
the binary.

Two things the reference does settle, by reading it rather than assuming:
`KERNEL_INDEX(out, in, tap) = ((out * in_channels) + in) * kernel_size + tap`,
which is the layout used here; and `scale_kernel` normalises **per output
channel** over input channels and taps together, which is also what is done
here. The per-channel scope was queried as possibly being over the whole
kernel — in the reference it is not. Whether the client kept that is still
open.

## What the measurement cannot distinguish

Worth knowing before trusting a measured comparison here.

The residual energy varies by **0.007 on average within a frame** and by
**38.3 between frames**. It is effectively constant across the four sub-frames —
which are four genuine sub-frames, measured, not replicated ones.
So any two hypotheses that differ only in *which sub-frame* a value is read
from produce identical output — reading `[0],[1],[2]` of the frame and reading
`[sf],[sf-1],[sf-2]` measured the same to four decimal places, though they are
different rules.

That is a property of the test material, not of the model. Distinguishing
per-sub-frame indexing needs speech whose energy moves within 20 ms — plosives,
onsets, clipped consonants — rather than the sustained tones used here.

The same caution applies more generally: a comparison that moves the number
proves something only if the two candidates could have moved it differently.

## What to validate first

Ordered by how much rests on it.

0. **The `[87:93]` slots.** Now known to be wrong rather than merely
   unconfirmed; awaiting the slot-by-slot trace before rewriting.
1. **The dequantisation rule.** Nothing about the Companion's output can be
   measured until this is right. Needs the client's forward pass read: how
   `scale`, `subias` and `bias` enter, and whether a weight norm is applied at
   runtime — the reference applies `weight_norm` to exactly the layers that
   come out degenerate, which would explain raw weights 85× too small.
2. **The gain's units.** Tied to the conflict above: the client applies
   `log10` and an affine step where we apply `10^(dB/20)` and a natural log.
3. **The sub-frame count and the `conv2` stride.** Structural, silent if wrong.
4. **The analysis window.** Still a reference table, never checked against the
   client — now the only such table left, since the filterbank weights turned
   out to have been measured all along.

## Resolved: the envelope's mean was the defect, and scale-equivariance is what proves it

The level ratio on real speech goes from **1.9e17 to 1.003**.
`envelope[pooled]` carried the pooled log-magnitude's mean; it now carries
zero.

### The question that found it, and why no level measurement could

Every measurement in this file until now asked whether the output level was
right, at one input level. That question cannot separate a filter that is
wrong from a filter that is level-*dependent*, and this one was level-
dependent. Ten configurations were tried against it and every wrong one moved
one metric and worsened another, which is exactly what a level-dependent
filter does when you change something that shifts its operating point.

Feed the same material at a range of levels and the answer is unambiguous. A
post-filter has to be close to scale-equivariant -- the same speech six
decibels louder comes out six decibels louder and otherwise alike -- and that
is a property of what a post-filter is, not a value that needs a client to
confirm. It is the first claim in this file that needed no reference.

Over a 64x sweep of the input, on the real decode. `d` is the slope of
`log(ratio)` against `log(input)`, so `d = 1` is equivariant:

| input scale | with the mean | without it | without it and without `c0` |
| --- | --- | --- | --- |
| 0.125 | 1.675e11 | 0.3157 | 0.2083 |
| 1 | 1.185e6 | **0.2695** | 0.2058 |
| 8 | 12.5 | 0.2145 | 0.2058 |
| **`d`** | **-4.61** | **0.91** | **1.00** |

The first column moves by **1.3e10** across the sweep. No filter that runs in
a phone call behaves that way, whatever its correct gain turns out to be. The
second is flat to 9%.

**Measure this at the median frame, not in aggregate.** Two measurement errors
here, each found because of the other, and both worth more than the numbers:

- The aggregate ratio -- the whole run's output rms over its input rms -- is a
  **tail statistic** once the shaping gain spreads a hundredfold inside a
  frame: a handful of frames that blow up dominate the sum of squares. Measured
  in aggregate this same sweep came out *non-monotone* (7.40, 1.00, 3.46),
  which is not a level dependence at all, and it put the ratio at 1.003 where
  the median frame puts it at 0.27.
- The first per-frame attempt divided by the **unscaled** input, which puts the
  sweep's own factor inside the ratio and inflates `d` by exactly one. It
  announced itself: zeroing every feature that sees the signal leaves the path
  exactly linear, so `d` has to be 1, and it read 2.00.

Both rows below now read 1.00 exactly, which is what says the metric is right.

### Why the mean did it

The exponent is exponentiated. An absolute level reaching it makes the output
level move with the *exponential* of the input's. That is where the sixteen
orders came from: not a wrong constant somewhere, a wrong dependency.

On a stationary tone the mean is the entire branch. Read from the weights,
with no forward pass and so with nothing that could pull two metrics apart:

| how the mean enters | coefficient | contribution at the tone's `mu` of -3.58 |
| --- | --- | --- |
| its own slot, `w[20] + w[41]` | 0.3640 | **1.304** |
| raw in all 21 channels, as the reference does | 0.6414 | 2.298 |

`alpha1_t` measures rms 1.31 on that tone. So 1.304 of 1.31 was the mean: a
constant scalar times a fixed 80-wide weight pattern was setting the gain of
every sample of a stationary signal.

The second row is worth keeping. The reference does not demean at all, so
"stop demeaning" reads like the obvious correction, and it is the **worse** of
the two by a factor of 1.76, for the same reason. The demeaning was already
protective. What was not protective was feeding the mean anyway.

### What the tone shows

| | with the mean | without it |
| --- | --- | --- |
| level ratio | 149.4 | 0.2191 |
| crest, input 1.54 | 12.37 | **2.44** |
| shaping gain spread, median frame | 7326x | 53.7x |

### Where the level dependence went, and where it did not

`d` reads 0.91 as built and **1.00 exactly** under either of two controls:
zeroing `c0`, and zeroing every feature that sees the signal at all
(`[64:87]`; the clean spectrum is the LPC envelope, whose mean log is zero by
construction, and the rest come from the codec). The second is not an
experiment, it is a check on the first: with no signal reaching the
conditioning, the adaptive filters are linear and the shaping gain is fixed,
so an exactly equivariant reading is the only correct answer.

So the residual 0.09 is `c0`'s, and that is all of it. Two things this
refutes, both of them things measured here earlier and wrongly:

- **It is not the envelope's log floor.** Setting `2^-16` to `1e-30` leaves
  `d` at 0.91 to two digits. The floor is half an LSB of a signal on this
  scale, so it is already matched to it.
- **It is not worth chasing by rescaling `c0`.** Five multipliers on the band
  magnitudes, from `pi/2` to `N`, were measured: every one of them raises the
  level, monotonically, and `x N` reaches 1.1e7. The client's own transform
  has since been read -- a `1/320`-normalised FFT whose `x 320` cancels it,
  leaving the magnitude of a direct DFT -- which is exactly what this build
  computes. `c0` is right.

What is left is not a dependency but a **constant**: the median frame comes out
at 0.27 of what went in, and a post-filter should be near 1. That is a single
number and a much smaller question than the one this section opened with.

### What the slot holds now

Zero, which is not the same as being sure. The model has 21 input channels per
tap where pooling gives 20, and the reference's
`env_dim = frame_size // avg_pool_k + 1` says the twenty-first is real rather
than padding, so something belongs there. Zero is the neutral value for a
demeaned feature. **Grade: measured** that it is not the absolute mean;
**unresolved** what it is.

## The weight-norm oracle, and what it says about every feature

A trained layer scales each input's weights against how large that input
typically is, so `|x_i| * ||W[i]||` is roughly constant across `i`. That is a
heuristic, not a law, so it was calibrated before it was used: on three slices
whose construction is independent of each other it lands at 0.6x to 1.2x.

Measured on the real decode against `fnet_conv1`, the first layer, which reads
the 165-wide vector directly and so cannot have the error diluted by anything
upstream:

Measured over the 300 active sub-frames of the real decode, as median `|x|`
times the slot's weight norm, against the clean spectrum:

| slice | median `|x|` | `\|\|W\|\|` | contribution | against the clean spectrum |
| --- | --- | --- | --- | --- |
| `[0:64]` clean spectrum | 0.161 | 1.3103 | 0.2106 | 1.0x |
| `[64]` cepstrum `c0` | 13.614 | 0.5908 | **8.0433** | **38x** |
| `[65:82]` cepstrum `c1..c17` | 0.190 | 1.1921 | 0.2263 | 1.1x |
| `[82:87]` autocorrelation | 0.291 | 2.4402 | 0.7110 | 3.4x |
| `[87:92]` LTP and the three lags | 0.773 | 2.1126 | 1.6341 | 7.8x |
| `[92]` last slot | 0.000 | 0.6874 | 0.0000 | dead |
| `[93:157]` pitch embedding | 0.427 | 0.4890 | 0.2086 | 1.0x |
| `[157:165]` bit-count embedding | 0.744 | 0.6631 | 0.4935 | 2.3x |

Three slices of independent construction land at 1.0x, 1.1x and 1.0x, which is
what calibrates the baseline. `c0` at 38x is the outlier and nothing else
reaches 8x.

**This is the same finding as "the hypothesis that `c0` is spurious is
withdrawn" above, not a new one.** That section put `c0`'s contribution at
sixteen times the clean spectrum's and the needed correction at a factor of
four; the difference from 38x is that it took feature *rms* where this takes
the median, and rms weights the clean spectrum's tails. The conclusion there
stands and is not reopened here: the network was trained on a `c0` of roughly
this shape and compensates for it with the second-smallest weights of any
group. What is at issue is only how far that compensation goes.

Within the cepstrum the excess is concentrated and then gone: 37x, 15x, 7.1x,
4.4x, and by `c6` it is 1.9x and by `c10` 1.1x. That is the signature of a
smooth ramp across the log-band energies, not of a level offset, which would
land on `c0` alone.

**Grade: measured, and the inference from it is Inferred.** The oracle says
`c0` is out of family. It does not say what the right transform is.

## Three candidates for `c0`, all refuted

`c0` is the log of the decoded signal's absolute level, so it is the same
class of defect as the envelope's mean and it is what leaves the residual
1.67x in the scale sweep. Three fixes were tried and none survived.

**The filterbank sums where this averages.** `companion_noisy_weights` is
exactly `1/width_b`, so each band is a mean per bin; the reference's
`compute_band_energy` sums with no division. The difference is `ln(width_b)`,
a smooth ramp of 1.39 to 3.18 nats across the bands -- the exact shape the
signature calls for. Removing the normalisation improves `c0` from 37x to
14.5x and **worsens** `c1` (15.3 to 21.8), `c6` (1.9 to 3.4) and `c10` (1.1 to
3.2). Two metrics pulling apart, so refuted.

**The reference's floor follower.** LPCNet limits the log-band range to eight
decades below the running maximum and a fall of 2.5 decades per band.
Measured here, the within-frame range is **1.3 decades** and no band reaches
the floor, so the follower would never fire. Refuted.

**The codec's own gain as the reference level.** If the signal were divided by
a gain `g` before the transform, `c0` would fall by `4.243 * ln(g)`. Over 300
active sub-frames `c0` against `ln(gain)` correlates **-0.331** with slope
**-0.455**, against the +4.243 the hypothesis requires, and removing the
fitted line leaves 5.662 of `c0`'s 6.001 deviation. Refuted.

That measurement did identify something else: `features_gain.f32` ranges
`[0.00, 77.71]`, which is `nrgres`'s range from the table above. The dump has
been carrying the residual energy under the name `gain` the whole time, and
the harness converts it as though it were decibels.

## Four features were pinned while every level above was measured

`state->lag_context` and `state->side_index` are never written by the harness,
so slots `[89:92]` were constants throughout: with a zero lag,
`log10(32) = 1.5051` through the three affine steps gives exactly **5.205,
3.080, 0.773**, which is what the dumps show in every frame of both signals,
and slot `[92]` is **0**.

Feeding those slots from the dump moves real speech materially -- at the
median frame, 0.474 unfilled against 0.270 with the dump's lags and 0.177 with
its residual energy -- and leaves the tone alone, its lags being unvoiced. So
the pinning bounded the precision of every level measured here, and did not
bound the conclusion.

Slot 89 carries the **largest weight norm in the whole model**, 3.5439 against
a vector median of 1.2967, and its contribution to the first layer's output is
the single largest of the 165. So every level measured before this was measured
with the model's most heavily weighted input pinned at a constant.

Even fed, the feature barely moves. Under the settled reading -- three of the
eight pitch lags -- `x * 0.5 + 32` spans 32 to 192, so `log10` spans 1.505 to
2.283 and slot 89 spans `[5.205, 5.983]`: a swing of 0.78 riding on 5.6. The
offset is seven times the variation, and it reaches the model's largest weight
norm, where `fnet_conv1`'s whole bias vector has rms 0.144. A constant that
large cannot have been absorbed by that bias during training.

So either the affine steps are not additive offsets, or `fnet_conv1` is meant
to run with that channel pinned. The first is not something to guess at: the
steps `+3.7`, `x0.769+1.923` and `x0.286+0.343` are *measured* from the client,
and this file's standing rule is that a measured value beats an inference.
Reading their sign and their side in the binary would settle it.

**Grade: measured** that the slots were pinned in the harness and that the
transform leaves a large offset over a small swing. **Open** whether that is
wrong.

## What the container settles, so it need not be asked again

Read from the chunk table and the weights, not from any forward pass:

- **Every weight chunk is exactly `in * out`.** No layer is padded, including
  `alpha1_t` at 42 inputs, which is not a multiple of the SIMD input group of
  4 and so would have to be padded to 44 if it were blocked. It is not
  blocked: it is float.
- **`alpha1_f` is int8 and blocked; `alpha1_t` and `alpha2` are float and
  `[in][out]`.** The loader applies blocking only on the int8 path, so the two
  cannot cross. A peer's reading that they had been crossed is ruled out here.
- **The two-tap input is blocked, not interleaved.** Under the blocked reading
  the three shaping layers give tap-energy ratios of 3.50x, 1.69x and 3.25x,
  the current tap dominating as a causal conv does. Under interleaving they
  give 1.12x, 1.02x and 1.20x -- statistically identical halves, which is what
  mixing both taps into each half produces. The blocked reading finds
  structure; the interleaved one finds none.
- **`alpha2`'s bias is the only smooth one in the model.** Its roughness
  between neighbouring channels is 0.603 where every other layer sits between
  1.257 and 1.985, i.e. white. That matches its weight columns, which
  correlate 0.637 between neighbours. Two independent properties of the same
  layer agreeing is a check on the reading of both.
- **`alpha2` is not diagonal.** Neither it nor `alpha1_t` maps input channel
  `i` to output `i` or to `4i`; the peak positions scatter at 30 to 31
  samples where random gives 27. The hidden is a learned dense mapping with no
  time locality, so arguments that assume locality do not apply.

## `c0`: what the level does to the output, and one convergence worth keeping

The refutation of "normalise the windowed signal before the transform", above,
was measured while the envelope's mean still dominated everything, so it was
void. Retested with the mean gone:

| | `c0` | level ratio | across a 64x input sweep |
| --- | --- | --- | --- |
| as built | -13.614 | 0.4256 | 12.47 down to 3.813 |
| windowed signal normalised to unit rms | **+10.080** | 7.26e5 | 7.26e5 to 6.80e5, flat |
| `c0` forced to zero | 0 | 0.1728 | 1.11x, flat |

Normalising buys perfect equivariance and costs six orders of level, because
it does not land `c0` near zero -- it **overshoots to +10.1**. A unit-rms
signal through a 320-point unnormalised transform puts the band magnitudes
around 10, not around 1. `c1` through `c3` do not move at all, which is the
check that the operation did what it claims: a scale change lands on `c0`
alone.

So refuted again, and for a different reason than before. Kept because the
three rows together give the shape of the network's response to `c0`, which
nothing else here measures:

    c0 = -13.6  ->  0.43        c0 = 0  ->  0.17        c0 = +10.1  ->  7.3e5

Monotone and violently non-linear. Two and a half times across the first
fourteen units and four million across the next ten. **This is why `c0` must
not be guessed at.** Any wrong value in the upper half of that range is not a
little wrong.

### The convergence

Both level-bearing features imply the same thing about the signal's scale, and
they are independent of each other -- one is the pooled magnitude in the time
domain, the other the mean log band energy in the frequency domain:

| feature | as measured | where the weights put it | signal scale that would do it |
| --- | --- | --- | --- |
| envelope mean `mu` | -5.18 | about -1.2 | **53.5x** |
| cepstrum `c0` | -13.614 | about 0.36 | **26.9x** |

Same order, from different domains, on a quantity neither was fitted to.

**It is not evidence for restoring the mean.** No signal scale makes that path
equivariant: the 64x sweep is a sweep of exactly this scale, and the ratio
moved by 4.4e8 across it. A constant offset cannot fix a dependency.

**And it conflicts with the floor.** The envelope's log floor is `2^-16`, half
an int16 LSB, which belongs to a scale of 32768x rather than 30x or 50x. Two
readings of the same question disagreeing by three orders is a reason to
measure, not to pick.

**Grade: measured** that the two features converge on 27x to 54x.
**Unresolved**, and not to be acted on: the factor of two between them is
wide, the floor points elsewhere, and the response curve above means a wrong
choice is expensive.

## The level, accounted for end to end

Two gain stages, both sitting low, and together they are the whole of what is
left. Measured at the median frame of a real decode:

| | level ratio |
| --- | --- |
| as built | 0.2695 |
| shaping gain forced to 1 | 0.3125 |
| `af4` gain forced to 1 | 0.7859 |
| **both forced to 1** | **0.8819** |

`af4` carries 2.92x of it and the shaping 1.16x, and with both at unity the
output lands within 12% of its input. Nothing else is missing: the level
question, which has run through this entire file, is now two named stages and a
remainder of 0.88.

The shaping's exponent, which used to sit at a median of 2.500 (a gain of
12.2), now reads:

| | exponent | gain |
| --- | --- | --- |
| p1 | -6.405 | 0.0017 |
| p10 | -4.392 | 0.0124 |
| **p50** | **-1.901** | **0.1495** |
| p90 | 0.086 | 1.089 |
| p99 | 1.718 | 5.572 |

Still displaced, but downward now and by two units rather than upward by four
orders. Its bias is +0.105, so the displacement is in `W . h`.

### A clamp on that exponent: the earlier measurement is void, and so is its conclusion

That section measured every clamp against a build running 1.9e17, and concluded
that "something bounding the exponent is missing" because an unbounded `exp`
of a value that wide cannot produce a sane output. The value is no longer that
wide. The conclusion was sound against its evidence and does not survive it.

### The crest is not the shaping's

Forcing the shaping gain to 1 makes the tone's crest **worse**, 2.80 to 3.22,
so the shaping is reducing crest rather than causing it. What is left comes
from the adaptive filters, which are re-predicted every sub-frame: a
time-*invariant* FIR on a sine emits a sine, and these are time-varying.

## The kernel cross-fade, measured for the first time

`COMPANION_KERNEL_OVERLAP` was defined unconditionally, so
`-DCOMPANION_KERNEL_OVERLAP=n` was silently ignored and a sweep of four values
ran the same value four times. It is guarded now, and the sweep is real:

| cross-fade | tone crest | level p50 | `d` |
| --- | --- | --- | --- |
| 0 samples | 2.95 | 0.2679 | 0.92 |
| 5 | 2.85 | 0.2781 | 0.91 |
| **15 (what the client uses)** | **2.80** | 0.2695 | 0.91 |
| 30 | 2.90 | 0.2327 | 0.91 |
| 40 | 2.92 | 0.2291 | 0.91 |

A shallow minimum at exactly the measured value, from a metric that had nothing
to do with how it was measured. That is a confirmation rather than a fit, and
it is the only one of these constants that has ever been checked twice.

It does not explain the crest: 2.80 against 2.95 with no fade at all is a small
effect, and the target is 1.414.

## The crest is not distortion, it is level modulation between sub-frames

Measured per sub-frame on the tone, which is what the whole-file figure of 2.80
was hiding:

| stage | crest | rms against the block in |
| --- | --- | --- |
| input block | **1.436** | 1.0000 |
| `af1` out, channel 0 | 1.556 | 1.5423 |
| `af1` out, channel 1 | 1.604 | 0.1735 |
| after the shaping | 4.117 | 0.0379 |
| **`af4` out** | **1.577** | 0.1671 |

A sine is 1.414. The input block is 1.436 and the output is **1.577** — the
filter barely distorts the waveform inside a sub-frame, and the shaping's 4.117
is pulled back by `af4` rather than surviving into the output.

So the 2.80 measured over the whole file is not waveform distortion. It is the
output's *level* moving between sub-frames while the input's does not:

| stage | p10 | p50 | p90 | p90/p10 |
| --- | --- | --- | --- | --- |
| input block | 1.0000 | 1.0000 | 1.0000 | 1.00x |
| `af1` out, channel 0 | 1.0019 | 1.5426 | 2.5358 | **2.53x** |
| `af1` out, channel 1 | 0.0524 | 0.1735 | 0.5135 | 9.80x |
| after the shaping | 0.0027 | 0.0379 | 0.0631 | 23.41x |
| `af4` out | 0.1059 | 0.1671 | 0.2707 | **2.56x** |

The tone's own level varies by 1.07x across sub-frames, so the input is
stationary to within 7%, and the first stage already answers it with 2.53x.
That is the same property the tone was brought in to test: **a stationary input
must give a stationary output**, and this one does not.

Where it comes from, measured on the same signal:

| gain | p10 | p50 | p90 | p90/p10 | at the floor |
| --- | --- | --- | --- | --- | --- |
| `af1` channel 0 | 1.2795 | 1.4243 | 2.0278 | 1.58x | 0.0% |
| `af1` channel 1 | 0.2512 | 0.2610 | 0.3715 | 1.48x | 44.7% |
| **`af4`** | 0.2512 | **0.2512** | 0.3768 | 1.50x | **80.4%** |

Two things. `af4`'s gain is at the floor of its own span in **80%** of
sub-frames here against 67% on speech, so the pinning is worse on the signal
that should drive it least. And channel 0's *output* moves 2.53x where its gain
moves only 1.58x, so the rest is the kernel's shape: it is L2-normalised, so
its energy is fixed, but its response at the tone's one frequency is not, and
a re-predicted shape changes that response every sub-frame.

**What this does not establish.** Whether the client's kernel moves as much is
not knowable from here — a re-predicted filter is *supposed* to move, and only
a reference pair says how much is right. What is established is that the crest
this work has been chasing is not a distortion mechanism at all, so the
hypotheses aimed at one (the exponent clamp, the cross-fade, the tap order)
were aimed at the wrong thing.

Two experiments that came out backwards, and are recorded because they rule
things out:

- **Freezing the kernel** after the first sub-frame makes the tone's crest
  *worse*, 2.80 to 6.50. A filter frozen at an arbitrary prediction is not the
  same as a correct time-invariant one, so this does not say adaptation helps;
  it says kernel *switching* is not the mechanism.
- **Forcing the shaping gain to 1** also makes it worse, 2.80 to 3.22, because
  it leaves channel 1 nearly five times louder going into `af4` and changes the
  mix rather than removing a distortion.

## The gain centre was an unmarked assumption, and it cannot be measured from here

`COMPANION_GAIN_CENTRE` sat at `0.0f` with no comment, no guard and no grade,
two lines under a span that carries all three. The gain is
`exp(SPAN * tanh(.) + CENTRE)`, so together they are the decibel limits: the
span was read from the client, the centre was taken from the reference's
symmetric pair and never confirmed. An asymmetric pair puts it off zero, and
`af4` spending two thirds of its sub-frames against the floor is what a wrong
centre would look like.

Swept, on the real decode:

| centre | `af1` gain p50 | `af4` gain p50 | level p50 | tone crest |
| --- | --- | --- | --- | --- |
| **0.0 (as built)** | 1.4441 | 0.2581 | 0.2695 | 2.80 |
| 0.35 | 2.0493 | 0.3663 | 0.5426 | 2.80 |
| 0.69 | 2.8791 | 0.5146 | **1.0711** | 2.80 |
| 1.0 | 3.9254 | 0.7016 | 1.9911 | 2.80 |
| 1.3815 | 5.7487 | 1.0275 | 4.2703 | 2.80 |

**0.69 lands the level at 1.07, and that is worth nothing.** The centre is a
multiplier on every gain in the chain, so it moves the level *by construction*
-- no level measurement can identify it, and choosing it by one would be
fitting the single number it is defined to control. The crest column says the
same thing from the other side: it does not move at all, because a uniform
scale cannot change a crest.

Two things the sweep does establish. A centre that fixes `af4` takes `af1` from
a healthy 1.44 to 2.88, and at 1.3815 to 5.75 -- past the 3.9811 ceiling the
span is supposed to impose, which means the nominal range stops holding. So if
the centre is the answer it is **per-stage**, not global. And the level being
this sensitive to it is why it needs reading rather than guessing.

Marked as assumed where it is defined, and guarded so a build can sweep it,
which it could not before.

## The three slots, identified, and the container audit that eliminated a rival

A read of the client's decoder names all three. They are three distinct fields
of its per-frame struct, one float per sub-frame each, all three linear -- the
`(10 * log10(E) + offset) / divisor` belongs to the feature extractor, not to
what fills them:

| slot | field | what it is |
| --- | --- | --- |
| `[89]` | `+0x30` | the codebook gain, a linear amplitude |
| `[90]` | `+0x20` | the energy realised, `sum(exc[n]^2)` over the sub-frame's 80 samples |
| `[91]` | `+0x174` | the energy aimed at, with the length already in it |

Two of them are in the dump already. `reslpc.f32` carries 80 floats per
sub-frame, which is the excitation sample by sample, and `features_gain.f32`
carries one per sub-frame over `[0, 77.7]`, which is the target energy. Fed:

| `decode_context` | `af1` gain p50 | `af4` gain p50 | `af4` at the floor | level p50 | `d` |
| --- | --- | --- | --- | --- | --- |
| zeroed, as the harness had it | 1.1852 | 0.3106 | 32.6% | 0.4739 | 0.73 |
| **slots 90 and 91, per sub-frame** | 1.1542 | **0.3871** | **25.1%** | 0.3264 | 0.75 |

The pinning falls and the gain rises. What makes this corroboration rather
than a coincidence is the comparison with the wrong guesses on the same slots:
three pitch lags gave 53.8% pinned and the residual energy in all three gave
62.5%, both **worse** than leaving them at zero. The identified quantities move
it the other way.

Slot 89 stays at zero and it reaches the largest weight norm in the model. The
codebook gain is in no file of this dump under any name, and it cannot be
recovered by ratio: `exclpc_dec.f32` holds three times the residual's samples,
and under either layout its components correlate with `reslpc.f32` at -0.010,
-0.001, +0.005 (concatenated) or +0.146, +0.012, +0.002 (interleaved). None is
a scaled copy. Getting it means regenerating the dump from a native codec build
and repurposing `features_offset`, which is the mechanism AGENTS.md describes.

The struct now holds them per sub-frame. It held three floats for the whole
frame, which the client's layout contradicts and which was inconsistent with
`lpc`, `lag`, `ltp` and `gain` besides -- there was nowhere to put the other
three quarters of the values.

### Every chunk in the container is read

A rival explanation for `af4`'s gain was that its descriptor carries something
the loader ignores -- an output scale, or an int8 `subias` being applied where
it should not be. Enumerated directly rather than by searching for names the
loader already knows, the container holds **48 chunks**:

| suffix | count |
| --- | --- |
| `_weights_int8` | 9 |
| `_scale` | 9 |
| `_subias` | 9 |
| `_weights_float` | 6 |
| `_bias` | 15 |

Nine int8 layers at four chunks each and six float layers at two is 48 exactly.
Nothing extra, nothing ignored.

The chunk header carries one field the loader never reads, at offset 4. It is
`1` in all 48 -- a version, not a per-layer scale. `dtype` is 0 for float and 3
for int8 and nothing else appears. So there is no room in this container for an
output scale that the loader is missing. `af1_gain` and `af4_gain` are float and carry
two chunks each -- no scale, no subias -- and the loader's `subias` handling is
inside the int8 branch, so it cannot reach them. Whatever makes `af4` saturate,
it is not something the loader is failing to read.

## The dump was writing two of the three slots added together

`features_gain.f32` is not a gain. Read from the codec that writes it,
`smpl/smpl_core_decoder.c`:

    float tot_gain = gain_tab[lb_params.fcbg_idx[sf]] + lb_params.nrgres[sf];
    fwrite(&tot_gain, sizeof(float), 1, dec_state->fp_features_gain);

It is the **sum** of the codebook gain and the residual energy -- the two
quantities slots `[89]` and `[91]` want separately. Every measurement that fed
it as one number was feeding a sum, and the `[0, 77.7]` range this file has
quoted for `nrgres` since the beginning is the sum's range.

Separated by giving the pair to `features_offset`, which the same file writes
as zeros and which AGENTS.md already nominated for exactly this:

    int rep_o = toc->low_rate ? 2 : 1;
    CelpTables* pTblO = (CelpTables*)g_smpl_celp_tables;
    float* gtab_o = lb_params.voiced ? pTblO->fcbgains_v : pTblO->fcbgains_uv;
    for (int sf = 0; sf < num_subframes; sf++)
        for (int r = 0; r < rep_o; r++) {
            float pair[2];
            pair[0] = gtab_o[lb_params.fcbg_idx[sf]];
            pair[1] = lb_params.nrgres[sf];
            fwrite(pair, sizeof(float), 2, dec_state->fp_features_offset);
        }

Built natively with `cmake -G Ninja -DCMAKE_C_FLAGS=-DSMPL_DUMP_FEATURES=1`
against the pinned source; the existing `.cache` build is WebAssembly and
cannot run a dump. The two come back as:

| | min | p50 | max |
| --- | --- | --- | --- |
| codebook gain | 0.00003 | 0.00011 | 0.0631 |
| `nrgres` | 0.00000 | 0.08348 | 77.6807 |
| their sum, which is what the dump gave before | 0.00003 | 0.10334 | 77.7088 |

Their sum reproduces `features_gain.f32` to 3.5e-6, which is float precision,
and the two ranges are the `[0, 0.06]` and `[0, 77.7]` this file measured for
them separately long ago -- from a decode, not from the container, so this is
two routes agreeing rather than one being restated.

### The affine steps say which slot takes which, and agree with the client

Each step is `slope * log10(E) + intercept`, so it centres its feature when
`log10(E)` sits at `-(intercept/slope)`. That is a property of the constants,
measured from the client, and it needs no forward pass:

| slot | step | centres at `log10(E)` = |
| --- | --- | --- |
| `[89]` | `log10(E) + 3.7` | **-3.70** |
| `[90]` | `0.769 log10(E) + 1.923` | **-2.50** |
| `[91]` | `0.286 log10(E) + 0.343` | **-1.20** |

Against the decode:

| quantity | p50 | `log10` p50 | centres |
| --- | --- | --- | --- |
| codebook gain | 0.000112 | **-3.95** | slot 89 |
| `nrgres` | 0.083479 | **-1.08** | slot 91 |

Two independent routes -- the disassembly and the arithmetic of the constants
-- put the same two quantities in the same two slots. That is the first time
anything about these slots has been confirmed twice.

**Slot 90 is not confirmed.** Nothing in the dump centres at -2.50: the
excitation's per-sub-frame energy lands at -3.86 from `reslpc.f32` and between
-4.19 and -4.99 from each reading of `exclpc_dec.f32`, so every candidate is a
factor of 25 to 250 too small. Either the client's `exc` is a signal this dump
does not carry, or the centring argument does not hold for this slot. It held
for the other two, which is what makes the gap worth stating rather than
papering over.

### Feeding them does not fix `af4`, and that is itself informative

| fields fed | `af1` gain p50 | `af4` gain p50 | `af4` at the floor | level p50 | `d` |
| --- | --- | --- | --- | --- | --- |
| none | 1.1852 | 0.3106 | 32.6% | 0.4739 | 0.73 |
| slot 89 only | 1.1640 | 0.2689 | 44.5% | 0.4661 | 0.77 |
| slot 90 only | 1.1371 | 0.3143 | 35.0% | 0.4404 | 0.71 |
| **slot 91 only** | 1.1825 | **0.3931** | **22.5%** | 0.3778 | 0.75 |
| slots 90 and 91 | 1.1527 | 0.3939 | 24.3% | 0.3245 | 0.76 |
| all three, as identified | 1.1283 | 0.3013 | 35.1% | 0.3027 | 0.76 |

Slot 91 alone does best and the identified set does worse than it. **The
identified set is what goes in**, because it is what the client reads and the
constants independently agree; picking the row that minimises a number is the
curve-fitting this file exists to refuse, and the number in question is a
symptom of a different layer.

Which is the informative part: if `af4`'s pinning were caused by the features,
feeding them correctly would relieve it. It does not. That leaves the layer's
own weights -- column norm 5.135 against 1.25 to 2.34 everywhere else -- and
the container audit has already shown the loader reads every chunk there is.

## Every int8 layer was running with twice its bias

`subias` is not the zero point negated. Measured against the container across
**all 2224 output channels of the nine int8 layers**, `zero_point + subias`
reproduces the `_bias` chunk to a worst relative error of **4.5e-06**, which is
float precision:

| layer | channels | max abs difference | bias rms | relative |
| --- | --- | --- | --- | --- |
| `fnet_conv2` | 160 | 2.7e-07 | 0.06011 | 4.5e-06 |
| `fnet_tconv` | 640 | 1.4e-07 | 0.05813 | 2.4e-06 |
| `fnet_gru_input` | 480 | 2.3e-07 | 0.09312 | 2.5e-06 |
| `fnet_gru_recurrent` | 480 | 2.3e-07 | 0.10857 | 2.1e-06 |
| `af1_kernel` | 32 | 1.2e-07 | 0.09509 | 1.2e-06 |
| `af4_kernel` | 32 | 2.2e-07 | 0.11295 | 1.9e-06 |
| `tdshape1_alpha1_f` | 80 | 1.2e-07 | 0.08238 | 1.4e-06 |
| `ft1` | 160 | 2.2e-07 | 0.11447 | 1.9e-06 |
| `ft2` | 160 | 2.0e-07 | 0.15885 | 1.2e-06 |

So `subias = bias - zero_point`, and `bias[o] += zero_point + subias` was
adding the bias to itself.

### The arithmetic says the same thing, and says which one to keep

The client quantises its input as `q = round(127x) + 127` and accumulates
against the stored weights. Expanding the `+127`:

    accumulator * scale = (w . x) + 127 * scale * sum(q) + stored
                        = (w . x) + zero_point + stored

The zero point has to be cancelled, and `subias` is what cancels it *and*
carries the bias in one number: `(w . x) + zero_point + (bias - zero_point)`
lands on `(w . x) + bias`. So the client reads `_subias` on the int8 path and
never reads `_bias` there; `_bias` is for a runtime that does not reconstruct
the zero point.

The two chunks are the same number by two routes, so either would do. This
takes the route through the weights, because that is the one that exercises the
layout: get the SIMD blocking wrong and `zero_point` changes, and the agreement
with `_bias` stops holding. It is a free check on the layout every time the
model loads.

### What it changes, and what it uncovers

On a real decode, at the median frame, the level goes **0.3027 to 1.4342** --
across unity rather than a third of it.

The equivariance goes the other way, from a slope of 0.76 to **0.41**, and the
reason is worth more than either number: the doubled bias was **partly
cancelling** `c0`'s level dependence. Two errors compensating is exactly what
keeps a wrong build looking plausible, and it is why a change verified against
the container rather than against a metric is the only kind that can be trusted
here. This one is arithmetic, not judgement.

With the bias right, `c0` carries the whole of what is left:

| | @0.125 | @1 | @8 | `d` |
| --- | --- | --- | --- | --- |
| as built | 4.6073 | **1.4342** | 0.3923 | **0.41** |
| `c0` zeroed | 0.2673 | 0.2888 | 0.2827 | **1.01** |

`c0` supplies both the level and the level-dependence: without it the filter is
equivariant to 1% and three and a half times too quiet; with it the level is
right at one input scale and wrong at every other. That is the shape of a
feature whose *form* is right and whose scale or offset is not -- and the
client's transform for it has been read off the disassembly and matches this
build exactly, which is the part that does not fit yet.

## `af4`'s gain was never the bug, and the doubled bias is why it looked like one

Read from the client's loader and its matmul: **there is no output scale on the
gain convolutions.** The loader passes a scale name of `0` for them, so the
descriptor's `out_scale` field is left zeroed rather than filled, and only the
*kernel* convolutions carry a `_kernel_scale`. The matmul sends the gain-conv
down its float path, `sum(w . ctrl) + bias`, which never reads that field at
all -- `out_scale` exists only on the int8 branch. The formula is identical for
`af1` channel 0, `af1` channel 1 and `af4`, and only the weights differ.

So a median gain near 0.30 is what this layer is built to produce. Forcing it
to 1 moved the level because over-amplifying moves the level, not because it
corrected anything: that measurement was a symptom, and reading it as a cause
cost a detour.

The cause was the doubled bias in the section above, and the two results
converge cleanly. Fixing the bias takes the median frame from 0.3027 to 1.4342
while leaving `af4`'s gain at 0.2722 -- essentially where it was. The level
came back with the gains untouched, which is what the client's reading says has
to happen.

## Sweep the input through the codec, not past it

Every scale sweep in this file until now scaled the **decoded signal** and left
the decoder's features where they were. That is not a quieter call. It is a
quiet signal presented with the loud signal's LPC, gains and energies, and the
network answers the mismatch.

Done properly -- re-encoding and re-decoding at each amplitude, so every
feature tracks the signal -- over a 16x range, unclipped:

| input amplitude | level ratio, median frame |
| --- | --- |
| 0.125 | 1.3241 |
| 0.25 | 1.4230 |
| 0.5 | 1.4695 |
| 1 | 1.4342 |
| 2 | 1.4076 |

**Spread 1.11x, slope 1.02.** The filter is scale-equivariant. The 0.41 that
the desynchronised sweep reported, and `c0` "carrying the level dependence",
were both measuring the mismatch rather than the filter.

### The envelope mean survives this, by seven orders

The obvious worry is that the defect this file opens with was found the same
wrong way. It was not. The envelope's mean is a *direct* path from the signal
to the gain, not a feature that can fall out of step with one, so a real
quieter call moves it just as much. Re-measured on the same consistent sweep:

| input amplitude | with the mean restored |
| --- | --- |
| 0.125 | 2.517e15 |
| 0.5 | 5.204e11 |
| 1 | 7.912e09 |
| 2 | 9.020e07 |

Spread **2.8e7** over 16x, slope **-5.18**, against 1.11x and 1.02 without it.
The fix stands, and now stands on a sweep that cannot be accused of this.

### What this leaves

A constant. The median frame comes out at **1.43** of its input at every level,
where a post-filter belongs near 1. That is 43%, on one synthetic speech
signal, and it is the whole of the remaining disagreement.

### The unit test measures the weaker property

`companion_test.c` cannot re-encode -- it has no codec -- so its two passes
scale a synthetic signal against a fixed synthetic state, which is exactly the
desynchronised sweep. What it guards is therefore "the response to a
signal/feature mismatch does not explode", not equivariance. That is still
worth guarding: restoring the envelope mean takes it to ten orders. But its
bound must not be read as a measurement of the filter, and tightening it would
pin the suite to an artefact.

## What is left is a tail, not a constant, and the level figures were always measuring it

The "constant of 1.43" was the median of per-frame ratios over a signal that is
mostly silence -- the synthesiser alternates voiced and unvoiced every 25
frames, so 142 of its 195 frames are quiet and a near-silent frame divides by
almost nothing. Restricted to frames carrying speech, the distribution is not a
constant at all:

| percentile of the per-frame ratio, active frames | |
| --- | --- |
| p5 | 0.027 |
| p25 | 0.054 |
| **p50** | **0.207** |
| p75 | 1.92 |
| p90 | 4.61 |
| p95 | 8.79 |
| **p100** | **1.714e5** |

Three of 61 active frames come out more than ten times their input, and the
worst comes out **171 thousand** times it. That is not a gain error. A
post-filter that multiplies a frame by 1.7e5 is unstable on that frame.

It also explains the whole history of this file. The aggregate level ratio is
a sum of squares, so it is dominated by those frames: 24319 by energy against
0.207 at the median, a factor of 1e5 between two honest statistics of the same
data. **Every level figure in this work, including every one measured today,
was a reading of this tail.**

### It is the shaping exponent's tail

Per frame, the ratio correlates with the largest exponent the shaping produces
at **+0.886** in the log. The worst frame's exponent reaches 20.570, which is a
gain of 8.6e8.

Pooled over 64000 samples of real speech, with the bias fixed:

| | exponent | gain |
| --- | --- | --- |
| p0.01 | -7.804 | 0.0004 |
| p1 | -5.856 | 0.0029 |
| p50 | -1.528 | 0.217 |
| p90 | +1.432 | 4.19 |
| p99 | +4.095 | 60.0 |
| p99.9 | +7.818 | 2485 |
| p99.99 | +11.826 | 1.37e5 |
| **p100** | **+20.570** | **8.58e8** |

### Two candidates for the tail, both refuted

**It is not the envelope's log floor.** The obvious mechanism is a pooled block
of near-silence falling onto `2^-16` at a speech onset while its neighbours sit
near -2, which would make the demeaned deviations span nine. Measured, they do
not: the deviations run from **-4.569 at p0 to +4.124 at p100**, and
`ln(2^-16)` is -11.09. The floor is never reached, so it is not creating this.

**It is not the `af4` kernel's normalisation scope.** `1.43 ~ sqrt(2)` pointed
at whether the single output channel of a 1x2x16 kernel is normalised over 16
coefficients or 32, and the client's loop sums over `in_channels * taps` per
*output* channel -- 32 for `af4`, 16 for each of `af1`'s two. This code already
computes `per_channel = in_channels * taps`, so it has been doing exactly that.
The constant the lead was chasing was a silence artefact besides.

Where it does come from, by how much each stage multiplies its own p99:

| stage | p50 | p99 | p99.9 | p100 | p100/p99 |
| --- | --- | --- | --- | --- | --- |
| `alpha1_f`, the feature branch | -0.150 | 2.986 | 3.668 | 4.598 | **1.54** |
| `alpha1_t`, the envelope branch | -0.010 | 1.957 | 3.227 | 8.883 | **4.54** |
| `h`, their sum | -0.130 | 3.631 | 5.111 | 10.516 | 2.90 |
| the exponent | -1.528 | 4.095 | 7.818 | 20.570 | **5.02** |

The feature branch is well behaved. The tail is made in `alpha1_t` and again in
`alpha2`, and it is those two that need explaining.

**And it is not a transient in the envelope either.** The natural reading of a
tail in the envelope branch is that a level jump between sub-frames drives it:
`alpha1_t` reads `[previous envelope, current envelope]`, so a silence-to-onset
boundary presents it with two very different halves. Measured over 800
sub-frames, the largest deviation change between the two halves correlates with
the largest exponent at **+0.119** -- nothing. The worst frame, at an exponent
of 20.570, has a jump of 4.292; a frame with a jump of 3.274 has an exponent of
1.185.

So three mechanisms for the tail are refuted: the log floor, the normalisation
scope, and the inter-sub-frame transient. Both layers that make it are float,
read raw from the container, with layouts confirmed independently -- `alpha2`
by its neighbouring columns correlating 0.6373 against the client's 0.637, and
`alpha1_t` by a tap asymmetry of 3.50x that only the correct reading finds. So
either the client bounds one of their outputs, or its `h` is narrower than this
one's for a reason not yet found.

### What the tail costs once the output is int16

The client converts to int16 in its last stage, which clips. A frame with a
gain of 8.6e8 does not come out 8.6e8 times louder there -- it saturates. So
the question is not how the client survives an exponent of 20.6; it is how much
of the signal it destroys. Measured on the same active frames, clipping the
output at +/-1:

| | raw ratio | clipped ratio | samples saturated |
| --- | --- | --- | --- |
| p50 | 0.207 | 0.207 | 0.0% |
| p90 | 4.61 | 2.53 | 2.5% |
| p95 | 8.79 | 3.40 | 4.1% |
| p100 | 1.714e5 | **3.52** | **18.4%** |

**26% of active frames saturate something**, and the worst saturates 18% of its
samples. Clipping turns a level error of 1.7e5 into audible distortion rather
than removing it, and the clipped level still spans 0.21 to 3.52 across frames
where a post-filter belongs near 1.

That is the defect stated in the terms the client would experience it: not one
frame a hundred thousand times too loud, but a quarter of voiced frames
clipping.

### Which un-retires a refutation, by the same mistake in reverse

Earlier today this file retired "something bounding the exponent is missing" on
the grounds that the exponent was no longer wide -- its median had gone from
+2.5 to -1.9 and its p99 read 1.7. Both were true. Both were the wrong
statistic: what `exp` responds to is the top hundredth of a percent, and that
reaches 20.6.

It is the same error as reading a level from an aggregate, turned around. There
the tail was mistaken for the centre; here the centre was mistaken for the
whole. The rule that covers both is narrower than "prefer the median": **match
the statistic to the non-linearity downstream of it.** A ratio of energies
answers to squares, so it follows the tail; a gain that is exponentiated
answers to the tail too; a median answers to neither.

**So the open question is what bounds this in the client**, and the earlier
clamp measurements cannot answer it: they were made against a build running
sixteen orders too loud, and choosing a clamp by which number it improves is
the fitting this file refuses. What is needed is whether the client clamps the
`alpha2` output, or the `tanh` before it, and at what value.

## The oracle this work never used: the clean signal

The dump writes `clean.s16`, what went into the encoder, beside `coded.s16`,
what came out of the decoder. A post-filter's job is to move the second towards
the first. That is checkable here and needs no client, and **no level ratio can
say it**: a filter can land any level you like while destroying the signal.

Measured over a real decode, aligned by cross-correlation and clipped at
`+/-1` as the client's int16 stage would:

| | distance from clean, dB |
| --- | --- |
| decoded, unfiltered | **+2.45** |
| after the Companion | -5.01 |
| with the envelope mean restored | **-22.01** |
| with the bias doubled | -1.09 |
| with the exponent clamped at 4 | -1.00 |

Three things follow, and the first two are worth more than the number.

**The envelope-mean fix is confirmed by an oracle it was not chosen against.**
It is worth **16.9 dB** here, on a measure that has nothing to do with the
level ratios it was found with.

**The bias fix costs 4 dB on this measure, and is still right.** It is verified
against the container to float precision; what it does is expose something the
doubled bias was compensating. That is the second time today two errors were
found cancelling, and it is why a change verified against ground truth is the
only kind that can be trusted when the metrics disagree.

**And the Companion currently makes the signal worse in every configuration
tested**, by 3.5 to 24 dB. That is the honest headline, and it is the first
statement of the Companion's quality this project has ever had.

### What the filter does to the waveform

Correlating the output against its own input, per frame, searching the delay
per frame because a re-predicted FIR's group delay moves with it:

| | median `r` | frames above 0.5 |
| --- | --- | --- |
| as built | **+0.284** | 18% |
| exponent clamped at 4 | +0.349 | 20% |
| envelope mean restored | +0.072 | 0% |

A sixteen-tap filter chain should leave far more of its input than 0.28. What
takes it out is the shaping: the exponent's standard deviation *within* a
sub-frame is 1.152 at the median, so the gain swings about **tenfold across 80
samples**, uniformly, in every frame. That is a waveform multiplied by a wildly
varying envelope, and it is why the output stops resembling its input.

It is not `af4` mixing the shaped branch in too heavily: its kernel splits
0.1739 to 0.2237 between the pass-through and shaped channels, and the shaped
one arrives sixteen times quieter, so its effective contribution is 0.08 of the
other's.

### Smoothing the exponent recovers most of it, and every stage still costs

Averaging the exponent across the 80 samples before the `exp`, which is the
crudest possible way to ask how much of its per-sample variation is doing harm:

| smoothing | dB from clean | median `r` |
| --- | --- | --- |
| none | -5.01 | 0.284 |
| 3 samples | -0.91 | 0.485 |
| 5 | -0.64 | 0.528 |
| 17 | -0.51 | 0.566 |
| constant across the sub-frame | **-0.47** | **0.614** |

A three-sample average recovers **4.1 dB**, and flattening the shaping
altogether is best on both measures. That does not say the shaping should be
flat -- a temporal shaper that never varies has no purpose -- but it does say
that none of the per-sample variation this build produces is earning its place.

Taking the stages out one at a time:

| | dB from clean |
| --- | --- |
| unfiltered | **+2.45** |
| everything on | -5.01 |
| shaping forced to unity | -3.71 |
| the `af` gains forced to unity | -9.33 |
| **both, leaving only the normalised kernels** | **+0.61** |

They interact: removing the `af` gains alone is *worse*, because the shaping's
attenuation is then uncompensated. But with both neutral, what is left is the
two adaptive FIRs with unit gain, and that still costs **1.8 dB** against not
filtering at all. Every stage of this build makes the signal worse.

### Settled on recorded speech: it is worse, not better

The reading above was that a harmonic synthesis might be material the model was
never meant to see, so the absolute claim could not stand on it. Eleven seconds
of recorded speech, encoded and decoded through the pinned codec at 15.3 kbps,
settles it the other way:

| | dB from clean |
| --- | --- |
| unfiltered | **+2.90** |
| everything on | **-12.48** |
| with the envelope mean restored | -22.50 |
| with the bias doubled | -5.81 |
| exponent smoothed over 3 samples | -3.74 |
| exponent constant across the sub-frame | -1.08 |
| **shaping off** | **+0.22** |
| shaping off and the `af` gains at unity | +0.94 |

On real speech the Companion costs **15.4 dB**, where on the synthesis it cost
7.5. The model is not being handed unfamiliar material; it is being handed
speech and making it worse.

And the decomposition is cleaner here than on the synthesis. **Turning the
shaping off recovers 12.7 of the 15.4 dB** and leaves the filter nearly
neutral: +0.22 against +2.90 unfiltered. With the `af` gains also at unity it
reaches +0.94, so the two adaptive FIRs together cost about 2 dB and the
shaping costs the rest.

The envelope-mean fix is worth **10.0 dB** here, confirmed a third time and on
the most realistic material available. The bias fix costs 6.7 dB on it and is
still right for the reason given above: it exposes the shaping rather than
causing it.

**One caveat remains and it is small.** The recording came through Telegram, so
it arrived as Opus and `clean.s16` is Opus-decoded speech rather than a studio
original. That makes `clean` slightly lossy, which flatters every row equally
and cannot account for a 15 dB gap.

### Which features help and which cost, arbitrated in dB

The same oracle settles what no level ratio could: what each slice of the
feature vector is worth. Zeroing one at a time, against `clean.s16`:

| slice zeroed | dB from clean | |
| --- | --- | --- |
| nothing | -5.01 | |
| **`[64]` cepstrum `c0`** | **-2.65** | **+2.4, the only slice that costs** |
| `[64:82]` the whole cepstrum | -3.48 | +1.5 |
| `[82:87]` autocorrelation | -6.16 | -1.2, it helps |
| `[0:64]` clean spectrum | -6.92 | -1.9, it helps |
| `[87:92]` LTP and the three | -10.51 | **-5.5, it helps most** |

Every slice earns its place except `c0`, which is the one the weight-norm
oracle put at 38x out of family. Two independent measures now say the same
thing about the same slot, and the client's own transform for it has been read
and matches this build. That contradiction is the sharpest open item here.

**The embeddings cannot be tested this way.** Zeroing `[93:165]` reads exactly
-5.01, unchanged, because the hook that zeroes runs inside
`build_subframe_features` before the pitch and bit-count embeddings are written
into those slots. Two rows of that sweep were nonsense and are left out rather
than reported; an identical figure where an effect was expected is the same
tell as the four identical cross-fade results earlier today.

### What the model itself says the shaping should do

`alpha2`'s own bias, with `h` at zero, spreads the exponent by **0.0555**
across the 80 channels -- a gain varying **1.12x** within a sub-frame. That is
this model's resting behaviour, read from its weights, and it is what a
post-filter looks like: a twelve percent swing across five milliseconds.

Everything above it comes from `h`, and the layer converts one into the other
at a fixed rate: for an `h` with independent entries, `alpha2` spreads the
exponent by **1.4289 per unit of rms(h)**. The measured spread of 1.152
therefore implies an rms(h) of about 0.8, where the biases of the two layers
that produce it are 0.165 and 0.133.

So "the exponent varies tenfold inside a sub-frame" is the same statement as
"`h` is several times larger than the layers that make it are built for", which
is the signature this file has been calling *running hot* since the beginning.
The difference now is that there is a number attached to what it should be:
`h` small enough to keep the shaping's swing near the 1.12x its own bias
encodes.

### The envelope mean spreads the exponent, it does not shift it

A reading offered from the client's side is that the mean column stabilises:
`mu` is negative for any signal inside `+/-1`, so a large weight on it pulls
the exponent down, and it would only amplify if the signal exceeded unity and
made `mu` positive.

Measured, that does not happen here and could not: over 760 sub-frames `mu`
runs from -8.293 to **-2.252** and never reaches zero, and the peak of the
signal it is computed from reaches **0.3735** and never approaches 1.

And the mechanism is the other way round regardless, which the weights alone
settle:

| column of `alpha1_t` | mean | rms | \|mean\|/rms |
| --- | --- | --- | --- |
| `mu`, previous tap | +0.0011 | 0.1343 | **0.01** |
| `mu`, current tap | +0.0156 | 0.3286 | **0.05** |
| the 20 deviations, averaged | | | 0.07 |

A column whose entries share a sign shifts the exponent; one whose mean is a
twentieth of its rms **spreads** it. At `mu = -5` this column puts a swing of
+/-1.64 rms across the 80 channels, and its largest weight of 0.680 puts +/-3.4
on one of them -- which `exp` turns into a factor of 30 over everything else.

So carrying the mean does not pull the shaping down. It fans it out, and the
exponential picks the top of the fan. That is the fix at the top of this file,
derived a second time and this time from the weights alone, with no forward
pass and nothing that two metrics could pull apart.

## Seven consumers agree on a conditioning scale the chain does not have

Every layer that reads the conditioning vector was built by the same training,
so each one's bias estimates the input it was built for: `rms(bias)` over the
layer's column norm. Seven of them, independently:

| consumer | rms bias | column norm | input it expects |
| --- | --- | --- | --- |
| `af1_kernel` | 0.0951 | 1.347 | 0.071 |
| `af1_gain` | 0.1069 | 2.757 | 0.039 |
| `af4_kernel` | 0.1130 | 1.419 | 0.080 |
| `af4_gain` | 0.0897 | 5.135 | 0.017 |
| `tdshape1_alpha1_f` | 0.0824 | 1.364 | 0.060 |
| `ft1` | 0.1145 | 1.777 | 0.064 |
| `ft2` | 0.1588 | 2.121 | 0.075 |

They average **0.058**. What they receive is the GRU's hidden state at rms
0.59 and `ft2`'s output at 0.75 -- **ten to thirteen times more**.

### The chain is catastrophically sensitive to that scale, and the sweep cannot pick a value

Scaling the conditioning the consumers read, leaving the GRU's recurrent state
alone, against recorded speech:

| scale | dB from clean |
| --- | --- |
| unfiltered | +2.90 |
| **x 1.0, as built** | **-12.48** |
| x 0.5 | -2.80 |
| x 0.25 | +0.24 |
| x 0.1 | +0.51 |
| x 0.058, what the biases imply | +1.39 |
| x 0.02 | +1.68 |

**Halving it is worth 9.7 dB.** A network whose output moves ten decibels for a
factor of two on its conditioning is nowhere near the operating point it was
trained at.

**But the curve is monotone, so it cannot choose.** Smaller is better all the
way down, and at the bottom the filter is doing nothing -- which is the same
statement as the filter being harmful, not evidence for any particular scale.
The 0.058 the biases imply sits on that slope with nothing distinguishing it.

Two things it does establish. The chain's operating point at x1 is far inside
the harmful region rather than near an edge of it. And **no configuration of
this build beats not filtering at all**: the best point on the sweep is +1.68
against +2.90 unfiltered.

### No scale of the shaping's input makes the shaping worth having

The sweep above scales what every consumer reads. Scaling only what the
shaping reads, leaving `af1` and `af4` on the full conditioning:

| scale on the shaping's conditioning | dB from clean |
| --- | --- |
| **x 1.0, as built** | **-12.48** |
| x 0.5 | -4.32 |
| x 0.25 | -0.13 |
| x 0.1 | +0.20 |
| x 0.02 | +0.20 |
| the shaping switched off entirely | **+0.22** |

It saturates at the value for having no shaping at all. **The whole 12.7 dB
lives in the shaping's conditioning path, and there is no scale at which the
shaping earns its place.**

**That was over-read when first written here, and the correction matters.** The
claim was that a merely *hot* stage would have some scale where it helps, so
saturating at "off" proved the defect was in what the shaping computes. It does
not: +0.20 against +0.22 is two hundredths of a decibel, which is noise, and a
correctly-scaled `tdshape` contributing a fraction of a decibel on this
material would read the same. The measurement separates "harmful" from
"harmless". It does not separate "harmless because correct" from "harmless
because off".

What it does establish is where the harm is: **the entire 12.7 dB is in the
shaping's conditioning path**, and `af1` and `af4` run on the full conditioning
in the row that reads +0.22, costing about 2 dB between them.

### Why only the shaping shows it

`af1` and `af4` are **scale-invariant by construction** and the shaping is not.
Their kernels are L2-normalised, so any factor on the conditioning divides out
before the filter is applied, and their gains go through `tanh` into a span
that bounds them to `[0.2512, 3.9811]` however large the pre-activation gets.
The shaping has neither: it is `exp` of a linear function of the conditioning,
unbounded in both directions, and the client's disassembly says it is unbounded
there too.

So a conditioning vector ten times too large would be **invisible at `af1` and
`af4` and catastrophic at the shaping** -- which is exactly the pattern
measured. The seven-consumers reading and the shaping's failure are the same
observation seen at two stages, not two findings.

That does not prove the factor of ten. It removes the objection that `af1` and
`af4` running happily on the full conditioning argues against it.

### Inside the shaping, one branch carries all of it

Neutralising each part in turn, against recorded speech:

| | dB from clean |
| --- | --- |
| unfiltered | +2.90 |
| shaping off entirely | +0.22 |
| everything on | **-12.48** |
| **the feature branch zeroed (`alpha1_f`)** | **+0.21** |
| the envelope branch zeroed (`alpha1_t`) | -14.26 |
| both zeroed, biases only | +0.22 |
| `alpha2`'s previous tap zeroed | -11.22 |

`alpha1_f` carries the whole of it. Zero it and the shaping becomes as harmless
as switching it off; zero the envelope branch instead and nothing improves.

`alpha1_f` is also the **only int8 layer in the shaping** -- `alpha1_t` and
`alpha2` are float -- and its input, `ft2`'s output, is consumed by nothing
else in the chain. Both of those make it the place where a scale error would
land on the shaping alone.

Its dequantisation is not obviously wrong: it satisfies the `zero_point +
subias == bias` identity to 1.4e-06 like the other eight, which validates its
SIMD layout and its scale together, and its column norm of 1.364 is in family.

**And the activation feeding it is not the answer.** `ft1` and `ft2` run with
`tanh`, which has no entry in this file. Tried: `linear` diverges to NaN --
`previous_ft2` accumulates unbounded -- `relu` gives -8.47, and `sigmoid` gives
+0.15, which is "off" again. None of them makes the shaping useful.

### A test that was invalid, and how it announced itself

The first attempt at this scaled `self->hidden` after the GRU step, and that
array *is* the recurrent state: the next step read a scaled state and the
recursion came apart. It reported the opposite -- smaller scales monotonically
**worse**, down to -18.82 -- which is what a broken GRU looks like, not a
scaled conditioning. The tell was that it disagreed with a measurement already
taken: forcing the gains to unity and the shaping off gives +0.94, and no
amount of shrinking the conditioning could land below that if the only thing
shrinking were the conditioning.

## The `subias` oracle is blind to the order inside a channel

`subias[o] = -127 * scale[o] * sum_i q[i][o]` is a **sum** over one output
channel's inputs. It settles which weights belong to a channel; it cannot
settle their order within it, because every permutation gives the same sum.
This file has treated the SIMD layout as cravado by that oracle, and half of
it never was.

Measured against recorded speech, over the layouts the oracle can and cannot
see:

| layout | subias check | dB from clean |
| --- | --- | --- |
| unfiltered | | **+2.90** |
| as built, `((ob*nb+ib)*8+p)*4+q` | 1.42e-06 | -12.48 |
| **the group of 4 reversed** | **1.42e-06** | **-7.79** |
| the block order reversed | 1.42e-06 | -12.97 |
| both reversed | 1.42e-06 | -15.48 |
| `ob` and `p` swapped | **102** | -17.41 |
| `[out][in]`, no blocking | **89.5** | **-0.02** |

Two things, and the second is the important one.

**Reversing the four inputs inside each group is worth 4.7 dB and the oracle
cannot tell it apart.** All four permutation variants read 1.42e-06 -- byte for
byte the same check -- because they move the same weights around inside the
same channel. The magnitude of the filter is unchanged, so this is not the
filter being weakened; it is a different filter of the same strength. It is a
live candidate and nothing here can reject it.

**And `[out][in]` reads -0.02 dB, which is nearly the best number in this
file, while failing the oracle by a factor of 90.** That is the "less filter is
better" trap in its purest form: scrambling which weights belong to which
channel produces a filter that does almost nothing, and doing almost nothing
scores well because the filter is harmful. Ground truth rejects it outright.
Any layout search run against dB alone would have picked it.

Two more, to bound the search. Swapping the roles of `ib` and `q` **fails** the
oracle at 188 and is worse at -23.31, and a strided reading -- `i % nb` for the
block and `i / nb` for the position, as a kernel loading four inputs a stride
apart would give -- **passes** at 1.42e-06 and reads -11.60, which is inside
the noise of the layout in use.

So of everything that ground truth permits, the reversed group of four is alone
at 4.7 dB better and nothing else moves.

**It is not applied, and it turned out not to be a candidate at all.**

The client's SIMD kernel reads the four inputs **forward** -- `q` maps to input
`i+q` -- in all three of its matmul variants, read from the disassembly. The
only `pshufb` in them belongs to the float-to-int8 quantisation and does not
reorder the dot product. So forward is what this build does and what the client
does, and the 4.7 dB had to be something else.

It is the same trap, and taking the reversal one layer at a time shows it:

| layer reversed alone | dB from clean |
| --- | --- |
| none | -12.48 |
| `tdshape1_alpha1_f` | **-0.14** |
| `ft1` | **+0.14** |
| `ft2` | **+0.13** |
| `ft1` and `ft2` together | -4.90 |
| `fnet_gru_recurrent` | -3.92 |
| `fnet_gru_input` | -10.89 |
| everything except `ft1` and `ft2` | -17.66 |
| *(the shaping switched off, for reference)* | *+0.22* |

Scrambling **any single layer** on the shaping's path lands at "shaping off".
`alpha1_f`, `ft1` and `ft2` each feed the shaping and nothing else, so
decorrelating any one of them neuters it, and neutering it scores well because
it is harmful. The 4.7 dB from reversing everything was those scrambles partly
composing.

**The general form is worth more than the instance.** In a chain where one
stage is harmful, *any* change that destroys information on the way into that
stage improves the metric. So an improvement from a change that degrades
information is not evidence of anything -- it measures how much of the harmful
stage the change switched off. Only a change that **preserves the filter's
strength** and improves quality is even a candidate, and that one still needs
ground truth.

A correction to what a peer proposed on the back of the 4.7 dB: that the
container could settle the within-group order by unpacking a known block and
checking which weight lands in which slot. It cannot. `scale`, `subias` and
`bias` are all indexed **per output channel**; the container carries no
per-input quantity at all, so there is nothing in it that the order could
disagree with. The disassembly was the only thing that could answer, and it
did.

**What would settle it:** how the client's SIMD kernel addresses the four
inputs it loads per channel. Forward is the natural reading and is what this
build does; a reversed load or a reversed accumulation would be visible in the
addressing. One line of disassembly decides a question nothing here can.

## The conditioning cannot be ten times smaller, and the container says so

The seven-consumers reading above implies a conditioning vector of rms 0.058
where this build has 0.59. It cannot be right, and the reason is in the
container rather than in any metric: **the int8 quantisation is
`round(127x) + 127`, which assumes `x` in `[-1, 1]`**, and `ft1` is an int8
layer reading the GRU's output. A conditioning at 0.058 would use four percent
of the quantiser's range and throw away five bits.

Measured on recorded speech, the chain sits where that requires:

| | rms | at the rails |
| --- | --- | --- |
| GRU hidden | 0.5864 | 6.3% |
| `ft1` | 0.7409 | 11.9% |
| `ft2` | 0.7552 | 11.3% |

So the biases being a fifth of what they displace is how this model is built,
not a defect, and `rms(bias)/column norm` is not a usable estimate of the input
a layer expects. That heuristic produced the factor of ten and is withdrawn as
a selector; what survives of it is only that the shaping is the one stage with
no bound on its input, which remains true for structural reasons given above.

## An oracle for the float layers, which had none

`subias` exists only on the int8 path, so six float layers have never had their
layout checked against anything. One of them, `alpha2`, was settled by its
neighbouring output columns correlating 0.6373 against the client's 0.637. The
other five rested on nothing.

There is a check available wherever the layer's **input** has known order.
`conv1` reads a 64-band spectral envelope first: band `b` and band `b+1`
describe neighbouring frequencies and carry nearly the same value, so a layer
trained on it learns smooth spectral filters and its weight **rows** for
adjacent bands resemble each other. Under a wrong layout each "row" gathers
weights belonging to different bands and the resemblance goes.

Correlation between rows, against their separation:

| separation | 1 | 2 | 3 | 5 | 8 | 13 | 21 | 34 | 55 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `conv1` spectrum, `[in][out]` | **+0.747** | +0.476 | +0.262 | +0.134 | +0.129 | +0.074 | +0.008 | -0.064 | -0.100 |
| `conv1` spectrum, `[out][in]` | -0.022 | -0.037 | -0.028 | +0.003 | -0.002 | -0.023 | +0.011 | -0.017 | +0.042 |

A clean monotone decay under one reading and a flat line at zero under the
other. **`conv1`'s layout is confirmed**, and it had no evidence at all before.

The negative control is in the same layer: over the cepstrum's rows `[64:82]`,
where neighbouring coefficients are neighbouring *quefrencies* and not
neighbouring frequencies, `[in][out]` gives **-0.199** at separation 1. The
oracle fires where the input is smooth and stays silent where it is not, which
is what distinguishes it from a coincidence.

### What it settles elsewhere, and what it does not

**`alpha1_t`: weakly supported.** Its 20 pooled bins are consecutive in time,
so neighbouring rows should resemble each other. `[in][out]` gives +0.102 and
+0.110 at separations 1 and 2 and turns negative after; `[out][in]` is flat.
Structure under one reading and none under the other, but at a tenth of
`conv1`'s strength.

**`pitch_embedding`: the oracle cannot see it.** Adjacent pitch lags are nearly
the same period, so its rows should be nearly the same -- and they are not.
`[in][out]` gives +0.071 at separation 1 and +0.054 at 89: **flat**, which is a
shared mean rather than adjacency. A second attempt, looking for the
special-purpose row the unvoiced fallback lands on as an outlier in the row
norms, gives max/median of 1.31 against 1.28 -- no discrimination either. Both
readings partition the same 22464 values into 351 groups of 64 and come out
looking alike.

What does speak for it is weaker and metric-based, and recorded as such: the
embedding carries real information, since zeroing it costs **3.2 dB** against
recorded speech, and reading it with the opposite layout costs **1.1 dB**. So
the current reading is preferred, by a margin small enough that it settles
nothing on its own.

**`af1_gain`, `af4_gain`, `alpha2`'s input side: untestable this way.** They
read the GRU's hidden state, whose 160 dimensions have no known order, so
there is no adjacency to look for. Saying so is worth more than inventing a
test: `af1_gain`'s layout is instead settled by the eight-fold asymmetry
between its two output channels, which only the correct reading finds, and
`alpha2`'s by its output columns.

### And the bit-count embedding costs quality

Zeroing it is worth **+1.4 dB** -- -12.48 to -11.05 -- where zeroing the pitch
embedding costs 3.2. It is the only feature group besides `c0` that the filter
would be better off without, and like `c0` it is one this project built from a
closed form rather than read as a table. Not acted on; recorded beside `c0` as
the second slot where an independent measure disagrees with the reading.

## The container is intact and the model is the right one

Never checked until now, and worth checking before doubting anything harder.

**The container covers the file exactly.** Its 48 chunks end at byte 771584 of
a 771584-byte file: nothing trailing, nothing truncated, and every chunk
belongs to a layer the loader knows. A `.pte` with a chunk the loader never
looks for, or one cut short after the last tensor it happens to need, would
parse without complaint.

**There are three Companion files and two of them are the same.**
`mlow_companion.pte` and `mlow_companion_v2.pte` are byte-identical at 2312832
bytes, three times the `mlow_companion_v1.pte` this work has used. That is not
a newer Companion: the larger file bundles 371 chunks across several networks
-- `sig_net_*`, `dense_if_upsampler_*`, `conv2d_*`, `gru_1_*` -- of which
exactly 48 are the Companion's, with the same names and sizes as v1's.

Loaded and compared weight by weight, **all fifteen layers are identical**, max
absolute difference 0 in every one. So v1 carries the same Companion as the
bundle, and every measurement in this file was made against the right model.

**One thing the model's MANIFEST claims is not true of the container.** It says
`also_float_weights: float32 [A_in*B_out] shipped alongside int8 -> a reimpl
may use float directly`, which would let a reimplementation sidestep the
quantisation, the SIMD layout, the `127 * scale` and `subias` in one move.
Counted across the whole bundle: **13 float weight chunks and 81 int8, and no
layer carries both.** Every layer ships exactly one. Whatever that note
describes, this container is not it, and anyone reading the MANIFEST will go
looking for weights that are not there.

## "The shaping is aggressive by design" is refutable without the client

The remaining reading, if the client turns out to apply no clamp and to load
these same weights, is that a per-sample gain swinging tenfold is what this
post-filter does and the premise that it would not is this project's
assumption. That can be answered here, by asking what such a gain does to a
signal rather than what a network intends by it.

The ratio between the gains applied to **adjacent samples**, over recorded
speech, 172536 pairs:

| | ratio |
| --- | --- |
| p50 | **1.86x** |
| p75 | 3.79x |
| p90 | **10.94x** |
| p99 | 568x |
| p99.9 | 24390x |
| p100 | 2.2e8 |

**46% of adjacent pairs differ by more than 2x and 10.8% by more than 10x.**

At 16 kHz adjacent samples are 62.5 microseconds apart. A gain that changes by
a factor of ten in 62.5 microseconds is a multiplication by a modulating signal
with energy across the entire band up to 8 kHz, and multiplication in time is
convolution in frequency: every component of the speech is smeared across the
whole spectrum. That follows from the sampling rate and the numbers, not from
any view about what the network was trained to do.

For comparison, `alpha2`'s own bias with `h` at zero spreads the exponent by
0.0555 across the whole 80-sample block -- a 1.12x swing over five
milliseconds, which is a gentle shaper and is what the model's own resting
state encodes.

So the design reading requires that a shipped voice post-filter multiplies
neighbouring samples by gains differing tenfold, ten percent of the time. It is
not a matter of aggressiveness: the operation is broadband splatter by
construction. **If the disassembly shows no clamp and the same weights, the
conclusion is not that this is by design -- it is that something feeding the
shaping still differs, and it is not any of the pieces checked so far.**

## While the shaping is harmful, no measurement of its input can be read

The feature-transform wiring was worth re-testing: there are three stages and
two transforms, and NoLACE puts a transform *between* stages, which would give
`af1 <- hidden`, `tdshape <- ft1`, `af4 <- ft2`. This build has
`tdshape <- ft2(ft1(hidden))` and `af4 <- hidden`, and the note rejecting the
alternative -- "conditioning af4 on the transforms collapses the level
six-fold" -- was measured under the envelope defect and had expired.

| wiring | dB from clean |
| --- | --- |
| `af1 <- hidden`, `tdshape <- ft2`, `af4 <- hidden` (as built) | -12.48 |
| `af1 <- hidden`, `tdshape <- ft1`, `af4 <- hidden` | **+0.15** |
| `af1 <- hidden`, `tdshape <- ft2`, `af4 <- ft2` | -16.37 |
| `af1 <- hidden`, `tdshape <- ft1`, `af4 <- ft2` (NoLACE's order) | -3.67 |
| *(the shaping switched off)* | *+0.22* |

`tdshape <- ft1` reads +0.15, which is "off" again. And that is the point:
**every change to what the shaping reads scores better, because the shaping is
harmful and any different input does less of it.** Reversing a weight group
did it, scaling the conditioning did it, zeroing a branch did it, and now
rewiring the transforms does it.

So this measurement cannot choose a wiring, and neither can any other
measurement of the shaping's input while the shaping is in this state. The dB
oracle, which settles questions elsewhere in this file, is **blind in exactly
this region** -- not because it is a bad measure, but because the quantity it
measures is dominated by how much of a broken stage the change happened to
disable.

Two consequences worth carrying:

- **The wiring stays as it is.** Not because it measured better -- it measured
  far worse -- but because the alternatives are indistinguishable from
  switching the stage off, and picking among them by dB would be selecting for
  inertness.
- **What can still decide is ground truth alone**: the disassembly, the
  container, or a structural argument from the weights. The container is
  exhausted -- 48 chunks, all read, no per-input quantity, header field a
  version -- so it is the first two.

One structural check that does hold up: `alpha2`'s neighbouring columns
correlate 0.637, so for an `h` of no particular structure the adjacent exponent
values differ with standard deviation `1.152 * sqrt(2 * 0.363) = 0.98`, giving
a typical adjacent gain ratio of `exp(0.98) = 2.7` against the 1.86 measured.
The two agree, which says the *structure* of the shaping's output is what its
weights describe. What is out of place is the magnitude of `h`, and `h` is
weights times input with both verified.

## The 80 outputs are independent per-sample values, and the weights say so

A reading offered from the client's side, and then flagged by its own author as
the prime suspect once everything around it had been verified: that the client
computes the exponent at a coarse rate and interpolates it across the 80
samples, where this build computes 80 independent values. That would produce
exactly the splatter measured, and the bundle does contain
`dense_if_upsampler_*` layers, so upsampling is somewhere in the architecture.

**It is answerable from `alpha2`'s weights, with no disassembly.** If the 80
outputs were control points repeated or interpolated, that would be *in the
weights*: columns belonging to the same control point would be identical, and
the correlation between neighbours would step at group boundaries instead of
decaying.

Correlation between output columns against their separation:

| d | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| | +0.637 | +0.728 | +0.611 | +0.520 | +0.506 | +0.418 | +0.417 | +0.376 | +0.374 | +0.346 |

A smooth decay with no plateau. And testing for a step at every plausible group
size, comparing neighbouring pairs *inside* a group against those *crossing* a
boundary:

| group size | inside | crossing | ratio |
| --- | --- | --- | --- |
| 2 | 0.6713 | 0.6025 | 1.11 |
| 4 | 0.6480 | 0.6035 | 1.07 |
| 5 | 0.6394 | 0.6285 | 1.02 |
| 8 | 0.6452 | 0.5758 | 1.12 |
| 16 | 0.6357 | 0.6673 | 0.95 |

Repeated control points would read about 1.0 inside and much less crossing.
Every ratio here is 1, at every group size. **There is no upsampling in this
layer**, and the 80 outputs are what they look like.

Which also confirms, from a second direction, that the shaping's *structure* is
right: the 0.637 at distance one predicts adjacent exponent values differing by
`1.152 * sqrt(2 * 0.363) = 0.98`, a typical adjacent gain ratio of 2.7 against
1.86 measured. The weights describe what the code produces. What remains out of
place is the magnitude of `h`.

## The bar: beat switching the shaping off

The dB oracle is blind to changes that merely disable a harmful stage, which
makes most measurements of the shaping uninterpretable. But there is one
criterion it cannot be fooled by: **a variant that beats +0.22, the value for
having no shaping at all, cannot be explained by disabling it.** Anything that
clears that bar is doing something useful.

The state buffers, which are the two places a value enters the shaping without
passing through anything checkable -- `previous_shape_features`, the previous
sub-frame's `ft2` output that `alpha1_f` reads as its first tap, and
`previous_alpha`, the same for `alpha2`:

| | dB | median waveform `r` |
| --- | --- | --- |
| **bar: shaping off** | **+0.22** | |
| as built | -12.48 | 0.138 |
| `previous_shape_features` = the previous hidden | -5.06 | 0.233 |
| `previous_shape_features` = zero | -6.77 | 0.199 |
| `previous_alpha` = zero | -11.22 | 0.140 |
| both zeroed | -4.95 | 0.229 |

All improve and none comes close. And `r` stays between 0.14 and 0.23
throughout, so the shaping destroys the waveform in every one of them.

**Against that bar, nothing tried in this work has ever cleared it.** Seven
exponent clamps, seven smoothing widths, six conditioning scales, five branch
neutralisations, six weight layouts, four wirings, five state variants and four
activations -- about forty configurations -- and the best any of them reaches
is the value for switching the stage off.

That is worth stating as a result rather than a list. The shaping is not
mis-tuned in a way that a different constant or a different wiring recovers. In
every configuration reachable from here it either harms the signal or does
nothing, and the one thing measurably out of place -- the magnitude of `h` --
is produced by weights and an input that have both been verified against the
client.

## The two taps are real, and that was arithmetic until now

Every kernel-2 layer here reads an input twice the width of the conditioning,
and this code concluded "two taps of the same vector" from that alone. That is
a sum, not a reading, and the half filled with the previous sub-frame is the
larger of the two assumptions the shaping rests on: if the client built a
single 320-wide vector some other way, that half would be wrong by
construction and `h`'s magnitude would move without any weight, layout or
activation being wrong.

It is checkable in the weights. If input `i` and input `i+N` are the same
feature at two times, a trained layer gives them related weights. The control
is the pair `(i, i+N+37)`: the same distance in the layout, different features.

| layer | same channel | shifted by 37 |
| --- | --- | --- |
| `tdshape1_alpha1_f` (2 x 160) | **+0.1355** | +0.0057 |
| `tdshape1_alpha1_t` (2 x 21) | **+0.1513** | +0.0160 |
| `tdshape1_alpha2` (2 x 80) | **-0.2591** | +0.0311 |
| `ft1` (2 x 160) | **+0.3558** | +0.0075 |
| `ft2` (2 x 160) | **+0.1938** | -0.0015 |

Every one relates its two halves channel for channel and none relates the
shifted control, at a twentieth of the strength or less. **The two-tap reading
is confirmed for all five**, and the previous sub-frame's half is going to the
right place.

One thing falls out that was not asked for. `alpha2`'s coupling is
**negative**: its two taps oppose each other, so it responds to how `h`
*changes* between sub-frames rather than to its level. That is a differencing
filter in time, and it is the only one of the five that works that way.

That looked like it moved the target -- from "`h` is too large" to "`h` changes
too much between sub-frames", which is a different question and had never been
measured apart. It does not, for two reasons, and both are worth keeping.

**`h` is continuous across sub-frames.** Its rms is 1.0305 and the rms of its
change between sub-frames is 0.7557, a ratio of 0.733 where independent
sub-frames would give 1.41. That implies a correlation of **0.73** between
consecutive values, so the differencing partly cancels rather than amplifying.

**And the axes do not meet.** `alpha2`'s two taps difference across *time*; the
damage is across *channels* -- the exponent varies tenfold along the 80 samples
*within one sub-frame*, and no amount of temporal structure in `h` bears on
that. The lead was a category error, caught by asking which axis each number
lives on.

**Nor is there a discontinuity at frame boundaries**, which is the sharper
version of the same idea: the shaping's state persists inside the instance, so
if it were cleared per frame the first sub-frame of each would jump and the
differencing would amplify that jump. Split by position in the frame, the rms
change is:

| transition | rms change in `h` |
| --- | --- |
| **sub-frame 0, crossing the frame boundary** | **0.7186** |
| sub-frame 1, inside the frame | 0.8168 |
| sub-frame 2 | 0.7610 |
| sub-frame 3 | 0.7444 |

The boundary is the **smoothest** of the four, not the roughest. And the
reading agrees: every state buffer is cleared in `companion_reset`, which is an
API entry point and is called from nowhere in the processing path.

## Every point either side could check now matches, and it still costs 15.4 dB

The shaping's last unread pieces came back from the client's disassembly, and
each one agrees with this build:

| read from the client | this build |
| --- | --- |
| `alpha1_f`'s 320-wide input is `[previous ft2 \|\| current ft2]`, previous first | the same, and the two-tap structure is confirmed independently in the weights |
| `previous_shape_features` holds the previous sub-frame's `ft2` output | the same |
| `previous_alpha` holds the previous **leaky vector**, `alpha2`'s input, not its output | the same -- `memcpy(state->previous_alpha, alpha, ...)` after the leaky and before the dense |
| no per-frame or per-sub-frame reset of either tap | the same, measured (the frame boundary is the smoothest transition) and read (`companion_reset` is called from nowhere in the path) |
| no scale, offset or clamp between `alpha2` and `exp`, and none on the gain | the same |

Together with what was already settled -- the SIMD input order, the int8 scale
and zero point, the output channel assignment, `ft1`/`ft2`'s `tanh`, `alpha2`'s
column structure, the absence of upsampling, `conv1`'s layout, the container's
integrity and the model's identity -- **there is no longer a point of the
shaping that either the disassembly or the weights disagree with.**

And it still costs 15.4 dB against recorded speech, with a per-sample gain
whose adjacent-sample ratio is 1.86 at the median.

### What that leaves

Two possibilities, and neither is a piece of the implementation.

**A different model version.** The client loads a *versioned* ExecuTorch `.pte`
-- the binary carries `mlow_companion_version_name` and `*_use_executorch`
flags -- rather than a baked name-to-data table. Three files are in hand and
two of them are the same bundle; all give byte-identical Companion weights. A
version this work has never seen would produce exactly this: every structural
check passing, because the structure is right, and the output wrong, because
the numbers are not. **This is now the leading hypothesis**, and it needs the
version string the client requests.

**Something neither of us has thought to check.** The honest second entry. The
pattern this work has repeated is that the wrong piece is the one nobody counts
as a piece -- the envelope's mean, the doubled bias, the aggregate statistic,
the desynchronised sweep. Each was invisible until the question was asked, and
none was on a list beforehand.

What is *not* on this list any more: that the shaping is aggressive by design.
A gain whose adjacent-sample ratio exceeds 10 in a tenth of pairs, at 62.5
microseconds' spacing, is broadband splatter by construction, and the client
applying no clamp does not make that a design -- it makes it something the
client's inputs must not be producing.

## The shaping gain carries almost no information about the signal

Every measurement until now asked whether the gain was *too large*. This one
asks whether it is *right*, and the answer is nearly no. Three scramblings that
a working post-filter could not survive leave the result where it was.

**Scaling it towards zero never finds a better filter.** `alpha2`'s input,
scaled by `k` before the layer (a copy -- `previous_alpha` is recurrent state):

| k | 1 | 0.5 | 0.25 | 0.125 | 0.0625 | 0.031 | 0.0079 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| dB from clean | -12.48 | -1.87 | **+0.26** | +0.25 | +0.23 | +0.22 | +0.22 |

It converges to +0.22, which is the shaping switched off, and its best point is
+0.26 -- inside the noise of being disabled. **A missing scale factor is not
the explanation.** If the pattern were right and only its amplitude wrong, some
`k` would land on a filter that does something, and none does.

**Rotating it costs nothing.** The 80 gain values map to the 80 samples of the
sub-frame; rotating that mapping, or reversing it, is a change no correct
post-filter could absorb:

| shift | 0 | 10 | 20 | 40 | 60 | 79 | reversed | reversed +40 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| at k=1 | -12.48 | -12.75 | -12.79 | -12.84 | -12.79 | -12.53 | -12.70 | -12.78 |
| at k=0.25 | +0.26 | +0.30 (at 7) | +0.29 | +0.28 | +0.28 | | | |

The second row is the one that matters, and it is the control for this
project's own trap: at k=1 the gain spreads 794x inside a sub-frame at the
*median*, so every arrangement destroys the signal equally and the comparison
says nothing. At a spread that is not destructive, the **correct alignment is
worse than three of the four rotations**, and at k=0.125 all five read 0.25.

**Reordering the outputs does not help either.** The reference computes the
gain at a quarter of the sample rate and upsamples it, so 80 outputs over 80
samples could be 20 positions by 4 phases read in either order:

| mapping | consecutive | 20x4 | 4x20 | first 20, upsampled |
| --- | --- | --- | --- | --- |
| at k=1 | -12.48 | -12.63 | -12.83 | -12.51 |
| at k=0.25 | +0.26 | +0.27 | +0.26 | +0.30 |

None of them makes the aligned reading stand out from its own rotations, which
is the only signature that would identify the right one.

### The conditioning carries 0.10 dB

Delaying the shaping's conditioning by whole sub-frames -- feeding it a
different part of the recording -- reads, at k=1: -12.48, -12.57, -12.29,
-11.90, -11.74 for lags of 0, 1, 4, 17 and 57. **Monotone the wrong way**, and
it would say the conditioning is worse than useless.

It does not. A longer lag also decorrelates the conditioning from the signal,
which mutes the gain, and muting the gain is what the whole table above shows
to be an improvement. At k=0.25 the ordering reverses: **+0.26, +0.24, +0.25,
+0.18, +0.16**. The correct conditioning beats conditioning from 285 ms away by
**0.10 dB**.

So it is informative, and that is the measure of the problem: **0.10 dB of
signal where 12.7 dB is missing.** Without that control this file would have
recorded the opposite, which is the fourth time the same trap has caught the
same measurement.

### And every stage is harmful, not just the shaping

Worth putting beside it, because it was already measured and not read together
with the rest. Switching the shaping off gives +0.22 and switching the `af`
gains to unity as well gives +0.94 -- both **below the +2.90 of not filtering
at all**. The two adaptive FIRs cost about 2 dB on their own, with normalised
kernels and their gains pinned at 1.

`af1`, `tdshape1` and `af4` read the same conditioning and nothing else. A
structural fault in the shaping would not make the other two harmful; a
conditioning that carries 0.10 dB would make all three harmful in exactly this
way.

### A lead that measured out

Worth recording because it looked strong and was not. The three slots `[89:91]`
each carry their own normaliser read from the client,
`(10*log10(E) + offset) / divisor` with `(37,10)`, `(25,13)` and `(12,35)`, and
a trained normaliser holds the statistics of its own input: the mean of
`10*log10(E)` should sit near `-offset`. Over recorded speech,
`sum(adaptive codebook contribution^2)` measures **-37.12 dB** against slot
89's -37, where the `gain_tab` fed there today lives at -19.5. Slots 87 and 88
are the two gains of that same codebook, so the group would close.

Five assignments of the three quantities, through the quality oracle: -12.48,
-12.71, -12.99, -12.13, -12.33. **A span of 0.86 dB.** Moving the model's
largest weight norm by 17.5 dB of DC moves the output by half a decibel, so
whatever those slots hold, they are not the defect -- and the statistical match
is not evidence for anything, since seventeen candidates over 77 dB of range
will put one within a decibel of any target by chance.

## Half of every frame was running on a flat spectrum

The struct documents `lpc` as **one set per sub-frame**. Both harnesses filled
two:

```c
for (int h = 0; h < SUBFRAMES / 2; h++)
  memcpy(st.lpc[h], lpc + (f * SUBFRAMES + h * 2) * LPC_ORDER, ...);
```

That gives sub-frame 1 the coefficients of sub-frame 2 and leaves sub-frames 2
and 3 at **zero**, and a zero polynomial is `1`, whose inverted magnitude is
`1`, whose log is `0`. So the clean spectrum -- **64 of the 93 features** --
came out identically flat for half of every frame.

The codec's dump does carry four sets per frame and they are distinct:
consecutive pairs differ in 99.8% of frames. It was the reader that was wrong,
not the data. Fixed in `native/companion_test.c`; the measurement harness lives
in this session's scratchpad.

**It costs almost nothing and it invalidates a great deal.** Quality against
recorded speech moves -12.48 to -12.34. What it invalidates is every level
measured through it, because the degenerate half was also the equivariant half.

### It was holding up the scale-equivariance result

Over a proper codec sweep -- re-encoding at each amplitude, which is the only
way this file accepts -- the median per-frame ratio with all four sets fed:

| input amplitude | 0.125 | 0.5 | 1 | 2 |
| --- | --- | --- | --- | --- |
| median ratio | 31.26 | 8.08 | 9.84 | 4.04 |

A spread of **7.7x over 16x of input**, where **1.11x** is what this file
records. The filter is not scale-equivariant, and `native/companion_test.c`
now fails on exactly that.

**The cause is the cepstrum's `c0`.** It is the mean of the log band
magnitudes, which is the absolute level, and it reaches the shaping exponent by
the same path the envelope's mean did. Zeroing it:

| input amplitude | 0.125 | 0.5 | 1 | 2 |
| --- | --- | --- | --- | --- |
| median ratio | 2.272 | 2.169 | 2.133 | 2.090 |

**A spread of 1.087**, and 1.04 dB of quality: -12.34 to -11.30. Two
independent measures, one of which is the contract a post-filter has to satisfy
whatever the client does.

**It is not applied.** Slot 64 is confirmed to be in the client's vector by two
sources, so deleting the feature contradicts a structure this file elsewhere
relies on. This is the same tension the project's own rule names -- a reading
against a number -- and the rule says the reading wins.

**And the way to keep both is re-refuted.** "Normalise the windowed signal" was
listed as a refutation that expired with the envelope defect and had to be
re-run. Re-run here, with the slot kept and the level dropped, it inverts the
dependence rather than removing it -- 2.92, 22.82, 44.34, 115.67, a spread of
40x that grows with level -- and costs 1.87 dB. It stays refuted.

## Which of the 93 does the damage

Zeroing each group in turn, against recorded speech, with all four predictor
sets fed (baseline -12.34, unfiltered +2.90):

| group | slots | dB | |
| --- | --- | --- | --- |
| clean spectrum | `[0:64]` | **-7.48** | recovers 4.9 |
| noisy cepstrum | `[64:82]` | -15.43 | costs 3.1 |
| autocorrelation | `[82:87]` | -13.82 | costs 1.5 |
| ltp gains | `[87:89]` | -12.89 | costs 0.6 |
| decode context | `[89:92]` | -13.03 | costs 0.7 |
| side index | `[92]` | -12.34 | nothing |
| everything | `[0:93]` | -1.57 | recovers 10.8 |
| and both embeddings | | -0.03 | recovers 12.3 |

**The clean spectrum is the only harmful group.** Every other one is mildly
useful, and the side index does nothing at all -- which is what a slot pinned
at zero should do, and is a check on the harness rather than a finding.

Read the last two rows as sensitivity, not as improvements: zeroing destroys
information, and with nothing fed the network emits its own bias, which is
`exp(0.105)` and therefore near-neutral by construction. What they establish is
that the features drive the damage, since the same network fed nothing is
harmless.

### And the `320` really does not belong

The client writes the envelope as `1 / ((|A| * 320)^2 + eps)` and this build
drops the 320, on the argument that its transform divides by the size and
multiplies it back. The argument holds up: measured, that factor costs
**8.9 dB** (-12.34 to -21.21), and dropping the square as well as the 320
costs 7.2. Two variants of the same feature, both worse, so the reading stands
where it is.

**And the reference's own formula does not rescue the group.** Unsquared, the
feature matches `calculate_log_spectrum_from_lpc` in every detail -- the
filterbank tables are byte-identical to `center_bins_clean` and
`band_weights_clean`, the accumulation in `companion_filterbank` is the
reference's line for line, the `0.3 * log` is there, and the reference's own
`mag_spec_320_onesided` returns `320 * |FFT|` over a `1/320`-normalised
transform, which is the plain DFT magnitude this build computes and settles the
`320` question from the source rather than by argument. The one remaining
difference is the square.

Dropping it gains 1.6 dB and **the group stays harmful**: -10.76 with it
against -7.48 without, where squared reads -12.34 against the same -7.48. So a
clean spectrum computed exactly as the reference computes it is still worth
-3.3 dB to this model.

That is the sharpest form of the version argument this file has. The feature is
not in question any more; what consumes it is.

**The square's provenance is also weaker than it reads.** It comes from a
reading of the client as `1 / ((|A| * 320)^2 + eps)` -- and the `320` in that
same reading is confirmed wrong by 8.9 dB, and was already rejected here on its
own. Half a reading is not evidence for its other half, and the reference does
not square. Left as it is, because a metric is not grounds to overturn a
reading, but it is a hypothesis now and not a measurement.

For the record beside them: the reference's unsquared `1/|A|` reads -10.76 and
demeaning the 64 bands after the log reads -9.83. Both better than what is
there, both changes that reduce the feature's magnitude, and neither anywhere
near the 4.9 dB that removing the group entirely gives. The group is wrong in a
way that scaling it does not fix.

## The feature extractor, audited against the reference in full

The 93 feed `fnet_conv1` and nothing else reaches the network, so they are the
piece upstream of everything. Compared line by line against
`osce_features.c` and `osce.c`:

| piece | verdict |
| --- | --- |
| slice layout `0 / 64 / 82 / 87 / 92` | matches |
| predictor polynomial's sign | matches -- the codec's dump already negates |
| filterbank tables | **byte-identical** to `center_bins_clean`, `band_weights_clean` |
| filterbank accumulation | matches, including the `+=` on the last band |
| magnitude normalisation | matches: `320 * |FFT|` over a `1/320` transform is the plain DFT |
| `0.3 * log` on the bands | matches |
| epsilon `1e-9` | matches, in all three places |
| spectrum refresh rate | matches the codec: four distinct sets per frame |
| cepstrum window at `frame - 160` | matches |
| cepstrum on even sub-frames, copied on odd | matches |
| cepstrum log, filterbank, DCT | matches |
| autocorrelation, `k = -2..2`, `xy / sqrt(xx*yy + 1e-9)` | matches |
| unvoiced pitch row `7`, hangover disabled, 351 rows | matches |
| bit-count `sin(scale * x - 0.5)`, clip and midpoint | matches |
| `conv1`, `conv2`, `tconv` activation `tanh` | matches |

**Three things differ, and all three are deliberate.**

1. The clean spectrum inverts `|A|^2` where the reference inverts `|A|`. Marked
   ASSUMED where it is defined; see above for why its provenance is weaker than
   it reads.
2. The pitch index is the mean of two lags where the reference uses one.
   Measured from the client, and this file's own cautionary tale.
3. Slots `[87:93]` are two copied gains, three logged energies and an index,
   where the reference has five LTP coefficients and a log gain. Measured.

**One near-miss worth recording, because the dimensions settled it and an
argument nearly did not.** The reference embeds the bit count twice, raw and
smoothed, and the codec dumps `features_num_bits_smooth` and implements the
same `0.9 / 0.1` smoothing to produce it -- which reads as strong evidence that
the Companion consumes both, against this build's single embedding. It does
not: `compute_nolace_numbits_embedding` ignores its `dim` argument and writes
eight values per call, and `fnet_conv1` takes 165 = 93 + 64 + **8**. One call.
The client is pruned here as it is elsewhere, and the codec dumping a feature
is not evidence that this model consumes it.

**What the audit does not settle.** The client is a fork, and the model was
trained against whatever that fork computes, not against stock OSCE. So
matching `osce_features.c` establishes that this build is a faithful reference
implementation; it does not establish that it is a faithful *client*
implementation. Every row above is a place where a fork could differ and this
comparison would not notice. That is the shape of the remaining question, and
it is why the square matters out of proportion to its size: it is the one row
where a divergence is already suspected.

## The envelope may not be inverted at all, and four measures say so

The clean spectrum is the only harmful group, and no rescaling, reordering or
reference-exact variant of it helps. **Removing the reciprocal does.**

| polynomial sign | `1/|A|^2` | `1/|A|` | `|A|^2` | `|A|` |
| --- | --- | --- | --- | --- |
| as read (the dump's `-A[i+1]`) | -12.34 | -10.76 | -5.79 | **-3.12** |
| negated | -13.48 | -11.74 | -3.60 | -6.06 |

`0.3 * log(|A|)` -- the whitening polynomial's magnitude, band-pooled and
logged, with no reciprocal and no square -- reads **-3.12 dB** where what is
there reads -12.34. The polynomial's sign convention is ruled out by the same
grid: negating it is worse in the cell that matters.

**Three measures move together, and one that was listed here does not
discriminate.**

| | `1/|A|^2`, as built | `|A|` |
| --- | --- | --- |
| dB from clean | -12.34 | **-3.19** |
| what the group is worth | **-4.9**, harmful | **+4.3**, useful |
| median peak shaping gain | 331 | **0.954** |
| sub-frames peaking over 1000x | 41.3% | 2.4% |
| scale equivariance over 16x | 7.7x | 1.16x -- **but see below** |

The second row is the structural one. Zeroing the group reads -7.48 whatever
is in it, so a feature that reads -12.34 is **worse than absent** and one that
reads -3.19 is worth 4.3 dB of its own. Nothing else tried has ever crossed
that line. The third is independent of the first and is the sharpest: a median
peak shaping gain of 331 is not a post-filter, and 0.954 is.

**The equivariance row was overstated here and is corrected.** Zeroing the
cepstrum's `c0` restores equivariance to 1.09x **with the reciprocal left in
place**, so the sweep does not distinguish the two hypotheses: both changes
reduce the same downstream sensitivity. What does distinguish them is the gain,
where removing `c0` moves the median peak from 331 only to 300 while `k = -0.5`
takes it to 0.954, and the dB, where `c0` is worth 1.04 against 9.2.

**And the LPC is not carrying the level**, which was the other reading of that
sweep. Predictor coefficients are scale-invariant by construction -- the gain
goes to the residual, `A[0] = 1` -- and the dumps confirm it across a
sixteen-fold codec sweep: coefficient rms 0.374, 0.389, 0.389, 0.392, and the
feature itself `0.3 * ln(1 / |A|^2)` at median -0.086, -0.089, -0.090, -0.092
with a standard deviation of 0.310 to 0.315. Seven percent across 16x. So the
equivariance failure never came from this feature, and removing the reciprocal
does not fix it by normalising anything.

**And this destroys no information.** It is a sign in the log domain, so the
trap that governs every other result in this file -- that anything decorrelating
a harmful stage scores well -- does not apply. There is nothing to switch off.

**Discarded, and the dataflow closed it rather than the opcode.** The first
read found `re^2+im^2`, `sqrtpd` to `|A|`, `* 320.0`, a square and `rcpps`. The
follow-up traced where that reciprocal goes: it writes **in place** into the
same stack buffer the filterbank then reads, so it is not a side computation
and there is no second path. The client's `[0:64]` is
`0.3 * ln(sum w * 1/(|A|*320)^2)` -- a negative exponent in `|A|`, which is
what this build computes. The criterion was set before the answer arrived, so
it holds.

**So `k = -0.5` is the less-filter trap in its purest form yet**, and this
section's earlier framing of it as the largest result here was wrong. A sign
flip in the log domain destroys no information, which is why it passed the test
this file usually applies -- but it is still not what the client computes, and
what it does is reduce a harmful stage's effect rather than correct it. The
trap has a wider mouth than "destroys information": **a change that preserves
information can still improve a metric only by weakening a stage that is
wrong.**

The same run settles the other half. **There is no LPC normalisation in the
client**: the coefficients enter the transform raw from `state+0x60`, with no
division by `A[0]`, no gain and no frame energy. The scale-invariance comes
from the predictor being gain-free, with the gain carried separately in the dB
slots, which is what the measurement here found from the other end.

**And that makes it the strongest version argument in this file**, because the
feature is now confirmed correct against the client and is still worse than
absent.

### What the client's own chain measures

Every op in it now matches this build, checked against the read:

| op | client | here |
| --- | --- | --- |
| `re^2 + im^2`, `sqrt`, `* 320` | de-normalises its own transform | unnormalised DFT, equivalent |
| square, reciprocal | `1 / (|A| * 320)^2` | `1 / |A|^2` |
| filterbank boundaries | `2, 5, 8, 10, 12, 15, ... 160` | identical |
| filterbank weights | `0.6667, 0.4, 0.3333, 0.4, 0.5, ...` | identical |
| Nyquist bin doubled into band 63 at `0.333` | yes | yes, via the trailing `+=` |
| `0.3 * ln(x + 1e-9)`, natural log | yes | yes |
| clamps, floors, extra ops | none | none |

**The `320` is the one place the two descriptions look different and are not.**
The client multiplies `|A|` by 320 before squaring, which in the log is a
constant `-3.46` on all 64 bands. Applied here as a pure shift -- one line, no
transform touched, which is the clean form of the test -- it reads **-21.21**,
and the *opposite* shift reads -9.49. The client's `320` un-normalises the
client's transform; this build's is unnormalised already, so applying it again
double-counts. Settled twice now, by the reference's source and by this test.

### The model's optimum is at minus a half

Scaling the 64 logged features by `k`, which is a pure reparametrisation and
destroys nothing:

| k | 1 (as built, and as the client computes) | 0.5 (the reference's formula) | 0 (absent) | **-0.5** | -0.75 | -1 | -1.5 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| dB | -12.34 | -10.76 | -7.48 | **-3.19** | -3.69 | -5.75 | -5.17 |

A smooth curve with one maximum, not a knife edge. And `k = -0.5` is exactly
`0.3 * ln|A|`: the magnitude, logged, with neither the reciprocal nor the
square.

### And all of it is above 4 kHz

Zeroing halves of the band rather than the whole group, against -12.34 with it
and -7.48 without:

| zeroed | `[0:32]`, 0-4 kHz | `[32:64]`, 4-8 kHz | `[0:16]` | `[48:64]` |
| --- | --- | --- | --- | --- |
| dB | -12.37 | **-7.17** | -11.59 | -9.84 |

**The lower half does nothing and the upper half is the whole of it** --
zeroing 4-8 kHz alone reads better than zeroing all 64, so the low bands are
slightly useful and the high ones carry every decibel of the damage.
`centres[32]` is bin 80 of a 320-point transform at 16 kHz, which is 4000 Hz
exactly.

The obvious reading is the codec's band split, and it is wrong here:
`features_hb_lpc.f32` and `coded_hb.s16` are **zero bytes** in this dump,
because the high-band path is gated on `fs > 16000`. At 16 kHz the predictor
covers the whole band.

Nor is the feature misbehaving up there. Per band, over a real decode, the mean
runs -0.38, -0.41, -0.48, -0.47 across the four quarters and the standard
deviation 0.12, 0.25, 0.28, 0.49, with the whole thing inside `[-1.61, 2.43]`.
More variance at the top, which is what a predictor's fit does, and nothing
pathological. The feature is sane and the model dislikes it.

### The harmful band holds almost nothing

Above 4 kHz the decoded signal carries **0.45%** of its energy and the clean
one 0.62%, and the codec tracks the band rather than discarding it -- 0-2 kHz
comes through at -0.08 dB, 2-4 at -0.49, 4-6 at -1.64 and 6-8 at -1.27. So the
damage originates in the emptiest part of the spectrum, 23 dB below the band
that carries the speech.

That fits what the feature looks like there. Its per-band deviation is 0.49
over 6-8 kHz against 0.12 over 0-2, so the noisiest part of the vector
describes the quietest part of the signal, and `fnet_conv1` gives those rows
the group's largest norms. A model trained on this feature would have learned
what that noise means. A model that was not is where its errors would surface
first.

### Neither the mean nor the variance of those bands is the fault

Against -12.34 with the group and -7.17 with `[32:64]` zeroed:

| | demeaned, running average | frozen at that average | zeroed |
| --- | --- | --- | --- |
| `[32:64]` | -8.76 | -11.25 | **-7.17** |
| all 64 | -9.21 | -11.55 | -7.48 |

Removing the mean recovers 3.6 of the 5.2 available and removing the variance
recovers 1.1, so it is much more the mean than the spread -- **and neither
beats simply not having the feature.** No partial treatment of this group is a
candidate.

A fixed offset on the high bands is not one either, and the way it fails is
the familiar one. Sweeping a constant added to `[32:64]`: +0.25 reads -10.65,
+0.5 -8.54, +0.75 -6.15, +1.0 -4.49, +1.5 -2.87, +2 **-1.00**, +3 -8.67, +5
-1.03, and +10 reads **+0.20**, which is the shaping switched off to two
decimal places. Non-monotone, and converging on the disabled value: a large
constant saturates the layer's `tanh` and turns the filter off. There is no
constant here to explain.

### Every boundary of the 165-wide vector, read from the weights

The one thing on the consumer's side that had never been checked is the
assembly itself -- whether `fnet_conv1` really reads `[93 || 64 || 8]` in that
order. It leaves a signature: an input group with a natural order gives
neighbouring weight rows that resemble each other, and one without gives rows
that do not. The correlation between row `i` and row `i+1`, across all 165:

| rows | what should be there | adjacent correlation |
| --- | --- | --- |
| `[0:64]` | 64 neighbouring frequency bands | **+0.7466** |
| `[64:82]` | 18 quefrencies | -0.1989 |
| `[82:87]` | 5 neighbouring pitch lags | **+0.6928** |
| `[87:89]` | two adaptive codebook gains | +0.5851 |
| `[89:92]` | three unrelated logged quantities | +0.0910 |
| `[93:157]` | 64 trained embedding dimensions | -0.0503 |
| `[157:165]` | 8 sinusoids of rising frequency | +0.0912, and **+0.8314** between the first two |

**Every boundary falls exactly where this build puts it.** The transitions are
sharp: `63 -> 64` drops to +0.0266 from +0.5582 the step before, and
`156 -> 157` reads -0.0794 against +0.5693 the step before and +0.8314 the step
after. Two blocks are confirmed here for the first time -- the autocorrelation
at `[82:87]`, whose five neighbouring lags correlate as strongly as the
spectrum does, and the ltp pair.

That closes the consumer's side. The assembly is right, the extractor is right,
the chain is right on both platforms, and the model rejects the result.

### A gate is not the answer: it is loud speech that suffers

If the client ran the Companion conditionally -- on voiced frames, above a
bitrate, behind a VAD -- then running it on everything would be the fault, and
that would be a real fix rather than another constant. Per frame, against the
clean signal, by quintile of the frame's own energy:

| frame energy | unfiltered | filtered | cost |
| --- | --- | --- | --- |
| -18 to -12 dB | 3.65 | -2.19 | -6.97 |
| -12 to -10 | 3.33 | -1.09 | -6.47 |
| -10 to -6 | 2.62 | -0.27 | -5.03 |
| -6 to 3 | 2.28 | -14.48 | **-16.66** |
| 3 to 14 | 4.32 | -11.05 | **-14.36** |

**The opposite of what a gate would predict.** Quiet frames lose 5 to 7 dB and
loud ones lose 14 to 17: the filter damages actual speech hardest and leaves
silence comparatively alone. Nine percent of frames improve at all, and their
median energy, -8.7 dB, is indistinguishable from the -8.4 of the frames that
worsen -- so there is no threshold to find either.

The step between the third and fourth quintile is sharp, from -5.03 to -16.66
around -6 dB of frame energy, which is where a gain above unity starts pushing
a loud frame past full scale. That is the clipping already recorded here, seen
from the frame's side rather than the sample's.

### The Android binary carries the same chain, and that was worth checking

The weights came from Android -- the MANIFEST names `libopus_mlow.so` as its
source -- while every disassembly read of the feature chain was on the desktop
`WhatsAppNative.Voip.dll`. Feeding desktop-shaped features to Android weights
would produce exactly this symptom: every piece checking out against one binary
while the model from the other rejects it.

It does not need a disassembler to rule out. The constants are in `.rodata`:

| in `libopus_mlow.so` | |
| --- | --- |
| `center_bins_clean`, 64 int32 at `0x1aaf0` | **identical** to this build's, value for value |
| `band_weights_clean`, 64 float at `0x1abf0` | identical to 2e-08, which is float rounding |
| the cepstrum's centres and weights | present at `0x1acf0` and `0x1ad40` |
| `320.0` as double | three occurrences |
| `0.3` and `1e-9` as float | nine and seven |
| `0.5^16`, the envelope floor | two |
| `1.3815510273`, the gain span | one |

**So both platforms compute it the same way**, which is what the project's own
earlier RE concluded from the other end: the layer dimensions are identical
across mobile, desktop and web, the packaging of the weights differs, and the
*model* is what carries a version. One external model file serves both
platforms, so a feature convention that differed between them would leave one
of them broken.

The platform hypothesis is closed, and closing it removes the last reading
under which the feature could be wrong. What is left is the model.

**And the bit-count embedding's constants are all four there**, which needed a
correction: this section first called them a coincidence. `ln(10)` at `0x22f4`,
`-0.5` at `0x24f0`, `ln(650)` at `0x256c` and **`-4.38977909` at `0x28ac`** --
the last being `-(ln 10 + ln 650) / 2` to 3.6e-07, which is float precision.

The midpoint is what ties them. Two log bounds could be anything, and `ln(10)`
is what every decibel conversion carries; the *half-sum of those two bounds*
sitting beside them is the formula. It was missed at first because the search
looked for the positive value and the binary stores the negative, and a
tolerant scan of every float32 in the file finds exactly one near it.

So `clip(log x, ln 10, ln 650) - 4.389779`, then `sin(scale * that - 0.5)`, is
confirmed in the binary the weights came from, and matches this build exactly.

**And `x` is the bit count after all.** It is `ec_tell()` of the entropy
decoder, `nbits_total - EC_ILOG(rng)`, in bits -- which is what this build
feeds. The three pitch framings measured worse because pitch was the wrong
source, not because the form was wrong, and the clip bounds are a per-frame bit
budget of 0.5 to 32.5 kbps, which fits a payload and not a lag: 650 samples is
24.6 Hz.

**The eight scales are stored permuted and this build's order is better
anyway.** They sit in the binary as `2.2861, 2.7821, 0.9154, 1.2509, 4.9753,
5.6134, 3.3796, 4.2674` -- the sorted list under `[2,3,0,1,6,7,4,5]`, which is
two SIMD quads with their halves swapped. Applying that permutation here reads
**-14.83** against -12.34, so either the loader unshuffles them or the pairing
is not what it looks like. Sorted stays.

### An internal oracle, and it is confounded the same way

`conv1` ends in `tanh`, and a trained layer fed what it expects should not sit
at its rails. Over a real decode, the fraction of its 96 outputs past 0.999,
and their mean magnitude:

| k | +1 (as the client computes) | -1 | +0.5 | -0.5 |
| --- | --- | --- | --- | --- |
| at the rails | 8.16% | 7.08% | 6.83% | **4.99%** |
| mean `|tanh|` | 0.720 | 0.649 | 0.669 | **0.611** |

At each magnitude the negative sign drives the layer less, which points the
same way as everything else. **It is not independent evidence, though, and
saying so matters more than the numbers**: a feature that drives the network
less will also do less damage when the network is wrong, so this is confounded
by exactly the mechanism it would be used to argue against. Recorded as weak
corroboration, and the same trap in a third costume.

### It is not the material, and it is not the weights being odd

The same three points on the synthetic dump, which shares nothing with the
recording but the codec: `k = 1` reads -12.04, `k = 0` -6.92 and `k = -0.5`
**-3.44**; one amplitude down, -17.47, -13.69 and **-8.93**. The ordering holds
and `k = -0.5` beats absence on both, so this is not a property of one
recording.

And `fnet_conv1`'s rows for those inputs are unremarkable. L2 norm per input
row, by group: spectrum 1.40 over 0-2 kHz, 1.18 over 2-4, 1.28 over 4-6 and
1.52 over 6-8; cepstrum 1.15; autocorrelation 2.50; ltp 2.66; decode context
2.14; pitch embedding 0.49; bit count 0.84. All 64 spectrum rows fall between
0.81 and 2.02 with no outlier, and the harmful half carries the largest norms
of the group by a fifth -- enough to matter, nowhere near enough to look like a
misread.

So **the feature computed exactly as the client's disassembly says it is
computed is worse than not having the feature**, the reference's own formula is
also worse than not having it, and the model wants minus half of either. Read
together with the audit above -- every other row of the extractor matching, the
container intact, one Companion in the bundle, the weights identical across all
three files -- what is left is that these weights were not trained against
these features.

### Two other readings measured out on the way

**The clean spectrum is not the signal's band energy.** Computed from the
windowed signal instead of the predictor: `|FFT|^2` reads -18.44 and `|FFT|`
-14.93, both far worse. `1/|FFT|^2` reads -6.13, which beats the group's
absence -- and is the same finding by another road, since `X ~ E/A` makes
`1/|X|` behave like `|A|`.

**The last eight of the 165 are the bit count, not the pitch.** Fed the pitch
instead, under three framings -- the current bounds, lag bounds `[32, 400]`,
and frequency bounds `[40, 500]` Hz -- it reads -15.01, -15.97 and -15.01
against -12.34. The clip bounds recovered from the client are `[10, 650]`,
which a 20 ms payload occupies and a pitch lag does not.

## The client's Companion runs, costs 0.17 dB, and this build costs 17.5

The lever is one call. Registration is not enough: a per-frame driver reads
`OD+0x3c`, whose default is 3, and selects the **dry** path unless it is 6.
So the order is init, `OPUS_SET_USING_SMPL(1)`, register through
`opus_decoder_ctl(dec, 4085, blob, len)`, then

    opus_decoder_ctl(dec, 4058, 6);

and the chain runs. `OPUS_RESET_STATE` and any reconfiguration of rate or
channels clear both the mode and the registration, so both have to be reissued
after either.

### The control, run before the result this time

The previous attempt at this measurement claimed neutrality from what was
actually absence, because its control perturbed the weights so violently it
answered a different question. The discriminating test is cheap: **scale the
float weights by a fifth and compare the bytes.**

| | md5 | |
| --- | --- | --- |
| mode 6, real weights | `1d38061f5df7` | |
| mode 6, weights x1.2 | `f1074bed149e` | **different** |

They differ on **98.6%** of samples, rms 287.3. The Companion is running and
its output depends on its weights. Under the dry path the same pair was
byte-identical.

And the contribution is what a post-filter's should look like: **rms 278.4 on
98.6% of samples, 17.2 dB below the signal.** Not identity, not an explosion.

### The measurement

Each implementation against **its own** unfiltered path, which is the only
comparison the two codecs permit:

| | delay | dB from clean | what its Companion costs |
| --- | --- | --- | --- |
| pinned codec, no Companion | 0 | +4.37 | -- |
| client, dry path | 46 | +1.94 | -- |
| **client, Companion running** | 47 | **+1.77** | **-0.17 dB** |
| **this build** | 16 | **-13.30** | **-17.5 dB** |

**The client's Companion costs 0.17 dB of SNR.** That is what a post-filter
trained on a perceptual loss does -- it trades a little SNR, which is exactly
the caveat this file raised long ago against reading a negative dB as broken.
**This build costs 17.5.** Its contribution measures rms 8964.8 against the
client's 278.4: **thirty-two times too large.**

### In one mode the client's Companion *improves* the signal

`opus_decoder_ctl(dec, 4058, n)` takes `n` in 0..7, and the mode decides
whether the chain runs at all and how much of it:

| mode | contribution rms | samples | dB from clean | against the dry path |
| --- | --- | --- | --- | --- |
| 0, 3, 4, 5 | 0.00 | 0% | +1.94 | dry |
| **1, 2** | 301.12 | 97.4% | **+2.39** | **+0.45 dB** |
| 6 | 278.40 | 98.6% | +1.77 | -0.18 |
| 7 | 244.29 | 88.1% | +1.81 | -0.14 |

Modes 1 and 2 give byte-identical output. The four active configurations sit at
three distinct contribution levels -- 301, 278, 244 -- which is a set of steps
rather than a curve, and consistent with a gate that admits more of the network
as it opens.

**And mode 1 raises the SNR by 0.45 dB.** That settles a worry this file
carried for a long time: that a post-filter trained on a perceptual loss might
legitimately *lower* SNR, so the `clean.s16` oracle could never show it working.
In this mode it shows it working. The oracle is sound and the filter is
genuinely useful.

**So the target is concrete and positive.** This build should come out about
half a decibel *better* than the unfiltered signal. It comes out **17.67 dB
worse**.

And it bounds the depth reading: **no mode of the client contributes more than
rms 301**, where this build contributes 8964.8. If this build ran the network
at full depth and one of these modes did too, they would meet. They do not,
by a factor of thirty.

### The factor of thirty-two is intensity, and intensity is not the whole of it

Where it enters, measured as contribution rms against the client's 278.4:

| this build | contribution rms | factor |
| --- | --- | --- |
| as computed | 8964.8 | **32.2x** |
| shaping gain forced to 1 | 1999.9 | 7.2x |
| `af` gains forced to 1 | 12896.8 | 46.3x |
| both forced to 1 | 2679.5 | **9.6x** |

Forcing the `af` gains up makes it worse, because they normally sit below one.
And with **both** gains at unity the kernels alone still contribute **9.6 times**
too much, so the gains are not the whole of it either.

**A point prediction, and it lands.** If the client applies the chain at some
fraction of full intensity -- which is what the `ramp` in its transition machine
does -- then this build at full intensity is too strong by exactly the
contribution ratio. Blending this build's contribution back at weight `w`:

| w | 1 | 1/16 | **1/32** | 1/64 |
| --- | --- | --- | --- | --- |
| cost in dB | -17.67 | -0.66 | **-0.10** | +0.01 |

At `1/32`, predicted from the rms ratio and not fitted, the cost is **-0.10 dB**
against the client's **-0.17**. So roughly three percent intensity reproduces
the client's effect on this measure.

**But the same measure says the chain is also wrong.** Two filters can cost the
same dB and share nothing, so the test is whether the contributions agree
sample by sample. Scaled to identical rms, this build's contribution correlates
with the client's at **0.105** -- a hundred times what noise of the same power
gives (0.001), and far below what matching filters would.

**The ceiling is 0.9478, and that settles how far off the chain is.** The
objection was that the two run on different decoded signals, so a perfect port
would not correlate at 1 either. That is measurable without any disassembly:
encode the same speech a second time at 12 kbps, which gives a decode
correlated with the first at **0.9611** once aligned -- the same distance that
separates the pin's decode from the client's -- and run **the client's own
chain** over both.

Its two contributions, rms 301.1 and 294.0, correlate at **0.9478**. So the
input difference costs almost nothing: the same chain on signals that far apart
still agrees to within five percent.

**Against a ceiling of 0.95, this build reads 0.105.** The chain computes
something almost entirely different, and the input difference explains none of
it.

So: **the intensity explains the decibels and the chain explains nothing.**

### The kernels are spread where they should be sharp

The adaptive filters are L2-normalised per output channel, which the reference
does identically -- `scale_kernel` in `nndsp.c`, same loop, same `1e-6` guard,
the gain folded in after. So the normalisation is not the fault.

What a unit-energy 16-tap filter does to a signal depends entirely on its
shape. Measured over a real decode, this build's kernels have a peak carrying
a median **0.239** of their energy, where 1.0 is a delta and 0.0625 is flat,
and a DC gain of **0.204**.

A unit-energy filter spread like that, passing a fifth of DC, does not modify
a signal -- it replaces it with something uncorrelated. That is exactly the
136% contribution and the 0.105 correlation, arriving by a second road: this
build's contribution is 136% of its signal where the client's is 15%, and
`sqrt(2)` is what an output uncorrelated with its input gives.

### The kernel layer is a delta plus a perturbation, and the perturbation wins

This is settled from the weights alone, without the client. The kernel layers'
**biases are delta-like**, concentrated on the most recent sample:

| | peak | tap | peak^2 / energy |
| --- | --- | --- | --- |
| `af1`, output 0 | 0.4168 | **15 of 16** | **0.750** |
| `af1`, output 1 | 0.1753 | 15 | 0.531 |
| `af4`, input 0 | 0.3626 | 15 | 0.739 |
| `af4`, input 1 | 0.2604 | 14 | 0.294 |

Tap 0 is exactly `+0.000` in all four, which this project already recorded from
the other direction. So the layer is built as **a delta from its bias plus a
perturbation from the conditioning** -- the standard shape for an adaptive
filter that modifies rather than replaces.

**Measured at runtime, the perturbation is 8.75 times the bias** in rms, median
over a real decode, with a 10th-to-90th percentile of 7.60 to 10.27. For the
kernel to keep the bias's shape that ratio has to be well below one. Ninety
percent of what reaches the filter is the conditioning, and the bias's delta is
a rounding error inside it -- which is exactly how `peak^2/energy` falls from
**0.750** with the bias alone to **0.239** in use.

And the arithmetic closes: `8.75 / 0.3` is **29**, against the **30 to 32**
measured in the contribution by two other routes.

## The client's Companion is identity plus seven percent

Measured, not inferred, and with no disassembly: fit a 33-tap least-squares FIR
from each implementation's own input to its own output.

| | peak | at tap | `peak^2/energy` | DC gain | residual |
| --- | --- | --- | --- | --- | --- |
| **client, mode 1** | **+0.8512** | **0** | **0.9766** | **+1.0399** | **7.0%** |
| client, mode 6 | +0.8937 | 0 | 0.8966 | +1.1161 | 7.9% |
| **this build** | **-0.3074** | **20** | 0.1736 | **+0.0801** | **99.8%** |

An identity filter would read peak +1.0 at tap 0, `peak^2/energy` 1.0, DC +1.0
and zero residual.

**The client is identity plus a small correction.** Unity DC, its peak at lag
zero, its neighbouring taps at +0.004, -0.018, +0.038, +0.017, and 93% of its
output explained by that one filter.

**This build is not a filter of its input at all.** Its peak is *negative*,
sits 20 samples late, its DC gain is 0.08 -- it removes almost all of the low
frequencies -- and **99.8% of its output cannot be explained by any 33-tap
linear filter of its input.** The output is essentially unrelated to the signal
it is supposed to be post-filtering.

**And the arithmetic predicted it.** From the client's 15% contribution,
`||h - delta||` gives an implied `peak^2/energy` of **0.978**; the fit measures
**0.9766**. Three decimals, from two independent routes.

So the question is no longer how large anything is. It is why this build's
output is unrelated to its input, when the client's is its input plus seven
percent.

### What the effective-filter fit rules out

It is a sharper oracle than the decibels, because a change that merely weakens
the filter cannot move the peak to lag zero, restore unity DC, or lower the
residual. Everything below was tried against it and none of it moves.

| tried | peak | tap | DC | residual |
| --- | --- | --- | --- | --- |
| as built | -0.3074 | 20 | +0.0801 | 99.8% |
| shaping gain forced to 1 | -0.0620 | 20 | +0.0182 | 71.2% |
| both gains forced to 1 | -0.1774 | 20 | +0.1841 | 64.5% |
| `COMPANION_FILTER_OFFSET` 4 / 8 / 12 / 15 | -0.25 to +0.27 | 16 / 4 / 3 / 15 | 0.06 to 0.16 | 99.9% |
| `out = x + g*(k*x)` per adaconv, g in 0.05..1 | -- | -- | -- | 95 to 96% |
| **the client** | **+0.8512** | **0** | **+1.0399** | **7.0%** |

**The residual structure does not fix it.** Adding the input back at each
adaconv leaves the contribution at 7300 to 11100 against the client's 301 and
the correlation at 0.02 to 0.17 against a ceiling of 0.95. The shaping's gain
still multiplies everything downstream.

**The filter offset does not fix it**, and its earlier refutation -- made on
level ratios of 3.87 against 4.35 -- survives on this better oracle: the offset
moves where the peak lands and leaves the residual at 99.9%.

**The int8 expansion is not off by 127.** If the weights were `scale * q`
rather than `127 * scale * q`, the kernel perturbation would fall by exactly
the factor needed. It is not: `-127 * scale * sum(q)` reproduces the `subias`
chunk within a factor of 0.67 to 1.32 across seven int8 layers, where dropping
the 127 would make it 127 times off.

**And two more stay dead**, both killed by measurement rather than argument:
the conditioning's magnitude and the feature blocks' sizes.

**What the numbers now say.** Even with both gains at unity, this build's chain
is only 35% explainable as a linear filter of its input, and the client's is
93%. A chain of FIRs with fixed kernels is exactly linear, so the missing 65%
is the kernels *changing* -- they are recomputed every sub-frame. The client's
change too and it stays 93% linear, which means its kernels barely move. So it
reduces to the same sentence from a third direction: **the client's kernels are
near-delta and stable, and this build's are spread and restless.**

### The conditioning is not the root, and the arithmetic says why

Two measurements killed the "conditioning too hot" reading, and the second one
redirects the whole search.

**First: the input blocks do not control it.** The 165-wide vector is uneven --
the cepstrum sits at rms 2.53 with a peak of 9.8 where every other block is
between 0.35 and 1.03 -- so the cepstrum looked like the source of the heat.
Scaling it down moves the perturbation-to-bias ratio from 8.75 only to 8.38 at
best, and costs dB all the way. It cannot: `conv1`'s `tanh` is already
saturated, so shrinking one input block does not shrink its output. The client
has **no** inter-stage normalisation either -- no LayerNorm, no divide, nothing
between the layers but `memcpy` -- so there is no missing factor to add.

**Second, and this is the one that matters.** For white input, a FIR's relative
contribution is `||h - delta||`. Inverting that:

| | contribution | implied kernel peak | implied `peak^2/energy` |
| --- | --- | --- | --- |
| the client | 15% | 0.989 | **0.978** |
| this build | 136% | 0.075 | 0.006 |

So the client's effective filter is a **near-perfect delta**. And the kernel
layer's bias, with **zero** conditioning, gives `peak^2/energy` 0.750 -- a peak
of 0.866, which is `||h - delta|| = 0.518`, a **52%** contribution.

**The structure as implemented here cannot reach 15% even with the conditioning
switched off entirely.** A perturbation nine times the bias cannot raise
delta-ness from 0.75 to 0.978 either; perturbations spread a kernel, they do
not sharpen it.

So the fault is not how hot the network runs. It is the `af` stage's
**structure**: this build computes `normalise(kernel) * input`, which replaces
the signal, and something in the client leaves the signal nearly intact and
adds a small correction. The conditioning's magnitude is downstream of that
question, not upstream of it.

### Four measurements, and what they turned out to mean

| what was measured | this build | what it should be |
| --- | --- | --- |
| contribution rms | 8964.8 | 301 (the client's) |
| correlation with the client | 0.105 | 0.95 (the measured ceiling) |
| kernel `peak^2/energy` | 0.239 | 0.750 (the bias alone) |
| perturbation / bias | 8.75 | well under 1 |

All four are the same fault seen from four sides: **the conditioning that
drives the kernel layer is roughly an order of magnitude too large.** Upstream
of it the feature net runs hot throughout -- `ft1` and `ft2` with 13% and 11%
of their outputs on the rails, `conv1`, `conv2` and `tconv` all peaking at
exactly 1.0, and `ft2` at rms 0.76 where the arithmetic through `alpha1_f` and
`alpha2` wants about 0.06.

That is where the next work goes, and it is now a quantity with a target rather
than a direction.

### What this settles

**The port is wrong.** Not inferred from a feature being worse than absent, not
from a version that could not be found -- measured against the client running
the same weights on the same material, with a control that discriminates.

**The version hypothesis is dead**, this time for good: these weights are the
client's, the client applies them, and the result is a working post-filter.

**And the reference pair exists on demand.** The client's Companion can be run
over any input, so every stage of this build can be bisected against it.

### The decibel bar was the silence value, not neutrality

This invalidates how a long series of results in this file were read, so it
goes before them.

**Output identically zero reads +0.00 dB against `clean.s16`.** The measure is
`10 log10(sum(clean^2) / sum((x - clean)^2))`, so an `x` of nothing scores the
energy of `clean` over itself. Zero is not the floor of this scale; it is the
value for producing no signal at all.

Measured on the same dump, with the input's level normalised to 1:

| | rms / input | dB |
| --- | --- | --- |
| output identically zero | 0.0000 | **+0.00** |
| the shaping switched off | 0.0569 | -0.07 |
| shaping fed `ft1` instead of `ft2` | 0.0505 | +0.01 |
| **not filtering (the input)** | **1.0000** | **+4.78** |

So **"the shaping switched off" emits 5.7% of the signal's level**, and the
`+0.22 dB` this project adopted as the bar for any change to the shaping is
that: the value for annihilating the signal, a fifth of a decibel above
silence. Every variant recorded as "reaching the bar" was not a disabled
filter leaving the signal alone -- it was a filter emitting nothing.

Two consequences:

- **The bar is `+4.78`, not `+0.22`** -- the value for not filtering, on this
  dump. A post-filter has to beat *that*, and the client does, by 0.45 dB on
  its own material.
- **The convergence pattern this file reads as "the less-filter trap" has a
  second cause.** Forty configurations converging on `+0.22` were not all
  converging on *inertness*; a family of them were converging on *annihilation*
  and scoring the same. The two are distinguishable in one column -- output
  rms against input rms -- and it was never printed.

### The `af` chain annihilates the signal, and the biases do not

With the shaping off entirely, the two adaptive filters alone emit 5.7% of
their input at a DC gain of 0.02. That is not a post-filter having a small
effect; it is one removing the signal. A unit-norm kernel whose coefficients
alternate in sign is a high-pass, and speech is not.

**The biases alone are the opposite, and they have zero delay.** Take each
kernel layer's bias, normalise it per output channel exactly as `adaconv`
does, and cascade the two stages -- pure arithmetic over the container, no
decode:

```
af1 c0:  +0.000 +0.043 ... +0.008 +0.866      <- peak on the LAST tap
af1 c1:  +0.000 +0.146 ... +0.234 +0.729
af4 i0:  +0.000 +0.103 ... -0.041 +0.568
cascade: peak +0.5950 at tap 30 of 30   ->   DELAY 0
```

Three things at once. **The tap order is confirmed** -- the bias puts its mass
on the tap this code treats as "now". **`COMPANION_FILTER_OFFSET 0` is
confirmed** -- the cascade of the biases is delay-free, matching the client's
peak at lag zero. And **the 20-sample delay is a symptom, not an offset**: the
perturbation drags the kernel's mass from tap 15 to tap 4, and 11 samples per
stage over two stages is the 20 that the fit reports.

An offset of 10 does move the fitted peak to tap 0 -- the peak moves exactly
`2 x offset`, which is the arithmetic confirming the mechanism -- and it is
**not applied**. It would be fitting a constant to a symptom, and the bias
cascade says the constant is already right.

### Bias domination is worth exactly the client's numbers

The perturbation cannot yet be made small by fixing its cause, so measure what
making it small would buy. `out = x + g * conv(...)` is what a bias-dominated
REPLACE already computes -- a bias that is nearly a delta makes `conv(k, x)`
nearly `x`, and the stage becomes the signal plus a correction. It is a
**proxy for bias domination, not a proposal to change the structure**; the
client's `adaconv` is REPLACE, read from its disassembly.

With the shaping off:

| | peak | tap | `peak^2/en` | DC | residual | contribution | dB |
| --- | --- | --- | --- | --- | --- | --- | --- |
| identity (not filtering) | +1.0 | 0 | 1.0 | +1.0 | 0% | 0 | **+4.779** |
| `g` 0.05 | +1.0007 | 0 | 0.9983 | +1.0493 | 1.5% | 100 | +4.850 |
| **`g` 0.075** | +1.0009 | 0 | 0.9962 | +1.0740 | 2.3% | 151 | **+4.862** |
| `g` 0.15 | +1.0016 | 0 | 0.9852 | +1.1480 | 4.4% | **302** | +4.796 |
| `g` 0.3 | +1.0030 | 0 | 0.9442 | +1.2968 | 8.0% | 605 | +4.255 |
| **the client** | +0.8512 | 0 | **0.9766** | +1.0399 | **7.0%** | **301** | +0.45 |

**An interior maximum above the identity.** `g` 0.075 beats not filtering by
0.083 dB and the curve falls away on both sides, so this is not the less-filter
trap: less filter converges on the identity's `+4.779` from below and this
exceeds it. **Nothing in this project had ever beaten the unfiltered
baseline.**

And at the contribution the client actually produces -- 302 against its 301 --
every structural measure lands in its neighbourhood at once: `peak^2/energy`
0.9852 against 0.9766, residual 4.4% against 7.0%, DC 1.148 against 1.040.

So the target has a number on it. Whatever makes the perturbation small has to
land somewhere equivalent to `g` between 0.10 and 0.15.

## The port matches the client, verified layer by layer

Every stage below was checked by reading the client's buffers while its network
runs (mode 6), recomputing the stage from the client's own inputs with the
container's weights, and comparing with what the client computed. Nothing in
this section depends on this build's decode matching the client's.

| stage | recomputed from the client's own inputs | error |
| --- | --- | --- |
| `conv2 = tanh(W [conv1(f-1) \|\| conv1(f)])` | corr 1.00000 | 1.5e-2 |
| `tconv = tanh(W conv2)`, 640 outputs in **block** layout | corr 1.00000 | 9.7e-3 |
| interleaved layout, for contrast | corr 0.04 | |
| GRU, one step per sub-frame over `tconv`'s slices, carried across frames | corr 1.00000 | 1.9e-2 |
| `ft1` over `[GRU state s-1 \|\| GRU state s]` | corr 0.99999 | 1.5e-2 |
| `ft2` over the **same** input | corr 1.00000 | 1.2e-2 |
| `ft2` over `ft1`'s output, chained | corr -0.13 | |
| both transforms' older input = the previous frame's last GRU state | exact | 0 |
| adaptive gains from the client's conditioning | corr 1.000000 | 4.6e-4 |

The errors are the client's int8 input quantisation, `round(127 x)`, which this
build does not reproduce and does not need to.

**Reading the client's code order from its disassembly** settles what the dumps
were: in `c7660`, `c4bd0` at `c7b47` is `tconv` (160 to 640, output at
`rbp-0x1430`); `c4c10`, called four times with a persistent state at
`rbx+0x600`, is the GRU, and each call's state is copied to one of four buffers
at `rbp-0x1e30`, `-0x1bb0`, `-0x1930`, `-0x16b0` -- the GRU's states, which an
earlier reading labelled `tconv`. `c50b0` at `c7c8f` is `ft1` (a kernel-2
convolution, `r9 = 2`) and at `c7cbc` is `ft2`, both reading `rbp-0x1e30`. Each
runs once per frame and covers its four sub-frames internally.

So the network's order in this build -- `conv2 -> tconv -> GRU per sub-frame`
-- was right all along. What was wrong was the wiring after it:

- **`af1` and `af4` read `ft1`'s output.** This build fed them the GRU's raw
  state.
- **`ft1` and `ft2` run side by side.** This build chained `ft2` onto `ft1`.

With both fixed, this build's conditioning correlates **0.9869** with the
client's, sub-frame for sub-frame (median 0.9921), where it read -0.06.

### End to end

Against the client's NoLACE over steady-state frames, each on its own decode:

| | this build | the client, mode 6 |
| --- | --- | --- |
| contribution, rms | 276.0 | 278.4 |
| effective filter `peak^2/energy` | 0.8983 | 0.8926 |
| DC gain | 1.083 | 1.119 |
| residual | 11.1% | 8.3% |
| rms out / in | 1.060 | 1.077 |
| cost against `clean.s16` | -0.12 dB | -0.18 dB |

Before these fixes: contribution 8964.8, residual 99.9%, cost 17.5 dB.

The two columns cannot be expected to agree exactly -- the pinned codec's MLow
and the client's differ by 10.6 dB of SNR on the same packets -- so what this
table shows is agreement to within what two different decodes permit, not
identity. `companion_test.c` passes in full, scale equivariance at 1.43x across
an eight-fold sweep.

### The last two stages, and the fifth fault

The shaping and the adaptive convolutions were checked the same way: their
inputs read out of the client at each of the four calls per frame, run through
this build's routines in sequence with state carried from one sub-frame to the
next, and the output compared with the client's.

| stage | correlation | worst error | SNR |
| --- | --- | --- | --- |
| `af1`, the adaptive convolution | 0.999998 | 8.5e-4 | 56.0 dB |
| the shaping, `tdshape1` | 0.999999 | 6.9e-5 | 54.5 dB |
| `af4` | 0.999999 | 1.3e-4 | 54.7 dB |

The shaping needed one fix to get there: **the twenty-first envelope slot holds
the envelope's mean.** The 20 pooled log-magnitudes are demeaned and the mean
goes in the extra slot, as the reference's `adashape_process_frame` does
(`tenv[tenv_size] = mean`). This build put a zero there, which read 0.846 and
5.9 dB; not demeaning at all reads 0.37.

The mean had been dropped because carrying it "made the filter's level move
with the exponential of the input's". That was measured with the adaptive
filters conditioned on the wrong vector and the transforms chained, and it did
not survive their fix: with the mean in place `companion_test.c` passes and its
scale-equivariance check improves, 1.43x to 1.28x.

The call arguments confirm the parameters without any fitting. The adaptive
convolution is called with `frame_size 80`, `overlap 15`, `kernel_size 16` and
`left_padding 15` -- causal, which is this build's filter offset of zero -- and
three floats: the gain span `1.3815510273`, a gain centre of `0`, and a
`shape_gain` of exactly `1.0`, which is neutral and which this build does not
need. The shaping is called with `avg_pool_k 4`, in place on `af1`'s second
channel, conditioned on `ft2`'s output.

**Every stage of the Companion is now verified against the client from the
client's own inputs.** What separates the two is the client's int8
quantisation of each dense layer's input, about 55 dB below the signal.

### What a caller must supply

Two things a real integration has to get from the decoder, because the
features cannot be computed without them:

- **The excitation** -- `fcb + adaptive + noise`, what the decoder drives its
  LPC synthesis filter with -- in `CompanionFrameState.excitation`.
- **Both pitch lags for every sub-frame.** The client averages two distinct
  lags. The codec's own feature dump keeps one in two, which is why this
  project's harness matches the autocorrelation exactly on sub-frames 0 and 3
  and not on 1 and 2; the extractor is not at fault.

## CTL 4058 is the codec's own LPC postfilter, and the target was the wrong component

**This invalidates the target this file has been measuring against**, so it
goes first.

`opus_decoder_ctl(dec, 4058, n)` -- recorded here as "the Companion's mode" --
is `OPUS_SET_USE_LPC_POSTFILTER`, a documented request in the pinned
`opus_mlow` (`include/opus_defines.h:186`). It selects:

| value | 16 kHz (WB) | as recorded from the client |
| --- | --- | --- |
| 0 `WB_OFF_SWB_ON` | off | dry |
| 1 `WB_ON_SWB_ON` | **on** | contributes rms 301, **+0.45 dB** |
| 2 `WB_ON_SWB_OFF` | **on** | byte-identical to 1 |
| 3 `WB_OFF_SWB_OFF` | off | dry, the client's default |

That table was measured on the client long before anyone read the enum, and
the enum explains every row of it: at 16 kHz, 1 and 2 enable the same filter
and 0 and 3 disable it. The filter is `smpl_lpc_postfilter`
(`smpl/smpl_postfilter.c`), applied per sub-frame with `A[sf]` in
`smpl_core_decoder.c:351`; a tilt runs instead when it is off.

**So "the client's Companion in mode 1 -- identity plus seven percent, peak
+0.8512, rms 301, +0.45 dB" was the classical postfilter.** Counting how often
each function runs over a 546-frame decode:

| mode | feature extractor `c8330` | the network `c7660` | adaptive conv `c35f0` |
| --- | --- | --- | --- |
| 1 | 546 | **2** | 16 |
| 6 | 546 | **546** | 4368 |
| 7 | 546 | 486 | 3888 |

In mode 1 the network runs for two frames when the mode engages and never
again; the other 544 are the postfilter. **The NoLACE target is mode 6**, which
the pin does not accept -- it rejects anything above 3 -- and which is where
the network runs every frame. Measured over steady-state frames only:

| | peak | `peak^2/en` | DC | residual | contribution |
| --- | --- | --- | --- | --- | --- |
| mode 1, the LPC postfilter | +0.8553 | 0.9780 | +1.0400 | 7.01% | 301 |
| **mode 6, NoLACE** | **+0.9012** | **0.8926** | **+1.1192** | **8.25%** | **278** |
| mode 7 | +0.9242 | 0.9157 | +1.0897 | 8.72% | 244 |

Two consequences. **This library can enable the postfilter with one CTL**, no
port needed. And every comparison in this file against "the client's
Companion" before today measured the postfilter, not the network.

The tracer that "only survived two frames" was never broken: in mode 1 the
network runs twice. Its exit-time `SIGSEGV` is a destructor in another library,
at an address past the end of `libopus_mlow.so`'s text.

## The feature extractor is exact against the client

Read out of the client's memory in mode 6, on voiced frames with a warm decoder
on both sides, and compared vector for vector:

| block | before today | now |
| --- | --- | --- |
| `[0:64]` clean spectrum | 0.799 | **1.000** (the LPC sign) |
| `[64:82]` cepstrum | 0.599 | **1.000** (the excitation) |
| `[82:87]` autocorrelation | 0.288 | **exact to 1e-7** on sub-frames 0 and 3 |
| `[87:89]` ltp gains | | 0.969 |
| `[89:92]` decode context | | 0.979 |
| `[157:165]` bit count | | 0.991 |
| **all 165** | | **0.966** |

**The cepstrum and the pitch correlation read the decoder's excitation, not the
decoded speech.** The excitation is `fcb + adaptive + noise`, what the decoder
drives `smpl_filt_ar16` with. Computed from the speech the cepstrum correlated
0.599 with the client's and its `c0` averaged -5.17 against the client's
-10.06; computed from the excitation it correlates **1.000** and averages
**-10.063** against **-10.063**.

The encoder's LPC residual of the clean input (`reslpc.f32`) gets 0.994 -- close
only because a CELP decoder's excitation is built to approximate it, and not
usable because a decoder never has it.

The autocorrelation's remaining mismatch is the harness, not the extractor:
`features_period` keeps one lag in two, so sub-frames 1 and 2 are given the same
lag twice where the client averages two distinct ones. Where the lag is right,
the values agree to 1e-7.

`CompanionFrameState` now carries `excitation[COMPANION_FRAME]`, and both the
cepstrum and the correlation read it.

## The last layers are exact, and the fault is between `conv2` and `h`

Two stages are now verified against the client's live values, using its own
inputs:

- **The gain layers.** The client's conditioning passed through this build's
  `af1_gain` and `af4_gain` reproduces the gains the client computed to a
  worst error of **4.6e-4** over 96 gains, correlation **1.000000**. Weights,
  bias, layout and `exp(1.3815510273 * tanh(W h + b))` are all right.
- **`conv1 -> conv2`.** The client's `conv2` output recomputed from its own
  `conv1` outputs as `tanh(W [conv1(f-1) || conv1(f)])` correlates **1.00000**,
  worst error 8e-3, which is the client's int8 input quantisation.

And the wiring of the conditioning is now read rather than inferred:

**`h = tanh(ft1 . [state || input])`**, over all 160 sub-frames of a 40-frame
trace, worst error 1.5e-2. The call that produces it is a kernel-2 convolution
(`r9 = 2`, `r8 = 160`) whose output is the vector `af1` and `af4` both read. So
**the adaptive filters are conditioned on `ft1`'s output**, where this build
conditions them on the GRU's hidden state and gives `ft1` only to the shaping.

What `ft1`'s input and state are is not yet settled. The input correlates about
0.65 with every slice of the client's `tconv` output and is none of them; it is
not this build's GRU hidden state either (0.58, flat across lags, which is the
shared per-channel bias rather than the content). A hardware watchpoint on the
buffer caught only stack reuse by later functions, so that route needs the
writes filtered to the lifetime of `c7660`.

## Why the test's level check moved

With the excitation at zero every band reads `ln(1e-9)` and `c0` sits near -88,
where the client's sits near -10; that saturated the network and the median
frame came out at **705 times** its input. `companion_test.c` now drives the
excitation with the residual of its own test signal through its own predictor,
which is the excitation consistent with that signal, and the median frame reads
**0.57**.

The scale-equivariance check still fails, at 4.56x across an eight-fold sweep
where it read 7.7x. That is the failure recorded above -- the cepstrum's `c0`
carries the absolute level -- and moving the cepstrum onto the excitation does
not remove it, because the excitation scales with the signal too. It is **not**
fixed, and the brief pass it showed with the excitation at zero was an artefact
of the cepstrum no longer seeing the input at all.

## RETRACTED in part: the floor and the hot conditioning were silence

The section below read the client's gains, kernels and conditioning from the
first stops of a trace -- and **the tracer only survives two frames**, which
are the first two frames the Companion runs on. Those are silent. Everything
signal-dependent read there describes silence, not speech.

Re-read on voiced material (packets from frame 19, the loudest window in the
file):

| | read on silence, and reported | read on voiced frames |
| --- | --- | --- |
| `af1` gains | 0.2580 / 0.2512, the floor | **2.1413 / 1.9905** |
| stops at the floor | 100% | **0%** |
| conditioning rms | 0.9537 | **0.7121** |
| conditioning `\|.\|` > 0.99 | 52.3% | **8.1%** |

So three claims below are **withdrawn**:

- *"The floor is the right gain, not saturation going wrong."* The arithmetic
  stands -- a smooth 16-tap kernel at unit norm has DC 4, and `4 x 0.2512 =
  1.005` -- but it describes what the client does on silence. On speech its
  gains sit near **2**, which is nowhere near this build's 1.03 / 0.28 / 0.26.
- *"The conditioning is half saturated and this build runs cold by a factor of
  eight."* On speech the client's conditioning is rms 0.712 and 8.1% saturated,
  **comparable to this build's** 0.56 and 6%.
- *"`af1` is a filterbank, a low-pass and a band-pass."* The kernels were read
  on the first frame, which is silent; the shapes may be what silence produces.

**What stands, because it is structural rather than signal-dependent:** that
`af1` and `af4` read the same conditioning bit for bit; that tap 0 of each
16-block is zero; that the normalised kernel is the raw one times
`gain / ||kernel||`; and that the loop at `c3e30` is the inter-frame kernel
cross-fade.

**And the one that matters most stands too.** The LPC sign fix was verified on
a voiced frame against the clean spectrum, which is computed from the decoded
LPC -- the bitstream -- and is therefore immune to the cold start that
contaminates every signal-derived comparison here. See the next section.

### Why the comparison is still contaminated, and what would fix it

The voiced reading came from feeding the client packets starting at frame 19,
so its decoder starts **cold** there, while this build's features come from the
whole file with a warm decoder. That splits the 165 cleanly:

| block | derived from | correlation with the client |
| --- | --- | --- |
| `[87:89]` ltp gains | bitstream | **0.976** |
| `[89:92]` decode context | bitstream | **0.986** |
| `[157:165]` bit count | bitstream | **0.997** |
| `[0:64]` clean spectrum | bitstream (the LPC) | 0.799, and **0.995 after the fix** |
| `[93:157]` pitch embedding | bitstream (the lag) | 0.765 |
| `[64:82]` cepstrum | the signal | 0.615 |
| `[82:87]` autocorrelation | the signal | 0.485 |

Every bitstream-derived block matches; every signal-derived block does not.
That is what a cold start does, so the signal-derived blocks cannot be judged
from this reading, and neither can the conditioning, which depends on all 165.

What would fix it is a trace that survives into the file with a warm decoder.
Two approaches failed: the tracer loses its breakpoint after two frames, and
inserting the breakpoint mid-run -- after a second stop at frame 19, whether by
`SIGSTOP` or `SIGUSR1` -- kills the child with `SIGSEGV` before the first hit.
The harness itself also segfaults at exit, after writing complete output, which
is a separate and pre-existing fault.

## The predictor polynomial subtracts

This is the largest fix to the feature extractor, and it came from reading the
client's own feature vector rather than from any metric.

The feature is `0.3 ln(sum w / |A|^2)`, band-pooled, for the whitening
polynomial `A`. The codec dumps **predictor** coefficients -- what the
synthesis filter adds back -- so the whitening polynomial is
`A(z) = 1 - sum a_i z^-i`. This build wrote `1 + sum a_i z^-i`.

For voiced speech the coefficients sum to nearly one, so the difference is
between `A(DC)` near **0** and near **2**:

| sub-frame | the client, band 0 | `1 - sum a` | `1 + sum a` (as built) |
| --- | --- | --- | --- |
| 2 | +2.6380 | **+2.6711** | -0.4124 |
| 4 | +2.7956 | **+2.8426** | -0.4133 |
| 6 | +2.9543 | **+3.0159** | -0.4139 |

With the plus, the low bands came out **flat at -0.41** where the client's rise
to +2.6 on the formant; the sixteen lowest bands correlated **0.115** with the
client. With the minus the whole 64-band block correlates **0.995**, by quarter
0.983 / 0.985 / 0.969 / 0.822, at rms 1.085 against the client's 1.122 and mean
+0.045 against +0.048.

**This convention was recorded here as ruled out** -- "negating it is worse in
the cell that matters". It was ruled out on the decibel oracle, which cannot
see it: a wrong envelope makes the filter inert, inert output is near silence,
and silence scores +0.00 dB. The same pattern this file names over and over,
this time with the correct answer on the wrong side of it.

The effective filter moves with it -- its peak turns positive, -0.3172 to
+0.4140, and its DC gain goes 0.0854 to 0.7613 -- while the output is still far
from the client's (residual 99.0%, -13.31 dB), because what consumes the
features has not yet been checked against the client on speech.

## The client's internals are readable on demand, and the conditioning is the root

`ptrace` needs no debugger. This WSL has neither `gdb` nor `lldb`, and
interposing libm sees nothing because the Companion's arithmetic is inlined and
vectorised -- but `fork` + `PTRACE_TRACEME` + `execv` with an `INT3` at a known
offset reads any value in the client's memory, and the harness is already a
child process, so `yama`'s `ptrace_scope` of 1 does not apply.

The recipe, in `wsl/peek.c` and `wsl/peek.sh`: the child writes the library's
load base (`dladdr`) and calls `raise(SIGSTOP)` after registration, which
removes the race; the parent reads the base, pokes `0xcc` at `base + offset`,
and on each trap reads the registers, `PEEKDATA`s the frame, restores the byte,
single-steps and re-inserts. **Offsets come from the disassembly, values come
from here** -- and three readings that looked settled in the disassembly turned
out to be something else when the values were read.

### What the client actually holds

At `base + 0xc3a20`, the frame of the adaptive convolution:

| | the client | this build |
| --- | --- | --- |
| `af1` channel 0 gain | **0.2580** | 1.0323 |
| `af1` channel 1 gain | **0.2512**, the floor exactly | 0.2793 |
| `af4` gain | **0.2512**, the floor exactly | 0.2646 |
| pre-normalisation kernel, `peak^2/energy` | 0.22 | 0.18 - 0.20 |

**The floor is not saturation going wrong -- it is the right gain**, and the
earlier reading of it as pathology is withdrawn. A smooth 16-tap kernel
normalised to unit L2 norm has a DC gain of `sqrt(16) = 4`; multiplied by
`0.2512` that is **1.005**. The floor of `exp(-1.3815510273)` is what makes a
broad filter unity-gain, and the client sits there deliberately.

**The client's `af1` is a filterbank.** Its two raw kernels, read live:

```
c0: +0.00 +0.52 +0.82 +0.49 +1.11 +1.14 +1.10 +1.27 +1.09 +1.06 +0.95 +1.16 +1.24 +0.97 +0.68 +0.53
c1: +0.00 -0.39 -1.27 -0.33 +0.75 +2.24 +2.64 +1.70 -1.29 -2.20 -3.09 -2.00 +0.32 +2.17 +1.25 -0.07
```

Channel 0 is smooth and entirely positive -- normalised it sums to **0.9632**,
a unity-DC low-pass. Channel 1 oscillates and sums to **0.0167**, a band-pass
with no DC. And `af4`'s kernel on one of its two inputs is **essentially zero**
(rms 0.03 against 8.0 on the other), so it discards a branch outright. Whatever
carries the low-pass branch to the output, it is not `af4`.

**Three things this confirms for free**, from the client's own memory rather
than by inference: index 0 and index 16 of every kernel read exactly `+0.000`,
which fixes the layout as `[channel][tap]` over 16 taps with tap 0 zeroed; the
normalised kernel at `[rbp-0xaf0]` is the raw kernel times a constant 0.068,
and `gain / ||kernel|| = 0.258 / 3.78 = 0.0683`, which confirms the per-channel
L2 normalisation with the gain folded in; and the loop at `c3e30` that reads
those buffers alternates per *output channel*, not per sample, so it is the
**inter-frame kernel cross-fade this build already implements** -- not a
dry/wet mix, which is the third time that loop has been read as one.

### `af1` and `af4` read the same conditioning, bit for bit

The stops alternate four with `out_channels = 2` (`af1`, one per sub-frame) and
four with `out_channels = 1` (`af4`). Comparing the conditioning vector at each:

```
stop 0 == stop 4    correlation 1.00000
stop 1 == stop 5    correlation 1.00000
stop 2 == stop 6    correlation 1.00000
stop 3 == stop 7    correlation 1.00000
```

**Identical.** So the client feeds both adaptive filters the same vector, which
is what this build already does, and the reference's chained wiring
(`af4 <- ft2`) is refuted from the client rather than from a metric. The
section above that reopened it on the effective-filter oracle is settled by
this, against the oracle: `af4 <- ft2` moved the peak and the DC for a reason
that was not the wiring.

### The root: this build's conditioning is unrelated to the client's

| | mean | rms | `\|.\|` > 0.99 | correlation with the client |
| --- | --- | --- | --- | --- |
| **the client** | -0.2017 | **0.9537** | **52.3%** | 1.0000 |
| this build, `tconv -> GRU` (as built) | -0.0528 | 0.5909 | 6.5% | **+0.1281** |
| this build, `conv2 -> GRU -> tconv` (the reference) | -0.0216 | 0.5617 | 0.4% | +0.0294 |

The controls: the client's conditioning against itself a frame later reads
**+0.90**, and this build's against itself **+0.81**. So +0.13 is not an
alignment artefact between two different decodes -- **the two vectors are
unrelated**.

And the difference has a shape. The client's conditioning is **half
saturated**, rms 0.954, very nearly a vector of signs:

```
-0.657 -0.778 -0.719 -0.992 -0.923 -0.881 +0.980 -0.138 -0.995 +0.754 ...
```

**This reverses a reading held all day, including in the sections above.** The
diagnosis was "this build's feature net runs saturated, and saturation destroys
the conditioning's direction". It runs **cold**: 6.5% against the client's
52.3%, a factor of eight the other way. For a `tanh` to sit above 0.99 in half
its units its pre-activation has to exceed 2.65 there; this build's run between
0.6 and 2.0. Every remark above about `conv2`'s 35% being abnormal is withdrawn
-- the client is further along the same road.

The reference's feature-net order is refuted a third time on the way, and this
time against the client rather than against decibels: it gives *less*
correlation and *less* saturation.

**So the fault is upstream of everything measured so far.** The adaptive
filters, their gains, their normalisation, their tap order, their cross-fade
and their wiring are all confirmed against the client. What feeds them is not,
and bisecting the feature net -- the 165 features, then `conv1`, `conv2`,
`tconv`, the GRU -- is what remains.

### A REPLACE structure cannot reach the client's delta-ness, whatever the conditioning

This refutes the working hypothesis both sides of this work held, and it is
arithmetic over the container with no decode in it.

The hypothesis was that the client's near-delta effective filter --
`peak^2/energy` **0.9766** -- comes from its pre-normalisation kernel being
dominated by its bias. The supporting number, 0.750, is the delta-ness of
**one** kernel layer's bias. The client's 0.9766 is the **cascade** of two.

Convolution spreads. Cascading the two biases, each normalised per output
channel exactly as `adaconv` does:

```
peak +0.5950 at tap 30 of 30  ->  delay 0,  peak^2/energy 0.2625
```

Two filters at 0.750 each give **0.2625** together, not 0.750. Measured end to
end with the conditioning at zero and the shaping off, the whole chain reads
`peak^2/energy` 0.42, DC 0.343, residual 9.9%.

And no conditioning improves it: the L2 normalisation fixes the kernel's
*shape* by its direction, and the bias's direction is the best available --
every conditioning moves away from it. The highest this work has ever measured
under REPLACE is 0.687, and only with an artificial filter offset.

**So bias domination is necessary and not sufficient.** Something in the client
puts an actual delta in the path, which is what a dry signal added back does.

### The dry blend is real, read from the binary, and not enough on its own

The client does not replace the audio with the Companion's output: it mixes,
under a window read from `libopus_mlow.so` at `0x1a870`,
`w[n] = cos(pi (n + 0.5) / 320)` for `n < 160` and zero after -- mean weight
0.159, which is inside the range where the additive proxy above reproduces the
client. Applying it here, with and without the reference's conditioning chain:

| | peak | tap | `peak^2/en` | DC | residual | dB |
| --- | --- | --- | --- | --- | --- | --- |
| replace (as built) | -0.3172 | 20 | 0.1505 | +0.0854 | 99.8% | -13.01 |
| **the window, read from the binary** | **+0.6907** | **0** | **0.6230** | +0.7064 | 97.3% | -8.99 |
| the window + the reference's chain | +0.7119 | 0 | 0.5744 | **+1.4050** | 79.1% | -2.79 |
| **the client** | +0.8512 | 0 | **0.9766** | +1.0399 | **7.0%** | +0.45 |

The blend moves four measures at once -- the peak to lag zero, its sign
positive, `peak^2/energy` from 0.15 to 0.62, the DC from 0.09 to 0.71 -- which
is more than any single change tried before it. **And the residual stays at
97.3%**, because a blend scales the wet path's variance without taming it.

That bounds what the blend can be: the client's residual of 7.0% requires its
**wet path** to be near-identity too, not merely mixed down. A top-level blend
of a wild wet signal cannot produce 7%; at the mixing weight that matches the
client's contribution of 301 it would leave about 15%, and its peak would sit
at +1.0 rather than the client's +0.8512. So the client has both: stages that
stay close to the signal, and a dry path.

### Neither a scale on `h` nor anything hidden in the container

Two more closed, so they are not re-run.

**The conditioning's magnitude cannot fix both stages, by a factor of 13.**
With `af4_gain`'s weight norm at 5.135 and `h` at rms 0.59, the gain's
pre-activation runs near 3.0 and `tanh` saturates; bringing it to 0.8 needs `h`
at rms 0.155. Bringing the *kernel's* perturbation below its bias needs `h` at
rms 0.012. The two requirements are incompatible, so no uniform scale on the
conditioning is the answer -- what is missing is structure, not level.

**The container has nothing unread.** All 48 chunks are consumed: nine int8
layers at four chunks each (`_bias`, `_weights_int8`, `_scale`, `_subias`) and
six float layers at two. There is no per-layer output scale hiding anywhere.

**And the client's own arithmetic cannot be read by interposition.**
`libopus_mlow.so` imports `expf`, `exp`, `exp2f`, `exp2`, `powf`, `tanhf`,
`logf`, `log` and `log10` from libm, and the harness already loads its shim
`RTLD_GLOBAL` before it, so all nine can be interposed and logged. They are,
and the counts come out **byte-identical between mode 1 and the dry mode** --
`expf` 3124, `exp` 664, `exp2f` 2345, `powf` 2184, `logf` 1110, `log` 159600,
`tanhf` zero. The Companion calls none of them: its arithmetic is inlined and
vectorised. Reading its gains needs `ptrace`, and this WSL has neither `gdb`
nor `lldb`.

### Three more weight layouts confirmed, by the same oracle as `conv1`

An input group with a natural order gives neighbouring weight rows that
resemble each other. Two layers had such an input and had never been tested:

| layer | the assembly in use | the alternative | random control |
| --- | --- | --- | --- |
| `fnet_conv2`, 768 = 96 channels x 8 times | `[time][channel]` **+0.4793** | `[channel][time]` -0.0229 | +0.0013 |
| `ft1`, 320 = 2 x 160 | `[previous \|\| current]` **+0.3558** | interleaved +0.0058 | +0.0055 |
| `ft2` | **+0.1938** | +0.0032 | -0.0017 |
| `tdshape1_alpha1_f` | **+0.1355** | +0.0043 | +0.0070 |

`conv2`'s correlation decays cleanly with separation in time -- 0.479, 0.128,
0.039, -0.038 -- which is the signature of a real ordering rather than a
coincidence.

**`af1_gain` is confirmed too, by its structure rather than by correlation.**
Its input has no natural order, but its two output channels must not be alike:
one is the pass-through. Under `[in][out]` the per-channel weight norms are
**0.596 and 4.919**, the eight-fold asymmetry this project already recorded,
with channel 0 the quiet one. Under `[out][in]` they are 3.449 and 3.558 --
two indistinguishable channels, and no pass-through. The asymmetry is the
evidence.

### The saturation is the level, not one feature block

Every block of the 165 contributes to `conv1`'s pre-activation, and none
dominates: **1.14** (clean spectrum), **1.13** (cepstrum), 0.57
(autocorrelation), 0.04 (ltp gains), 0.53 (decode context), 0 (side index),
0.90 (pitch embedding), 0.24 (bit count) -- about 2.0 in quadrature, where
`tanh` is already at 0.96.

So the cepstrum's rms of 3.0 and peak of 11, six times every other block, is
not the cause: `conv1`'s weights on its rows are small, exactly as a trained
layer treats a large feature. And the input's absolute scale is not it either
-- sweeping the signal from 1x to 32768x leaves the perturbation-to-bias ratio
at 8 to 9 and the residual at 99.8% throughout, while the cepstrum's own peak
goes 11.0, 6.6, 18.7, 33.2. Whatever runs the network hot is the general level
of the 165, and the network has no normalisation between stages to contain it.

### Two of the three gains are pinned at the floor

Measured over the same speech:

| | mean gain |
| --- | --- |
| `af1` channel 0 | 1.0323 |
| `af1` channel 1 | **0.2793** |
| `af4` | **0.2646** |
| the floor, `exp(-1.3815510273)` | 0.2512 |

Two of the three sit on the floor throughout, which no trained gain does. And
the weights say why: across all fifteen layers, every weight matrix has an rms
between 0.077 and 0.149 -- except the two gain layers, at **0.277** (`af1`)
and **0.406** (`af4`), and `pitch_embedding`, which is a lookup rather than a
matmul. With a fan-in of 160 and a conditioning at rms 0.55 that is a
pre-activation near 2.8, and `tanh` saturates by construction.

Either the client's conditioning into these two layers is far smaller than
this build's, or something sits between the two that this build does not have.
The kernel layers show the same disease one stage over, so it is likely one
cause.

### Refuted on this oracle

- **The reference's feature-net order.** `conv2 -> GRU -> tconv`, the GRU
  stepping once per frame and `tconv` upsampling its state, is what NoLACE
  does and the dimensions permit it exactly (`gru_input` 160->480 is three
  gates of 160; `tconv` 160->640 is four sub-frames of 160). It is worse on
  every axis: residual 93.4% against 38.0%, and the level moves further from
  the client. The existing order stands.
- **A scale on the conditioning.** Swept from 0 to 1 with and without the
  shaping. It trades the peak against the DC and never brings both; the
  points that match one of the client's numbers exactly -- DC +1.0400 at
  `k` 0.05 with shaping, peak +0.8504 at `k` 0 without -- match only that one,
  which is curve fitting and is recorded as such.

### Where the conditioning chain now stands

The wiring experiment recorded above as undecidable -- `af1 <- hidden`,
`tdshape <- ft1`, `af4 <- ft2`, the reference's order -- is no longer
undecidable, because the effective-filter fit is not blind where the decibels
are. The control that separates it from inertness:

| | peak | tap | DC | residual | dB |
| --- | --- | --- | --- | --- | --- |
| as built | -0.3172 | 20 | +0.0854 | 99.8% | -13.01 |
| the shaping switched off entirely | -0.0635 | 20 | +0.0201 | 71.1% | -0.07 |
| **`af4 <- ft2` alone** | **+1.0219** | 20 | **+1.6742** | 97.1% | **-16.42** |
| the reference's order | +0.8423 | 20 | +2.2086 | **38.0%** | -7.88 |

`af4 <- ft2` has the **worst** decibels in the table and the largest
contribution anywhere, so it is not a weakening -- and it is what turns the
effective filter's peak positive and restores its DC. A change that worsens
every level measure while fixing the filter's sign is the inverse of the trap
this file keeps meeting. And the full order reaches 38.0% residual where
*removing the shaping altogether* only reaches 71.1%.

It is **not applied yet**: the same order makes the shaping inert (switching
the shaping off under it changes nothing, -7.84 against -7.88), so what it
fixes and what it disables are still entangled. Settling it needs the client's
pre-normalisation kernel, which is what this work is now waiting on.

## RETRACTED: the client was not applying the Companion at all

**This section claimed the client runs these weights and is neutral, and that
the port is therefore what is wrong. That is withdrawn.** The client was not
applying the Companion in the configuration tested; "neutral" was absence, and
the control that was supposed to rule absence out did not.

**What the control missed.** Registering the weights and registering them
scaled by 1.05 and by 1.2 produce output that is **byte-identical** -- the same
md5 across all three -- and each differs from registering nothing by exactly
**two samples out of 174720, by one LSB.** A post-filter whose weights change
by a fifth cannot produce identical audio. Two samples of difference is the
registration touching decoder state, not a filter contributing.

The curve that was read as a graded response is a threshold:

| float32 weights scaled by | contribution rms | samples changed |
| --- | --- | --- |
| 1.0, 1.05, 1.2 | **0.0034**, identical | 2 |
| 1.5 | 1.23 | 115 |
| 2.0 | 5146 | 3.7% |
| 3.0 | 32825 | 99.97% |

Flat and bit-exact to 1.2, then breaking. That is something leaking past a
guard once the values are absurd, not a filter scaling with its weights. The
earlier reading -- "it runs and chooses to do almost nothing" -- required the
contribution to *move* with the weights, and it does not.

**The mechanism was in the disassembly and this measurement should have waited
for it.** The chain runs under a transition machine: `mode == 0` copies the dry
signal, `mode == 3` is steady state, and a computed `ramp` modulates the
Companion's intensity inside the chain. Registering the weights sets two flags
-- `+0x10a68` and `+0x10dac` go 0 to 1 -- but nothing in the harness drives the
mode, so the dry path is what runs.

**So the version question is open again** and none of what follows it is
overturned. What stands from that work: the client's codec runs here, the
registration path is real and reaches the decoder, and the harness is the
instrument the rest needs.

**And the lesson is the one this file keeps relearning, in a new costume.** The
control was designed to distinguish "running and neutral" from "not running",
and it used a perturbation so violent that it answered a different question.
The discriminating test was the cheap one: **scale the weights by a fifth and
check the bytes.** A correct control moves the thing it is testing by a little,
not by a lot.

### What this had claimed

### How it was registered

The client's library exposes it through its public interface:
`opus_decoder_ctl(dec, 4085, blob, len)` takes the container **raw** and parses
it itself. It returns `OPUS_OK` and writes 142 int32 words into the decoder,
two of which go from 0 to 1, at `+0x10a68` and `+0x10dac`. (The registration
also exists as `init_companion(model, ctx)` at vaddr `0xc9b20`, taking a
caller-allocated destination and a parsed `WeightArray`; it returns 0 but
touches nothing in the decoder, so it fills a structure the decode path never
reads. The CTL is the live path.)

### The control that makes it a measurement

Neutral output could mean the Companion never ran. It does not: perturbing the
weights changes the output, so they reach the computation.

**But perturb them meaningfully.** The container mixes float32 and int8
chunks, and a first pass here scaled every four bytes as a float -- which for
an int8 chunk reinterprets four weights as a float and rewrites them
arbitrarily. That is corruption, not scaling, and the graded curve it produced
(2% of scale moving 5.9% of samples) was **graded corruption**. It was reported
here as a knife-edge sensitivity and that reading is withdrawn.

Restricted to the chunks that are actually float32:

| perturbation | samples changed | output rms |
| --- | --- | --- |
| float32 x 1.1 | **0.001%** | 2014.7, unchanged |
| float32 x 2.0 | **3.723%** | 5525.9 |
| int8 bytes as float, x 1.1 | 8.765% | 9282.9 |
| int8 bytes as float, x 2.0 | 7.240% | 7921.4 |

Doubling the float weights produces a real, graded, non-saturating response,
and a ten percent change produces none. **The client's Companion is robust**,
not fragile -- which is what a trained network should be, and which makes this
build's behaviour the anomaly rather than the model's.

Both rows confirm what the control is for: the weights are used, so neutral
output is the filter running and choosing to do almost nothing.

### The size of the effect, which is the sharpest number here

Subtracting each implementation's unfiltered signal from its filtered one gives
what its Companion actually contributed:

| | signal rms | contribution rms |
| --- | --- | --- |
| client | 2014.7 | **0.0034** |
| this build | 1972.5 | **8964.8** |

The client's post-filter moves the audio by **less than one quantisation step**
-- 115 dB below the signal. This build's moves it by **four and a half times
the signal itself**. The ratio is **2.6 million**.

**And the response to perturbation is non-linear**, which says what the client
is doing. Doubling the float weights changes 3.7% of samples and lifts the rms
to 5525.9; a ten percent change does nothing at all. A linear stage cannot do
that. An **exponentiated** gain sitting at zero can: `exp(0)` is 1, identity,
and `exp(2x)` for a doubled exponent is not.

So the client's shaping exponent is **approximately zero** and its gain is
**approximately one**. This build's exponent has a median of -1.9 and a tail to
+20.6, with a median per-sub-frame peak gain of 331.

That is the defect stated as a target: **the exponent should come out at zero
and it does not.** Everything else measured here -- the group ablations, the
4 kHz localisation, the `k = -0.5` optimum -- was a description of that gain
being wrong, seen from the output.

### Where the 17.5 dB sits, and what the weights say it should be

Forcing each gain stage to unity in turn, against +4.78 unfiltered:

| shaping gain | `af` gains | dB from clean |
| --- | --- | --- |
| as computed | as computed | **-12.77** |
| **1** | as computed | **+0.23** |
| as computed | **1** | -15.84 |
| **1** | **1** | **+2.56** |

So the shaping's exponent carries **13 dB** of it, the `af` gains about 2.3
more, and **2.2 dB remain in the kernels** with both gains neutralised. Three
stages, but not three bugs: `af1`, `tdshape1` and `af4` all read the same
conditioning, so one magnitude wrong upstream moves all three.

**And the weights say what that magnitude should be.** `alpha2`'s weights sum
to `|w| = 12.5` per output channel, so the exponent it produces scales with its
input:

| constant input to `alpha2` | exponent mean | span | gain |
| --- | --- | --- | --- |
| **0.1** | +0.078 | 0.77 | **1.06** |
| 0.5 | +0.81 | 2.89 | 2.15 |
| 1.0 | +1.73 | 5.53 | 5.25 |
| 2.0 | +3.56 | 10.81 | 31.2 |

For the gain to sit at one -- which is what the client's neutrality means --
`alpha` has to be about **0.1**. This build's is about **3**, from an
`alpha1_f` span of 5.8.

Tracing the magnitudes through, the whole feature net runs hot: the GRU's
hidden state reads rms 0.59 with 6.3% at the rails, `ft1` 0.73 with 13.1%,
`ft2` 0.76 with 11.3%, and `conv1`, `conv2` and `tconv` all peak at exactly
1.0. Working backwards from `alpha1_f`, whose weights turn an input of rms 1
into an output of rms 0.8, **`ft2` would have to read about 0.06** for the
exponent to land at zero. It reads 0.76 -- **twelve times too large.**

`alpha2`'s bias is also worth recording, because this file has it wrong
elsewhere: it is **-0.1053** on average, not +0.105. With no input at all the
exponent is negative and the gain 0.90.

### The comparison, on identical input

One encode, one packet set, four decodes:

| | delay | dB from clean |
| --- | --- | --- |
| pinned codec, no Companion | 0 | **+4.78** |
| client, nothing registered | 46 | **+2.25** |
| client, with these weights registered | 46 | **+2.25** |
| **this build, the same weights** | | **-12.77** |

The client's two rows differ by one LSB on 0.001% of samples. This build's row
is 17.5 dB below its own unfiltered signal.

### What this overturns

**The version hypothesis is dead**, and with it the reading that every piece
checking out while the output stays wrong implies the numbers are from a
different model. The numbers are the right numbers. Everything this file
established about the feature being client-exact stands -- it was all true, and
it was all beside the point.

**And the trap that governed this whole investigation has a name now.** Each
piece was verified against the client in isolation and each one passed. The
defect is in something no isolated check covers: how the pieces are composed.
A chain of individually correct stages can still be wrong, and nothing short of
running the whole chain against the whole chain finds it.

### What this buys

The reference pair this work has wanted since the beginning now exists, and it
is not a single (input, output) sample -- it is the client's Companion, on
demand, for any input. Every ablation that has been argued about here can be
settled by running both and diffing, stage by stage:

1. The decoded signal the client feeds its Companion, against `coded.s16`.
2. Its output frame by frame against this build's, on the same frame.
3. Each internal stage, once the composition fault is located by bisection.

**The bar has changed too.** It is no longer +0.22 dB, the value for switching
the shaping off. It is the client's own output, which is neutral -- so the
target is a port that also comes out neutral on this material, and any
configuration that reads -12 is wrong no matter what it explains.

## Picking this up again

**State.** The client's Companion runs here now -- register through CTL 4085,
then `opus_decoder_ctl(dec, 4058, 6)` -- and it costs **0.17 dB** where this
build costs **17.5**. The port is wrong, established against the client on the
same weights and material with a control that discriminates. The version
question is closed.

The reference pair exists on demand, so the work from here is bisection.

**`native/companion_test.c` fails, and it should.** The port is not
scale-equivariant once all four predictor sets are fed, and the cepstrum's `c0`
is the identified cause. Do not make it pass by feeding half the sets again.

**Everything that could be read has been read, on both platforms.** The feature
extractor matches `osce_features.c` line by line. The clean spectrum's chain
matches the client op for op -- the reciprocal settled by dataflow rather than
by opcode, the filterbank tables byte-identical, the `320` accounted for, the
natural log, the epsilons. The same tables and constants are in
`libopus_mlow.so`, which is where the weights came from, so the platforms do
not differ. Every boundary of the 165-wide vector is confirmed from the weights
themselves. The int8 layout, the state taps, the leaky slope, the activations
and the bit-count embedding's whole formula are confirmed.

**And the feature is worse than absent.** Zeroing the clean spectrum reads
-7.48 where feeding it reads -12.34, and no treatment of it -- rescaling,
reordering, demeaning, freezing, offsetting -- beats simply removing it. The
only thing that does is flipping its sign, and that is the trap.

### The conclusion does not rest on the dB oracle, and it must not

The argument that these weights are the wrong ones runs: the feature is
confirmed correct, the consumer is confirmed correct, and the model treats the
feature as worse than absent -- which a shipped model cannot do. **That last
step is unsound as stated**, and it was stated that way here.

"Worse than absent" is measured against `clean.s16` in dB. NoLACE-family
post-filters are trained on perceptual and adversarial losses, and such filters
routinely *lower* SNR while raising perceived quality. So a negative dB is not
by itself evidence that anything is broken, and the whole of this file's
measurement programme inherits that caveat.

**What carries the conclusion instead is the gain, which no choice of oracle
touches.** The median sub-frame's peak shaping gain is **331**, 41.3% of
sub-frames peak above 1000x, and the client converts to int16: measured over
recorded speech, **5.62% of all output samples exceed full scale and 50.5% of
frames contain at least one.**

A post-filter that clips one sample in eighteen and touches half of every
second of audio is broken under any metric, perceptual or otherwise, and no
training objective produces it. That is the statement the conclusion should be
hung on, and it is why the dB oracle was useful for *localising* the fault --
to one group, then to one half of one group -- rather than for proving it
exists.

### The client's own codec runs here now

It is not necessary to read the client to answer any of this. The client's
`libopus_mlow.so` loads on an ordinary glibc machine and decodes real MLow,
and the recipe is short enough to repeat.

**Why it refuses at first, and it is not what it looks like.** The library is
`ELF x86-64, for Android 21, NDK r25c` and its `DT_NEEDED` names bionic --
`libc.so`, `libm.so`, `libar-bundle3.so`. A plain `dlopen` fails with
``version `LIBC' not found``, which reads like a missing library and is not:
bionic tags its symbols with the version `LIBC` where glibc uses `GLIBC_2.x`.
The **names all match**; only the labels differ.

**The recipe.**

1. On a *copy*, neutralise the version tags: set `DT_VERSYM` (`0x6ffffff0`),
   `DT_VERNEED` (`0x6ffffffe`) and `DT_VERNEEDNUM` (`0x6fffffff`) in
   `.dynamic` to `DT_DEBUG`, and mark `.gnu.version` and `.gnu.version_r` as
   `SHT_NOBITS`. The linker then binds by name.
2. The dependency closure is four libraries -- `libar-bundle3`,
   `libc++_shared`, `libfbjni`, `libglog` -- all present in an extracted
   Android bundle, all needing the same treatment. `libz.so` maps to glibc's.
3. Of the **256** symbols that closure imports, glibc, libstdc++, libgcc and
   libz already provide **233**. The remaining **23** are bionic-only and
   trivial: the `__android_log_*` family, `android_set_abort_message`, the
   `_chk` fortify variants, `__errno`, `__sF`, `_ctype_`, and some weak
   ZSTD/folly hooks. A hundred-line shim covers them -- the `_chk` calls
   forward to their unchecked forms, `__errno` returns `__errno_location()`,
   `__sF` is three FILE structures copied from glibc's in a constructor.
4. `dlopen` the shim `RTLD_NOW | RTLD_GLOBAL` first, then the library
   `RTLD_LAZY`. The lazy binding matters: Android symbols that are never
   called must not block the load. And do not put the shim directory on the
   link line of the host program, or the linker takes the fake `libc.so` for
   the real one.

Sources in this session's scratchpad: `wsl/bionic_shim.c`, `wsl/decode.c`,
`wsl/run4.sh`, `var/unversion.py`, `var/closure.py`, `var/missing.py`.

### The pinned codec is not the client's codec

The first thing that harness answered was not about the Companion. Feeding
**the same packet bytes** to both -- `opus_mlow v1.0.1` as vendored here, and
the client's `libopus_mlow.so` -- gives different audio:

| | delay | correlation to clean | dB from clean |
| --- | --- | --- | --- |
| pinned codec | 0 | 0.831 | **+4.37** |
| client's codec | 46 | 0.704 | **+1.94** |

Against each other: **48 samples of delay**, correlation 0.957 once aligned,
SNR 10.6 dB, and 5 frames of 545 bit-identical.

**It is not a filter difference.** The mean magnitude spectrum matches in every
quarter of the band -- 1.004, 1.000, 1.000, 0.999 -- and the best 65-tap FIR
between the two only lifts the SNR from 10.7 to 15.2 dB. **Nor is it state
escaping:** per fifth of the file the SNR reads 9.9, 14.1, 13.2, 14.1, 13.9 --
flat, not growing.

So the two are the same codec decoding the same stream and producing different
samples with identical statistics. `AGENTS.md` treats the pin as the client's
codec; on this evidence it is a close relative and not the same build.

**The Companion is not running inside the client**, which is expected since
the weights are external and nothing registered them, and is what the next step
has to change. The evidence for it is weaker than first written here, and the
first version cross-compared two things that may not be cross-compared: the
client's +1.94 and this build's -12.34 come from **different encodes against
different references**, so the gap between those two numbers is not a
measurement. What the table above does license is the pin-versus-client
comparison, which shares its packets and its reference and is aligned on both
sides.

### And the divergence is entirely in MLow: plain Opus is bit-identical

The same test run twice, once with `OPUS_SET_USING_SMPL(1)` on both ends and
once without, encoding the same speech with the pinned codec and decoding each
packet set in both implementations:

| path | delay | correlation | SNR | samples identical |
| --- | --- | --- | --- | --- |
| **plain Opus** | 0 | **1.000000** | 99 dB | **100.00%** |
| MLow / SMPL | -48 | 0.957 | 10.6 dB | 1.65% |

**Plain Opus comes out byte for byte identical.** Every one of 174720 samples,
zero delay. So the two are the same Opus build: the same arithmetic, the same
tables, the same lineage, with nothing in the core differing.

**Only MLow differs**, and by a fixed 48-sample offset plus a residue no
alignment removes. That narrows the earlier finding sharply: it is not that the
pin is a different codec, it is that the pin's **MLow** is a different version
of MLow while its Opus is exactly the client's.

That matters beyond the Companion. This library wraps `opus_mlow v1.0.1`, and
on this evidence its plain Opus is what WhatsApp runs while its MLow is not.

### The instrumented codec destroys the dump it is run beside

Worth its own warning, because it silently rewrote this session's reference and
nearly took a day of numbers with it. `libopus.a` built with
`SMPL_DUMP_FEATURES=1` calls `smpl_open_dec_files` from `opus_decoder_init`,
which **truncates and reopens every dump file in the current directory** --
`clean.s16`, `coded.s16` and all the feature files. Any tool linking that
library and run inside the dump directory replaces the dump with its own,
with no message.

It happened here: a packet generator run in `dumpreal/` overwrote the reference
mid-session, and the baseline silently moved from +2.90 to +4.73. The tell was
a number that should not have changed changing.

Regenerating with the dump tool restores it **bit for bit** -- the run is
deterministic -- and every figure in this file reproduces exactly: +2.90
unfiltered, -12.34 filtered, -7.48 with `[0:64]` zeroed, -7.17 with `[32:64]`.
Nothing here needed correcting. But run such tools somewhere else.

### The registry builds; the loader's signature does not yield to guessing

Half of running the Companion inside the client is done. The `.pte` parses into
the registry the client expects -- 48 records of 24 bytes,
`{name_ptr, _, size@0xc, data_ptr@0x10}`, `NULL`-terminated -- with every name
and size correct, and the weight pointers aimed into the mapped container.

The other half did not yield. The Ghidra addresses are **virtual**, and this
library's `PT_LOAD` puts `.text` at vaddr `0x26260`-`0xcabb0` against file
offset `0x22260`, so `0xc9b20` is file `0xc5b20` -- which holds
`55 48 89 e5 41 57 41 56`, an ordinary prologue, as do `0xca1b0`, `0xc97a0`,
`0xc98c0` and `0xc833a`. At runtime `dladdr`'s `dli_fbase + vaddr` is the
entry. **The addresses are right.**

Six calls were tried and all six fault: `(dest, ctx)`, `(ctx, dest)`,
`(NULL, ctx)`, `(ctx, NULL)`, and the last two again after
`opus_global_create()` and a live decoder with `OPUS_SET_USING_SMPL(1)`, in
case the registry hangs off decoder state. It does not take two pointers.

Recorded so it is not re-run. The signature is a reading, and this file's own
rule is that guessing loses to reading.

### Call the binary instead of reading it

Every question left here has been attacked by *reading* the client. The thing
that settles all of them at once is *calling* it: the same input through the
client's own code and through this build, diffed number by number. That is the
reference (input, output) pair this work has said from the start it never had,
and nothing about it needs a newer model.

Three levels, in the order to run them. The vectors are generated by
`refvec.c` in this session's scratchpad and written to
`findings/mlow/REFVEC-companion.txt` alongside the model.

1. **16 LPC coefficients to 64 floats.** The suspected chain, isolated, with
   no audio at all. If the magnitude and the filterbank can be called
   separately, better still -- then a discrepancy is localised to one of them.
2. **320 samples plus the decoder's state to the 93 features.** Adds the
   cepstrum, the autocorrelation and the decoder slots.
3. **The same input to 320 filtered samples**, with the network's state
   cleared first. Only meaningful once 1 and 2 agree.

**What each outcome means, decided in advance.** Level 1 diverging means the
feature is wrong and the 4-8 kHz localisation says where -- settled without a
newer model. Level 1 agreeing while level 3 diverges means the feature is right
and the network is not, which makes the version *proved* rather than deduced.
Everything agreeing means the client produces what this build produces, and
then the premise is what is wrong, not the port: what would need re-examining
is the assumption that this filter improves the signal, and the clipping is the
figure to check first -- **5.62% of samples past full scale, 50.5% of frames
touched.** If the client clips the same way, it is by design.

**What the `.wasm` cannot do.** `refs/web/voip.wasm` is 10.9 MB and exports
**43** symbols, all emscripten and folly plumbing -- `malloc`, `stackAlloc`,
`_emscripten_*` -- and not one matching `companion`, `mlow`, `smpl`, `spec` or
`lpc`. The functions are in it but unexported, so it would need its export
section rewritten before anything could be called. The `.so` is the shorter
road.

**What is left, in order.**

1. **Bisect against the client, stage by stage.** The reference runs on
   demand. This build's Companion contributes rms 8964.8 where the client's
   contributes 278.4, so the first question is where that factor of thirty-two
   enters: compare after `af1`, after `tdshape1`, after `af4`, on the same
   frame.
2. **Something nobody has counted as a piece.** Still the honest second entry.
   Every defect found was absent from any list until the question that exposed
   it was asked.
3. **Slot 90's source**, which the client only fills during a decode.

**How to measure anything here.**

- Against `clean.s16`, in dB, on recorded speech. No level ratio implies
  quality; this one does, and it needs no client.
- **The bar for any change to the shaping is +0.22 dB**, what switching it off
  gives. For the clean spectrum the bar is **-7.48**, what removing it gives.
- **The trap is wider than "destroys information".** A change that preserves
  information can still improve a metric only by weakening a stage that is
  wrong -- a sign flip in the log domain did exactly that, for 9.2 dB, and was
  retracted when the client's dataflow settled the question.
- Match the statistic to the non-linearity downstream of it, and measure at the
  median frame, and sweep the input through the codec rather than past it.

## Standing rule

A value measured in the client beats a reference default, always. Where the two
have been compared, the client differed more often than not. When adding a
claim here, grade it; when acting on an Inferred one, say so where it is used.
