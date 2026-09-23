/* Feature extraction for the MLow Companion.
 *
 * The vector is built per sub-frame, in the fixed slices companion_features.h
 * lists. Two of its parts look alike and are not: the clean spectrum describes
 * the envelope the codec's LPC *predicts*, while the cepstrum describes the
 * signal that actually came out. Feeding the same source to both leaves the
 * network with no way to see what the codec got wrong, which is the entire
 * point of the post-filter.
 */
#include "companion_features.h"
#include "companion.h"
#include "companion_tables.h"

#include <math.h>
#include <string.h>

/* Floor inside every log, and inside the correlation's normalising root. */
#define COMPANION_LOG_FLOOR 1e-9f

void companion_build_window(float *window, int size) {
  for (int n = 0; n < size; n++) {
    window[n] = (float)sin(M_PI * ((double)n + 0.5) / (double)size);
  }
}

void companion_mag_spectrum(
  float *out,
  const float *input,
  int size,
  int used,
  const float *cos_table,
  const float *sin_table
) {
  /* A direct transform, unnormalised. The reference scales its result by the
     transform size, but only because its FFT divides by it first; the two
     agree, and multiplying here as well would be a factor of `size` too much.

     Samples from `used` on are zero and skipped: a zero adds nothing to either
     sum, so the result is bit for bit the one over all `size`. The predictor
     polynomial is 17 samples padded to 320, and transforming the padding was
     most of this function's cost. */
  const int bins = size / 2 + 1;
  for (int k = 0; k < bins; k++) {
    float re = 0.0f;
    float im = 0.0f;
    /* cos(2*pi*k*n/size) has period `size` in k*n, so one table serves every
       bin, indexed by k*n mod size -- kept incrementally, since k < size. */
    int angle = 0;
    for (int n = 0; n < used; n++) {
      re += input[n] * cos_table[angle];
      im -= input[n] * sin_table[angle];
      angle += k;
      if (angle >= size) {
        angle -= size;
      }
    }
    out[k] = (float)sqrt((double)re * re + (double)im * im);
  }
}

void companion_filterbank(
  float *out,
  const float *spectrum,
  const int *centres,
  const float *weights,
  int bands
) {
  /* Each bin is split between the two bands it falls between, in proportion to
     where it sits, so the triangles overlap and their weights sum to one. */
  memset(out, 0, (size_t)bands * sizeof(float));
  for (int b = 0; b < bands - 1; b++) {
    const int lo = centres[b];
    const int hi = centres[b + 1];
    const float span = (float)(hi - lo);
    for (int i = lo; i < hi; i++) {
      const float frac = (float)(hi - i) / span;
      out[b] += weights[b] * frac * spectrum[i];
      out[b + 1] += weights[b + 1] * (1.0f - frac) * spectrum[i];
    }
  }
  out[bands - 1] += weights[bands - 1] * spectrum[centres[bands - 1]];
}

void companion_clean_spectrum(
  float *out,
  const float *lpc,
  int order,
  const float *cos_table,
  const float *sin_table,
  float *scratch
) {
  float *poly = scratch;
  float *magnitude = scratch + COMPANION_FRAME;

  /* The predictor polynomial, zero-padded to the transform length.

     `A(z) = 1 - sum a_i z^-i`, and the minus is the whole feature. The codec
     dumps *predictor* coefficients -- what the synthesis filter adds back --
     so the whitening polynomial subtracts them. Written with a plus, `A(DC)`
     comes out near `1 + 1 = 2` instead of near `1 - 1 = 0`, and 64 of the 93
     features go flat: measured against the client's own vector, band 0 of a
     voiced frame reads -0.41 with the plus where the client reads +2.64, and
     +2.67 with the minus. Over the sixteen lowest bands the correlation with
     the client is 0.115 with the plus.

     This was recorded as ruled out -- "negating it is worse in the cell that
     matters" -- on the decibel oracle, which cannot see it: a wrong envelope
     that makes the filter inert scores like silence, and silence scores well
     on that measure. See COMPANION-EVIDENCE.md. */
  memset(poly, 0, COMPANION_FRAME * sizeof(float));
  poly[0] = 1.0f;
  for (int i = 0; i < order; i++) {
    poly[i + 1] = -lpc[i];
  }

  companion_mag_spectrum(magnitude, poly, COMPANION_FRAME, order + 1, cos_table, sin_table);

  /* Invert: the polynomial is the whitening filter, and what conditions the
     network is the envelope it whitens.

     ASSUMED, and weaker than it used to read. The magnitude is *squared*
     before inverting, from a reading of the client — so the log below carries twice what an
     unsquared envelope would give, and this feature is effectively
     `-0.6 * log|A|`.

     The client writes it as `1 / ((|A| * 320)^2 + eps)`, and that 320 does not
     belong here: its transform divides by the size and multiplies it back,
     while `companion_mag_spectrum` is unnormalised to begin with. Applying it
     as well would be a factor of the transform size too much — the same trap
     the comment there warns about. Confirmed numerically: squaring alone takes
     this feature's rms from 0.19 to 0.383, against 0.38 predicted from the
     client.

     But the 320 and the square come from the *same* reading, and the 320 is
     now confirmed wrong by 8.9 dB against recorded speech, while the reference
     does not square at all. Dropping the square gains 1.6 dB and leaves the
     group still costing 3.3, so no metric settles it either way. Kept, because
     a measurement does not overturn a reading -- but half a reading is not
     evidence for its other half. See COMPANION-EVIDENCE.md. */
  for (int i = 0; i < COMPANION_SPECTRUM_BINS; i++) {
    magnitude[i] = 1.0f / (magnitude[i] * magnitude[i] + COMPANION_LOG_FLOOR);
  }

  companion_filterbank(
    out, magnitude, companion_clean_centres, companion_clean_weights, COMPANION_CLEAN_BANDS
  );

  for (int i = 0; i < COMPANION_CLEAN_BANDS; i++) {
    out[i] = 0.3f * (float)log((double)out[i] + COMPANION_LOG_FLOOR);
  }
}

