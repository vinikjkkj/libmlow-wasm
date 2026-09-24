/* Property checks for the Companion's feature extraction.
 *
 * None of these need the client's weights or a reference recording: each one
 * pins a property the maths must have whatever the model turns out to be, so
 * they catch transcription errors without pretending to prove fidelity.
 */
#include "companion.h"
#include "companion_features.h"
#include "companion_tables.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int failures = 0;

static void check(int condition, const char *name, const char *detail) {
  if (condition) {
    printf("  ok   %s\n", name);
  } else {
    printf("  FAIL %s: %s\n", name, detail);
    failures++;
  }
}

static float cos_table[COMPANION_FRAME];
static float sin_table[COMPANION_FRAME];
static float scratch[COMPANION_FRAME + COMPANION_SPECTRUM_BINS + COMPANION_CLEAN_BANDS];

int main(void) {
  for (int i = 0; i < COMPANION_FRAME; i++) {
    const double angle = 2.0 * M_PI * (double)i / (double)COMPANION_FRAME;
    cos_table[i] = (float)cos(angle);
    sin_table[i] = (float)sin(angle);
  }

  printf("DCT\n");
  {
    /* Orthonormal: the transform preserves energy. */
    float in[COMPANION_NOISY_CEPSTRUM_LENGTH];
    float out[COMPANION_NOISY_CEPSTRUM_LENGTH];
    double ein = 0.0, eout = 0.0;
    for (int i = 0; i < COMPANION_NOISY_CEPSTRUM_LENGTH; i++) {
      in[i] = (float)sin(0.7 * i) + 0.3f * (float)i;
      ein += (double)in[i] * in[i];
    }
    companion_dct(out, in, COMPANION_NOISY_CEPSTRUM_LENGTH);
    for (int i = 0; i < COMPANION_NOISY_CEPSTRUM_LENGTH; i++) {
      eout += (double)out[i] * out[i];
    }
    char detail[128];
    snprintf(detail, sizeof detail, "energy in %.6f, out %.6f", ein, eout);
    check(fabs(ein - eout) / ein < 1e-5, "preserves energy (Parseval)", detail);

    /* A constant input has all its energy in the DC coefficient. */
    float flat[COMPANION_NOISY_CEPSTRUM_LENGTH];
    for (int i = 0; i < COMPANION_NOISY_CEPSTRUM_LENGTH; i++) flat[i] = 2.0f;
    companion_dct(out, flat, COMPANION_NOISY_CEPSTRUM_LENGTH);
    double rest = 0.0;
    for (int i = 1; i < COMPANION_NOISY_CEPSTRUM_LENGTH; i++) rest += fabs(out[i]);
    snprintf(detail, sizeof detail, "c0 %.6f, sum|rest| %.9f", out[0], rest);
    check(rest < 1e-4 && fabsf(out[0]) > 1.0f, "constant input is pure DC", detail);
  }

  printf("autocorrelation\n");
  {
    /* A signal that repeats every `period` correlates to 1 at that lag. */
    const int period = 40;
    float buffer[COMPANION_HISTORY + COMPANION_FRAME];
    for (int i = 0; i < COMPANION_HISTORY + COMPANION_FRAME; i++) {
      buffer[i] = (float)sin(2.0 * M_PI * (double)i / (double)period);
    }
    float acorr[COMPANION_ACORR_LENGTH];
    companion_acorr(acorr, buffer + COMPANION_HISTORY, period);
    char detail[160];
    snprintf(detail, sizeof detail, "[%.4f %.4f %.4f %.4f %.4f]",
             acorr[0], acorr[1], acorr[2], acorr[3], acorr[4]);
    check(acorr[2] > 0.999f, "peaks at the true lag", detail);
    check(acorr[2] >= acorr[1] && acorr[2] >= acorr[3], "centre is the maximum", detail);

    int bounded = 1;
    for (int i = 0; i < COMPANION_ACORR_LENGTH; i++) {
      if (!(acorr[i] >= -1.001f && acorr[i] <= 1.001f)) bounded = 0;
    }
    check(bounded, "stays within [-1, 1]", detail);
  }

  printf("clean spectrum from LPC\n");
  {
    /* An all-zero predictor describes a flat spectrum, so every band that
       spans the same number of bins must come out equal. */
    float lpc[COMPANION_LPC_ORDER];
    float spec[COMPANION_CLEAN_BANDS];
    memset(lpc, 0, sizeof lpc);
    companion_clean_spectrum(spec, lpc, COMPANION_LPC_ORDER, cos_table, sin_table, scratch);

    /* Bands 2 and 6 both span centres 5..8 and 15..18: three bins each. */
    char detail[128];
    snprintf(detail, sizeof detail, "band2 %.6f, band6 %.6f", spec[2], spec[6]);
    check(fabsf(spec[2] - spec[6]) < 1e-4f, "flat LPC gives equal equal-width bands", detail);

    int finite = 1;
    for (int i = 0; i < COMPANION_CLEAN_BANDS; i++) {
      if (!isfinite(spec[i])) finite = 0;
    }
    check(finite, "all bands finite", "a band came out NaN or infinite");

    /* A real predictor must change the envelope, or the feature is inert. */
    float shaped[COMPANION_CLEAN_BANDS];
    lpc[0] = 0.9f;
    companion_clean_spectrum(shaped, lpc, COMPANION_LPC_ORDER, cos_table, sin_table, scratch);
    snprintf(detail, sizeof detail, "flat band0 %.4f, shaped band0 %.4f", spec[0], shaped[0]);
    check(fabsf(shaped[0] - spec[0]) > 0.01f, "a tilted predictor tilts the envelope", detail);
  }

  printf("bit-count embedding\n");
  {
    float emb[COMPANION_NUMBITS_EMBED_DIM];
    companion_numbits_embedding(emb, 200.0f, companion_numbits_scales,
      COMPANION_NUMBITS_EMBED_DIM, COMPANION_NUMBITS_LOW, COMPANION_NUMBITS_HIGH);
    int bounded = 1;
    for (int i = 0; i < COMPANION_NUMBITS_EMBED_DIM; i++) {
      if (!(emb[i] >= -1.0f && emb[i] <= 1.0f)) bounded = 0;
    }
    check(bounded, "every sine within [-1, 1]", "an embedding value left the sine range");

    /* Below the floor and above the ceiling must clip, not extrapolate. */
    float low[COMPANION_NUMBITS_EMBED_DIM], lower[COMPANION_NUMBITS_EMBED_DIM];
    companion_numbits_embedding(low, COMPANION_NUMBITS_LOW, companion_numbits_scales,
      COMPANION_NUMBITS_EMBED_DIM, COMPANION_NUMBITS_LOW, COMPANION_NUMBITS_HIGH);
    companion_numbits_embedding(lower, COMPANION_NUMBITS_LOW / 10.0f, companion_numbits_scales,
      COMPANION_NUMBITS_EMBED_DIM, COMPANION_NUMBITS_LOW, COMPANION_NUMBITS_HIGH);
    check(memcmp(low, lower, sizeof low) == 0, "clips below the floor", "extrapolated past the floor");

    float high[COMPANION_NUMBITS_EMBED_DIM], higher[COMPANION_NUMBITS_EMBED_DIM];
    companion_numbits_embedding(high, COMPANION_NUMBITS_HIGH, companion_numbits_scales,
      COMPANION_NUMBITS_EMBED_DIM, COMPANION_NUMBITS_LOW, COMPANION_NUMBITS_HIGH);
    companion_numbits_embedding(higher, COMPANION_NUMBITS_HIGH * 10.0f, companion_numbits_scales,
      COMPANION_NUMBITS_EMBED_DIM, COMPANION_NUMBITS_LOW, COMPANION_NUMBITS_HIGH);
    check(memcmp(high, higher, sizeof high) == 0, "clips above the ceiling", "extrapolated past the ceiling");

    /* The midpoint of the range is where the argument vanishes, so every sine
       collapses to the same value. */
    const float mid = (float)exp(0.5 * (log(COMPANION_NUMBITS_LOW) + log(COMPANION_NUMBITS_HIGH)));
    float centre[COMPANION_NUMBITS_EMBED_DIM];
    companion_numbits_embedding(centre, mid, companion_numbits_scales,
      COMPANION_NUMBITS_EMBED_DIM, COMPANION_NUMBITS_LOW, COMPANION_NUMBITS_HIGH);
    char detail[128];
    snprintf(detail, sizeof detail, "at %.2f bits: %.6f vs %.6f", mid, centre[0], (float)sin(-0.5));
    check(fabsf(centre[0] - (float)sin(-0.5)) < 1e-5f, "geometric midpoint is the phase origin", detail);
  }

  printf("pitch index\n");
  {
    /* These two encoded the previous reading - half of one lag plus 32 - which
       was chosen for measuring better while the provenance table already
       recorded the client as averaging. They test the convention, not a
       property, so they follow it. */
    check(companion_pitch_index(100.0f, 102.0f, COMPANION_PITCH_LAGS) == 101,
          "averages the two lags", "100 and 102 should index row 101");
    check(companion_pitch_index(131.0f, 132.0f, COMPANION_PITCH_LAGS) == 132,
          "rounds the mean to nearest", "131 and 132 should index row 132");
    check(companion_pitch_index(140.0f, 140.0f, COMPANION_PITCH_LAGS) == 140,
          "applies no offset", "equal lags should index the lag itself");
    check(companion_pitch_index(0.0f, 0.0f, COMPANION_PITCH_LAGS) == COMPANION_NO_PITCH_VALUE,
          "falls back when unvoiced", "a zero lag did not fall back");
    check(companion_pitch_index(1e6f, 1e6f, COMPANION_PITCH_LAGS) < COMPANION_PITCH_LAGS,
          "cannot index past the table", "an absurd lag ran off the pitch table");
  }

  printf("filterbank\n");
  {
    /* Every bin's weight is split between two neighbouring bands, so a band
       can never be handed more than the energy present. */
    float spectrum[COMPANION_SPECTRUM_BINS];
    float bands[COMPANION_CLEAN_BANDS];
    for (int i = 0; i < COMPANION_SPECTRUM_BINS; i++) spectrum[i] = 1.0f;
    companion_filterbank(bands, spectrum, companion_clean_centres,
                         companion_clean_weights, COMPANION_CLEAN_BANDS);
    int positive = 1;
    for (int i = 0; i < COMPANION_CLEAN_BANDS; i++) {
      if (!(bands[i] > 0.0f) || !isfinite(bands[i])) positive = 0;
    }
    check(positive, "every band gets energy from a flat spectrum",
          "a band came out zero, negative or non-finite");

    char detail[128];
    snprintf(detail, sizeof detail, "interior bands read %.6f", bands[10]);
    check(fabsf(bands[10] - 1.0f) < 1e-5f, "interior bands are unity-gain", detail);
  }

  /* The whole forward pass, when a model is available.
   *
   * This is a smoke test and its reach was measured rather than assumed.
   * Reintroducing two real regressions from this work, dropping the zero
   * point from the bias, and driving the shaping from the wrong transform,
   * produced ratios of 10.3 and 1.20, and **both pass**. So it does not
   * protect the wiring.
   *
   * What it does catch is the model failing to load, the pass producing NaN,
   * and the runaway that dominated this work, where the shaping exponential
   * reaches 1e12 and every sample leaves the finite range.
   *
   * The level bound stays loose deliberately. The state fed in is synthetic
   * and the correct ratio is not yet known, so tightening it would pin the
   * test to a number that is still moving and fail honestly-correct changes.
   *
   * The scale sweep beside it needs no such number, which is why it is worth
   * more. It runs the same speech twice, eight times apart in level, and
   * requires the two output-over-input ratios to agree. A post-filter has to
   * be close to scale-equivariant whatever its correct gain turns out to be,
   * so this holds a real property rather than a measured value. It is also
   * what found the defect it now guards: an absolute level was reaching the
   * shaping's exponent, and the output level moved with the exponential of
   * the input's, by 4.4e8 over a 64x sweep. Every level bound passed that.
   *
   * Set COMPANION_MODEL to a DNNw container to run it. */
  const char *model_path = getenv("COMPANION_MODEL");
  if (model_path == NULL) {
    printf("\nforward pass: skipped (set COMPANION_MODEL to a .pte to run)\n");
  } else {
    printf("\nforward pass over %s\n", model_path);
    FILE *f = fopen(model_path, "rb");
    if (f == NULL) {
      printf("  FAIL could not open the model\n");
      failures++;
    } else {
      fseek(f, 0, SEEK_END);
      long model_bytes = ftell(f);
      fseek(f, 0, SEEK_SET);
      unsigned char *model = (unsigned char *)malloc((size_t)model_bytes);
      if (model == NULL || fread(model, 1, (size_t)model_bytes, f) != (size_t)model_bytes) {
        printf("  FAIL could not read the model\n");
        failures++;
      } else {
        int error = 0;
        MlowCompanion *companion = companion_create(model, (size_t)model_bytes, &error);
        check(companion != NULL, "model loads", "companion_create rejected the container");
        if (companion != NULL) {
          /* Voiced speech normalised to +/-1, which is the scale the client
             runs on - it converts to int16 only in its final stage. This test
             used the int16 scale, on a claim in companion.h that has since been
             withdrawn: it was deduced from the symptom rather than measured.
             See COMPANION-EVIDENCE.md.

             The same speech runs twice, eight times apart in level. */
          static const float amplitude[2] = {0.183f, 1.464f};
          double ratio[2] = {0.0, 0.0};
          int nonfinite = 0;
          /* Per-frame ratios, taken at the median. The aggregate - the whole
             run's output rms over its input rms - is a tail statistic once the
             shaping gain spreads within a frame, and it misreads badly: on
             real speech it made a 64x input sweep look non-monotone, which is
             not a level dependence at all, where the median showed a clean
             power of 1.87. */
          double frame_ratio[40];
          int frame_count = 0;
          for (int pass = 0; pass < 2; pass++) {
          double energy_in = 0.0, energy_out = 0.0;
          frame_count = 0;
          if (pass > 0) {
            /* The filter memories and the recurrent state carry over, so the
               second level has to start from the same place as the first. */
            companion_destroy(companion);
            companion = companion_create(model, (size_t)model_bytes, &error);
            if (companion == NULL) {
              printf("  FAIL the container stopped loading between passes\n");
              failures++;
              break;
            }
          }
          for (int frame = 0; frame < 40; frame++) {
            float pcm[COMPANION_FRAME];

            CompanionFrameState state;
            memset(&state, 0, sizeof state);
            state.lpc_order = COMPANION_LPC_ORDER;
            /* One set per sub-frame, which is what the struct documents.
               Filling only the first half left sub-frames 2 and 3 with a zero
               polynomial, so the clean spectrum, 64 of the 93 features,
               came out flat for half of every frame and this test exercised a
               degenerate conditioning it was not meant to. */
            for (int sub = 0; sub < COMPANION_SUBFRAMES; sub++) {
              state.lpc[sub][0] = 1.4f;
              state.lpc[sub][1] = -0.6f;
            }
            for (int sub = 0; sub < COMPANION_SUBFRAMES; sub++) {
              state.lag[sub][0] = 123.0f;
              state.lag[sub][1] = 123.0f;
              /* The symmetric pattern the codec reports for a voiced frame. */
              state.ltp[sub][1] = 0.2f;
              state.ltp[sub][2] = 0.6f;
              state.ltp[sub][3] = 0.2f;
              state.gain[sub] = 60.0f;
            }
            state.num_bits = 190.0f;
            /* The Companion reads and filters the decoder's excitation, not
               the speech: the features take it from `state.excitation` and the
               filters run on `pcm`, which the decoder hands over as the same
               samples. Left at zero, every band would read `ln(1e-9)` and `c0`
               would sit near -88 where the client's sits near -10, which
               saturates the network and measures nothing.

               So drive it with the excitation that is consistent with this
               signal: the residual of the speech through its own predictor,
               which with `A(z) = 1 - 1.4 z^-1 + 0.6 z^-2` is what `1 / A(z)`
               would have to be driven by to produce it. The signal is
               analytic, so its past samples are evaluated rather than carried
               between frames. */
            for (int n = 0; n < COMPANION_FRAME; n++) {
              double x[3];
              for (int k = 0; k < 3; k++) {
                const double t = (double)(frame * COMPANION_FRAME + n - k) / 16000.0;
                x[k] = amplitude[pass]
                  * (sin(2 * M_PI * 130 * t) + 0.4 * sin(2 * M_PI * 390 * t));
              }
              state.excitation[n] =
                (float)(x[0] - state.lpc[0][0] * x[1] - state.lpc[0][1] * x[2]);
            }
            memcpy(pcm, state.excitation, sizeof pcm);

            /* Skip the first frames: the filter memories and the recurrent
               state start empty, so their output describes the reset. */
            const int settled = frame >= 5;
            double in_this_frame = 0.0;
            if (settled) {
              for (int n = 0; n < COMPANION_FRAME; n++) {
                energy_in += (double)pcm[n] * pcm[n];
                in_this_frame += (double)pcm[n] * pcm[n];
              }
            }

            if (companion_process(companion, pcm, &state) != COMPANION_OK) {
              printf("  FAIL companion_process rejected frame %d\n", frame);
              failures++;
              break;
            }

            if (settled) {
              double out_this_frame = 0.0;
              for (int n = 0; n < COMPANION_FRAME; n++) {
                if (!isfinite(pcm[n])) {
                  nonfinite++;
                  continue;
                }
                energy_out += (double)pcm[n] * pcm[n];
                out_this_frame += (double)pcm[n] * pcm[n];
              }
              if (in_this_frame > 0.0) {
                frame_ratio[frame_count++] = sqrt(out_this_frame / in_this_frame);
              }
            }
          }

          /* Insertion sort; forty frames. */
          for (int i = 1; i < frame_count; i++) {
            const double v = frame_ratio[i];
            int j = i - 1;
            while (j >= 0 && frame_ratio[j] > v) {
              frame_ratio[j + 1] = frame_ratio[j];
              j--;
            }
            frame_ratio[j + 1] = v;
          }
          ratio[pass] = frame_count > 0 ? frame_ratio[frame_count / 2] : 0.0;
          }

          check(nonfinite == 0, "output stays finite",
                "the forward pass produced NaN or infinity");

          /* Loose on purpose; the correct ratio is not known. See above. */
          char detail[160];
          snprintf(detail, sizeof detail,
                   "output over input by RMS is %.4f at the median frame",
                   ratio[0]);
          check(ratio[0] > 0.02 && ratio[0] < 50.0,
                "level stays within two orders of magnitude", detail);
          printf("       %s\n", detail);

          /* Eight times the input, and the ratio must not move with it.

             The bound is 3.5x, and it is loose on purpose. What it guards
             against costs ten orders: reinstating the envelope mean takes the
             slope of log(ratio) against log(input) to -4.61 and the ratio
             across a 64x sweep to 1.3e10. A bound anywhere under an order of
             magnitude catches that.

             It is also measuring a weaker property than its name says, and
             the bound is loose partly for that. This test has no codec, so its
             two passes scale a synthetic signal against a *fixed* synthetic
             state: a quiet signal presented with the loud signal's gains and
             energies, which is not a quieter call. What it guards is that the
             response to that mismatch does not explode.

             Real equivariance needs the codec in the loop, re-encoding at each
             level so every feature tracks the signal. Measured that way over
             16x the filter holds to 1.11x with a slope of 1.02, where the
             mismatched sweep reports 0.41. So do not read this number as the
             filter's equivariance, and do not tighten it towards one: it would
             pin the suite to the artefact. See COMPANION-EVIDENCE.md, "Sweep
             the input through the codec, not past it". */
          const double spread = (ratio[0] > 0.0 && ratio[1] > 0.0)
            ? (ratio[0] > ratio[1] ? ratio[0] / ratio[1] : ratio[1] / ratio[0])
            : 0.0;
          char sdetail[160];
          snprintf(sdetail, sizeof sdetail,
                   "%.4f at one level against %.4f at eight times it, %.2fx apart",
                   ratio[0], ratio[1], spread);
          /* This fails, and the failure is the point. It passed while the
             block above filled only half the predictor sets, which left
             sub-frames 2 and 3 with a zero polynomial and a flat clean
             spectrum: 64 of the 93 features degenerate for half of every
             frame. Feeding all four, the port's remaining level dependence
             shows: over a proper codec sweep the median ratio runs 31.3, 8.1,
             9.8, 4.0 across 16x of input, a spread of 7.7 where 1.11 was
             recorded under the degenerate feed.

             The cause is identified and not acted on. Zeroing the cepstrum's
             c0, the mean of the log band magnitudes, so the absolute level,
             returns the sweep to 2.27, 2.17, 2.13, 2.09, a spread of 1.09,
             and gains 1.04 dB against recorded speech. It is the same
             mechanism as the envelope mean that was fixed here already: a
             level reaching an exponentiated gain.

             It is not applied because slot 64 is confirmed to exist in the
             client's vector, so deleting the feature contradicts a structure
             two sources agree on. Normalising the windowed signal instead,
             which would keep the slot and drop the level, is re-refuted under
             this fix: the sweep inverts to 2.9, 22.8, 44.3, 115.7 and quality
             falls 1.87 dB. See COMPANION-EVIDENCE.md. */
          check(spread > 0.0 && spread < 3.5,
                "the level ratio survives an eight-fold input sweep", sdetail);
          printf("       %s\n", sdetail);

          companion_destroy(companion);
        }
        free(model);
      }
      fclose(f);
    }
  }

  printf("\n%s (%d failure%s)\n", failures ? "FAILED" : "all passed",
         failures, failures == 1 ? "" : "s");
  return failures != 0;
}
