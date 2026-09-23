/* Feature extraction for the MLow Companion.
 *
 * The Companion consumes one 93-wide vector per sub-frame, not one per frame,
 * laid out in fixed slices. Getting that wrong is invisible downstream: the
 * network still runs and still produces audio, just conditioned on nonsense.
 *
 *   [ 0:64]  clean spectrum    envelope of the codec's LPC, inverted
 *   [64:82]  noisy cepstrum    of the decoded signal
 *   [82:87]  autocorrelation   around the pitch lag, at offsets -2..+2
 *   [87:92]  LTP coefficients  as the codec decoded them
 *   [92]     log gain          of the sub-frame
 *
 * See companion_features.c.
 */
#ifndef MLOW_COMPANION_FEATURES_H
#define MLOW_COMPANION_FEATURES_H

#define COMPANION_CLEAN_SPEC_START 0
#define COMPANION_CLEAN_SPEC_LENGTH 64
#define COMPANION_NOISY_CEPSTRUM_START 64
#define COMPANION_NOISY_CEPSTRUM_LENGTH 18
#define COMPANION_ACORR_START 82
#define COMPANION_ACORR_LENGTH 5
#define COMPANION_LTP_START 87
#define COMPANION_LTP_LENGTH 5
#define COMPANION_LOG_GAIN_START 92

/* Sub-frame the features describe, and the correlation window. */
#define COMPANION_SUBFRAME 80

/* Samples of decoded audio kept before the current frame. The cepstrum reaches
   160 back and the autocorrelation reaches one pitch period plus two, so this
   covers the largest lag the pitch embedding can index. */
#define COMPANION_HISTORY 352

/* Builds the analysis window, sin(pi * (n + 0.5) / size). */
void companion_build_window(float *window, int size);

/* Magnitude spectrum of `size` real samples, unnormalised, written as
   size/2 + 1 bins. Only the first `used` samples are read; the rest are taken
   as zero. */
void companion_mag_spectrum(
  float *out,
  const float *input,
  int size,
  int used,
  const float *cos_table,
  const float *sin_table
);

/* Triangular overlapping filterbank: each bin feeds the two adjacent bands. */
void companion_filterbank(
  float *out,
  const float *spectrum,
  const int *centres,
  const float *weights,
  int bands
);

/* Clean spectrum from the codec's LPC. `lpc` holds `order` coefficients in the
   sign the codec reports them, so they drop straight into the predictor
   polynomial. The envelope is inverted before the filterbank, because what
   conditions the network is the spectrum the LPC *describes*, not the
   whitening filter itself. Writes COMPANION_CLEAN_SPEC_LENGTH values. */
void companion_clean_spectrum(
  float *out,
  const float *lpc,
  int order,
  const float *cos_table,
  const float *sin_table,
  float *scratch
);

/* Cepstrum of the decoded signal. `signal` points at the sub-frame; the window
   is centred by reading 160 samples before it. Writes
   COMPANION_NOISY_CEPSTRUM_LENGTH values. */
void companion_cepstrum(
  float *out,
  const float *signal,
  const float *window,
  const float *cos_table,
  const float *sin_table,
  float *scratch
);

/* Normalised correlation of the sub-frame against itself at `lag` shifted by
   -2..+2. `signal` points at the sub-frame and must have COMPANION_HISTORY
   valid samples behind it. Writes COMPANION_ACORR_LENGTH values. */
void companion_acorr(float *out, const float *signal, int lag);

/* DCT-II, orthonormal. */
void companion_dct(float *out, const float *input, int count);

/* Sinusoidal embedding of a bit count: sin(scale[i] * x - 0.5), where x is the
   log bit count clipped to [low, high] and centred on the midpoint. The scales
   are measured from the client rather than derived, because there they are a
   trained parameter and not the closed form they were initialised from.
   Writes `dim` values. */
void companion_numbits_embedding(
  float *out,
  float numbits,
  const float *scales,
  int dim,
  float low,
  float high
);

/* Pitch lag for the embedding. The codec records two lags per sub-frame; the
   client averages them, rounds, and indexes the table directly, with no offset
   subtracted. A zero lag means unvoiced and falls back to a fixed value. */
int companion_pitch_index(float lag_a, float lag_b, int table_rows);

#endif /* MLOW_COMPANION_FEATURES_H */
