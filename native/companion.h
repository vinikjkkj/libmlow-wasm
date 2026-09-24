/* MLow Companion: the neural post-filter the client runs inside its decoder.
 *
 * Architecture is NoLACE (Opus 1.5): a feature network drives adaptive
 * convolutions and time-domain shaping. Unlike the reference, which filters
 * decoded speech, the client applies them to the decoder's *excitation*, just
 * before LPC synthesis, and lets the synthesis filter turn the result into
 * speech. It does not synthesise audio, so a decoder without it produces the
 * same speech, just rougher at low bitrate.
 *
 * Weights live outside the binary, in a DNNw container fetched at runtime.
 */
#ifndef MLOW_COMPANION_H
#define MLOW_COMPANION_H

#include <stddef.h>
#include <stdint.h>

/* One 20 ms frame at 16 kHz, which is also the feature FFT size. */
#define COMPANION_FRAME 320
#define COMPANION_SPECTRUM_BINS (COMPANION_FRAME / 2 + 1)

/* One feature vector per sub-frame, not per frame: 93 extracted, 64 looked up
   in the pitch table, and 8 from the two bit-count embeddings, concatenated in
   that order. */
#define COMPANION_FEATURES 165
#define COMPANION_EXTRACTOR_FEATURES 93
#define COMPANION_PITCH_EMBED_DIM 64
#define COMPANION_NUMBITS_FEATURES 8

/* Feature network widths. */
#define COMPANION_CONV1_OUT 96
#define COMPANION_HIDDEN 160
/* conv2 spans two frames, taking all four sub-frames of each. */
#define COMPANION_CONV2_KERNEL 2
#define COMPANION_TCONV_UPSAMPLE 4

/* Rows of the pitch table. The lag indexes it directly, with nothing
   subtracted, so the row count is also the largest lag it can represent. */
#define COMPANION_PITCH_LAGS 351

/* Sub-frames per frame, each with its own feature vector. */
#define COMPANION_SUBFRAMES 4
#define COMPANION_SUBFRAME_SAMPLES (COMPANION_FRAME / COMPANION_SUBFRAMES)

typedef struct MlowCompanion MlowCompanion;

/* Errors mirror the codec's convention: 0 on success, negative on failure. */
#define COMPANION_OK 0
#define COMPANION_BAD_ARG -1
#define COMPANION_ALLOC_FAILED -2
#define COMPANION_BAD_MODEL -3
#define COMPANION_MISSING_TENSOR -4
#define COMPANION_NOT_READY -5

/* Long-term predictor coefficients the codec decodes per sub-frame. */
#define COMPANION_LTP_COEFFS 5

/* Short-term predictor order. One set of coefficients covers two sub-frames. */
#define COMPANION_LPC_ORDER 16

/* What the extractor reads out of the codec rather than recomputing, for one
   frame. These are decoder state, not measurements of the audio: the whole
   point is that the post-filter sees what the codec decided, which no amount
   of analysing its output would recover.

   Filled by the caller from the decoder; see companion_process. */
