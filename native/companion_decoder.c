/* Runs the MLow Companion inside the SMPL decoder.
 *
 * The decoder calls companion_decoder_hook once per 20 ms wideband frame, with
 * the frame's excitation just before the LPC synthesis filter reads it and its
 * own view of the frame (see opus_smpl_hook.h, which the build adds to the
 * codec). This file turns that view into a CompanionFrameState and filters the
 * excitation in place, so the synthesis filter shapes the Companion's output
 * into speech.
 *
 * The excitation, not the speech: the client's first adaptive filter reads
 * the decoder's excitation sample for sample -- correlation 1.00000 at scale
 * 1.0000 over sixty frames of a real decode -- where the synthesised speech
 * correlates 0.13 with it. See native/COMPANION-EVIDENCE.md.
 *
 * Each field is filled the way the stage-by-stage comparison against the
 * client filled it, with one difference that is an improvement: both pitch
 * lags of every sub-frame are available here, where the codec's feature dump
 * that the comparison used keeps only one in two. See
 * native/COMPANION-EVIDENCE.md. */

#include "companion_decoder.h"

#include <string.h>

/* The residual energy the decode context's second slot carries has a floor,
   the same one the comparison harness used; see decode_context in
   companion.h. */
#define COMPANION_DECODER_ENERGY_FLOOR 1e-5f

void companion_decoder_hook(void *ctx, float *excitation, const opus_smpl_frame_info *info) {
  MlowCompanion *companion = (MlowCompanion *)ctx;
  if (companion == NULL || excitation == NULL || info == NULL) {
    return;
  }

  CompanionFrameState state;
  memset(&state, 0, sizeof state);
  state.lpc_order = COMPANION_LPC_ORDER;
  for (int sub = 0; sub < COMPANION_SUBFRAMES; sub++) {
    memcpy(state.lpc[sub], info->lpc[sub], sizeof state.lpc[sub]);
    state.lag[sub][0] = info->lags[sub][0];
    state.lag[sub][1] = info->lags[sub][1];
    memcpy(state.ltp[sub], info->ltp[sub], sizeof state.ltp[sub]);

    /* The second slot is the fixed codebook's energy alone. Against the
       client's own feature vector over a real decode it matches to
       correlation 1.00000 and a worst error of 0; the whole excitation's
       energy reads 0.84, and the encoder's residual, which the stage-by-stage
       comparison used, 0.98. */
    state.decode_context[sub][0] = info->fcb_gain[sub];
    state.decode_context[sub][1] = info->fcb_energy[sub] + COMPANION_DECODER_ENERGY_FLOOR;
    state.decode_context[sub][2] = info->nrgres[sub];
  }
  state.num_bits = (float)info->num_bits;
  state.low_rate = (float)info->low_rate;
  /* The features read the same excitation the filter is handed -- after the
     low-rate tilt and pulse shaping, where those apply. At 8 kbps, against the
     client's own vector, reading it before them gives the cepstrum a worst
     error of 0.77 and the pitch correlation 0.19; reading it here, 0.044 and
     0.0093, which is the two codecs' own disagreement at that rate. */
  memcpy(state.excitation, excitation, sizeof state.excitation);

  /* A failure leaves the excitation as the decoder produced it, which is the
     right degradation for a post-filter. It can only fail on a malformed
     model, and companion_create has already validated that. */
  (void)companion_process(companion, excitation, &state);
}