void companion_cepstrum(
  float *out,
  const float *signal,
  const float *window,
  const float *cos_table,
  const float *sin_table,
  float *scratch
) {
  float *windowed = scratch;
  float *magnitude = scratch + COMPANION_FRAME;
  float *bands = magnitude + COMPANION_SPECTRUM_BINS;

  /* The window is centred on the sub-frame, so it opens 160 samples before it
     and the caller must have that much history available. */
  for (int n = 0; n < COMPANION_FRAME; n++) {
    windowed[n] = window[n] * signal[n - COMPANION_FRAME / 2];
  }

  companion_mag_spectrum(magnitude, windowed, COMPANION_FRAME, COMPANION_FRAME, cos_table, sin_table);
  companion_filterbank(
    bands, magnitude, companion_noisy_centres, companion_noisy_weights, COMPANION_NOISY_BANDS
  );

  for (int b = 0; b < COMPANION_NOISY_BANDS; b++) {
    bands[b] = (float)log((double)bands[b] + COMPANION_LOG_FLOOR);
  }

  companion_dct(out, bands, COMPANION_NOISY_BANDS);
}

void companion_dct(float *out, const float *input, int count) {
  /* DCT-II, orthonormal: the leading coefficient carries an extra 1/sqrt(2) so
     the transform preserves energy. */
  const double norm = sqrt(2.0 / (double)count);
  for (int i = 0; i < count; i++) {
    double sum = 0.0;
    for (int j = 0; j < count; j++) {
      sum += (double)input[j] * cos(((double)j + 0.5) * (double)i * M_PI / (double)count);
    }
    sum *= norm;
    if (i == 0) {
      sum *= sqrt(0.5);
    }
    out[i] = (float)sum;
  }
}

void companion_acorr(float *out, const float *signal, int lag) {
  /* Correlation of the sub-frame against itself one pitch period back, probed
     at five offsets so the network sees how sharp the periodicity is, not just
     how strong. */
  for (int k = -2; k <= 2; k++) {
    float xx = 0.0f;
    float yy = 0.0f;
    float xy = 0.0f;
    const int shift = k - lag;
    for (int n = 0; n < COMPANION_SUBFRAME; n++) {
      const float x = signal[n];
      const float y = signal[n + shift];
      xx += x * x;
      yy += y * y;
      xy += x * y;
    }
    out[k + 2] = xy / (float)sqrt((double)xx * yy + COMPANION_LOG_FLOOR);
  }
}

void companion_numbits_embedding(
  float *out,
  float numbits,
  const float *scales,
  int dim,
  float low,
  float high
) {
  const float log_low = (float)log((double)low);
  const float log_high = (float)log((double)high);
  float x = (float)log((double)numbits);
  if (x < log_low) {
    x = log_low;
  } else if (x > log_high) {
    x = log_high;
  }
  x -= 0.5f * (log_low + log_high);
  for (int i = 0; i < dim; i++) {
    out[i] = (float)sin((double)scales[i] * x - 0.5);
  }
}

int companion_pitch_index(float lag_a, float lag_b, int table_rows) {
  /* The index is the rounded mean of the sub-frame's two lags, with no offset.
     Read from the client: it averages the two recorded lags and indexes the
     table directly.

     This code previously halved one lag and added 32. That was chosen because
     it measured better, while this file's own provenance table already recorded
     the client as averaging — a number preferred over a reading, which is the
     mistake this work exists to avoid. Swapping it back moves crest from 109.1
     to 96.6 and the GRU's saturation from 6.3% to 5.6%. */
  if (lag_a <= 0.0f) {
    /* Unvoiced is checked first so a zero lag reaches the stand-in row rather
       than a valid one. */
    return COMPANION_NO_PITCH_VALUE;
  }
  /* Half rounds up. `lrintf` rounds half to even, which disagreed with the
     client on every sub-frame whose two lags average to a half: over a real
     decode, 15 of 120 sub-frames came out one row low. `floor(x + 0.5)` matches
     the client's index on all 88 voiced sub-frames. */
  int index = (int)floorf((lag_a + lag_b) * 0.5f + 0.5f);
  if (index < 0) {
    index = 0;
  }
  if (index >= table_rows) {
    index = table_rows - 1;
  }
  return index;
}