typedef struct {
  /* Predictor coefficients in the sign the codec reports them, so they drop
     straight into the polynomial. One set per sub-frame: the spectrum drawn
     from them is computed for each, unlike the cepstrum, which is computed at
     half rate and repeated. */
  float lpc[COMPANION_SUBFRAMES][COMPANION_LPC_ORDER];
  int lpc_order;

  /* Two pitch lags per sub-frame. They are averaged and rounded to index the
     pitch table; a zero means the sub-frame is unvoiced. */
  float lag[COMPANION_SUBFRAMES][2];

  /* Long-term predictor gains as decoded. Zero throughout when unvoiced. */
  float ltp[COMPANION_SUBFRAMES][COMPANION_LTP_COEFFS];

  /* Three values the decoder produces, one of each per sub-frame, each logged
     base ten here and put through its own affine step. Write them
     untransformed: the logarithm and the affine steps happen in
     `build_subframe_features`.

       [sub][0]  the codebook gain, a linear amplitude
       [sub][1]  the energy the sub-frame realised, `sum(exc[n]^2)` over its
                 80 samples, with the length already in it
       [sub][2]  the energy it was aiming at, with the length already in it

     Read from the client's decoder, at three distinct fields of its per-frame
     struct (offsets 0x30, 0x20 and 0x174). Being three *different* fields is
     what settled a long argument: they had been read as three energies and as
     three of the eight pitch lags, and both readings compared how widely their
     candidate spreads under a `x * 0.5 + 32` in front of the logarithm, which
     the disassembly says is not there. They are not three of anything.

     The first of them reaches the largest weight norm in the model, 5.135
     where no other layer exceeds 2.34, so leaving it unfilled is not a small
     thing: with all three at zero `af4`'s gain sits against the floor of its
     span in a third of sub-frames, and filling the other two takes that to a
     quarter. See COMPANION-EVIDENCE.md. */
  float decode_context[COMPANION_SUBFRAMES][3];

  /* Linear gain per sub-frame; the feature is its logarithm.

     Note for whoever fills this from the codec: what the codec reports is a
     sum of table entries spanning roughly 0 to 78, which reads as decibels, so
     it needs converting first. That reading is inferred from the range and has
     not been confirmed against the client - and it lands directly on a
     feature. See COMPANION-EVIDENCE.md. */
  float gain[COMPANION_SUBFRAMES];

  /* Payload size in bits. The reference also embeds a smoothed bit count
     alongside the raw one; this build embeds only the raw value, so there is
     nothing to carry across frames. */
  float num_bits;

  /* The TOC's low-rate flag, 0 or 1, copied into the last feature slot with no
     transform at all. Read out of the client's vector over a real decode of
     the same speech at two rates: 1.0 on all 120 sub-frames at 8 kbps, where
     the flag is set, and 0.0 on all 120 at 15 kbps, where it is not. */
  float low_rate;

  /* The decoder's excitation for this frame, exactly what its LPC synthesis
     filter is about to read: `fcb + adaptive + noise`, and at the low rate
     after the tilt and pulse shaping the decoder applies there. The cepstrum
     and the pitch autocorrelation are computed from this, **not** from the
     decoded speech, and it is the same signal companion_process filters.

     Measured against the client's own feature vector, read out of its memory
     on voiced frames with a warm decoder: computed from the decoded speech the
     cepstrum correlates 0.599 with the client's and its `c0` averages -5.17
     where the client's averages -10.06; computed from this excitation it
     correlates 1.000 and averages -10.063. The autocorrelation matches to 1e-7
     wherever the pitch lag it is given is the client's.

     It is not the encoder's LPC residual of the clean input, which a decoder
     never has: that one correlates 0.994, close only because a CELP decoder's
     excitation is built to approximate it. See COMPANION-EVIDENCE.md. */
  float excitation[COMPANION_FRAME];
} CompanionFrameState;

/* Parses a DNNw buffer and builds a ready-to-run instance. The buffer is only
   read during this call; the caller may release it afterwards. */
MlowCompanion *companion_create(const uint8_t *model, size_t model_bytes, int *error);

void companion_destroy(MlowCompanion *self);

/* Clears the streaming state, GRU hidden vector, convolution history and
   filter memories, without touching the weights. */
void companion_reset(MlowCompanion *self);

/* Filters one frame of the decoder's excitation in place, before LPC
   synthesis. `pcm` holds COMPANION_FRAME samples: the same samples as
   `state->excitation`, which the features read before any filtering; `state`
   carries the per-frame values read from the codec.

   The excitation, not the speech: the client's first adaptive filter reads
   the decoder's excitation sample for sample, correlation 1.00000 at scale
   1.0000 over sixty frames of a real decode, where the synthesised speech
   correlates 0.13 with it. Filtering the speech instead reproduces the
   client's level and shape and gets the samples wrong: its contribution
   correlated 0.69 with the client's, against 0.9998 once moved.

   Samples are on the codec's float scale, where speech runs +/-1, not the
   int16 scale. The scale is not a convention we are free to pick: the shaping
   stage takes the logarithm of the signal envelope, so changing it does not
   scale that stage's output, it shifts it. */
int companion_process(MlowCompanion *self, float *pcm, const CompanionFrameState *state);

/* The feature vectors built for the most recent frame: COMPANION_SUBFRAMES of
   them, COMPANION_FEATURES wide, laid out consecutively.

   Exposed so a reference (features, output) pair can be checked against the
   client's, which is the only way to tell a faithful port from a plausible
   one. Until such a pair exists, the property checks in companion_test.c are
   what stands between this and a plausible-looking mistake.

   Valid until the next companion_process. */
const float *companion_last_features(const MlowCompanion *self);

#endif /* MLOW_COMPANION_H */
