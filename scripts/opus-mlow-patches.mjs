// The only changes this library makes to opus_mlow, applied to the extracted
// source before it is built.
//
// They add one thing: a per-frame hook in the SMPL decoder, handed the frame's
// excitation between building it and synthesising it, together with the
// decoder's own view of the frame. The MLow Companion (native/companion.c)
// filters that excitation, which is where the WhatsApp client runs it, and
// needs that view -- the predictor, both pitch lags of every sub-frame, the
// codebook gains -- none of which survives the decode: it lives in locals of
// smpl_core_decode. With no hook registered the decoder is unchanged, bit for
// bit; `node scripts/codec-vectors.mjs` checks that.
//
// Each edit is an exact-string replacement against the pinned release. An
// anchor that is not found fails the build rather than patching the wrong
// place. A stamp in the tree records which version of these edits it carries:
// re-running with the same edits is a no-op, and a tree patched by different
// ones reports itself stale, so the build re-extracts it rather than stacking
// one patch set on another.

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const MARKER = "libmlow-wasm:";

// Private to this build. Upstream uses 4000-4071, and the WhatsApp client's
// decoder registers its Companion weights at 4085.
export const SMPL_FRAME_HOOK_REQUEST = 4880;

const hookHeader = `#ifndef OPUS_SMPL_HOOK_H
#define OPUS_SMPL_HOOK_H

/* ${MARKER} not part of upstream opus_mlow. A per-frame hook in the SMPL
   decoder, registered with OPUS_SET_SMPL_FRAME_HOOK_REQUEST and called once per
   20 ms frame at 16 kHz, between building the frame's excitation and running it
   through the LPC synthesis filter. \`excitation\` is the 320 samples the
   synthesis filter is about to read, which the hook may filter in place; what
   it leaves there is what gets synthesised. The decoder's own history -- the
   adaptive codebook, the PLC's energy -- has already taken the unfiltered
   excitation, so the hook changes the output and nothing the decoder carries
   forward except the synthesis filter's memory. Frames shorter than 20 ms,
   super-wideband frames and stereo streams do not call it: a stereo stream
   runs the core decoder once per channel, and the hook has one context. */

#define OPUS_SET_SMPL_FRAME_HOOK_REQUEST ${SMPL_FRAME_HOOK_REQUEST}

#define OPUS_SMPL_HOOK_SUBFRAMES 4
#define OPUS_SMPL_HOOK_FRAME 320

typedef struct {
  /* Predictor coefficients, -A[i + 1], one set per 80-sample sub-frame. */
  float lpc[OPUS_SMPL_HOOK_SUBFRAMES][16];
  /* The two pitch lags covering each sub-frame, in samples; 0 when unvoiced. */
  float lags[OPUS_SMPL_HOOK_SUBFRAMES][2];
  /* The adaptive-codebook gains as [0, g1, g0, g1, 0], straight from their
     dequantisation -- before the CELP synthesis adjusts them, and whether or
     not the frame is voiced. Zeros in a DTX frame, which decodes none. */
  float ltp[OPUS_SMPL_HOOK_SUBFRAMES][5];
  /* The fixed-codebook gain from its table, and the residual energy decoded. */
  float fcb_gain[OPUS_SMPL_HOOK_SUBFRAMES];
  float nrgres[OPUS_SMPL_HOOK_SUBFRAMES];
  /* The fixed codebook's own contribution to the excitation, summed squared
     over each sub-frame -- the adaptive part and the noise excluded. */
  float fcb_energy[OPUS_SMPL_HOOK_SUBFRAMES];
  /* The bits the range decoder consumed for this frame's parameters; 0 when
     the frame was concealed or carried none. */
  int num_bits;
  /* Nonzero when the frame was concealed rather than decoded. */
  int lost;
  /* The TOC's low-rate flag: set below the encoder's low-rate threshold (12
     kbps for 20 ms wideband), where the decoder tilts voiced excitation and
     shapes unvoiced pulses before the hook sees it. */
  int low_rate;
} opus_smpl_frame_info;

typedef void (*opus_smpl_frame_hook_fn)(void *ctx, float *excitation, const opus_smpl_frame_info *info);

typedef struct {
  opus_smpl_frame_hook_fn fn;
  void *ctx;
} opus_smpl_frame_hook;

#endif
`;

const edits = [
  {
    file: "smpl/smpl_structs.h",
    edits: [
      {
        anchor: `#include "opus_defines.h"\n#include "smpl_defines.h"\n`,
        replace: `#include "opus_defines.h"\n#include "opus_smpl_hook.h" /* ${MARKER} per-frame hook */\n#include "smpl_defines.h"\n`,
      },
      {
        anchor: `    /* I: Last channel in packet                                                            */
    opus_int isLastChannel;
} smpl_DecControlStruct;`,
        replace: `    /* I: Last channel in packet                                                            */
    opus_int isLastChannel;

    /* ${MARKER} optional per-frame hook; see opus_smpl_hook.h */
    opus_smpl_frame_hook frame_hook;
} smpl_DecControlStruct;`,
      },
    ],
  },
  {
    file: "src/opus_decoder.c",
    edits: [
      {
        anchor: `   case OPUS_SET_USE_LPC_POSTFILTER_REQUEST:\n`,
        replace: `   case OPUS_SET_SMPL_FRAME_HOOK_REQUEST: /* ${MARKER} per-frame hook */
   {
       const opus_smpl_frame_hook *hook = va_arg(ap, const opus_smpl_frame_hook *);
#if defined(ENABLE_SMPL)
       if (hook) {
           st->smpl_DecControl.frame_hook = *hook;
       } else {
           st->smpl_DecControl.frame_hook.fn = NULL;
           st->smpl_DecControl.frame_hook.ctx = NULL;
       }
#else
       if (hook)
           goto bad_arg;
#endif
   }
   break;

   case OPUS_SET_USE_LPC_POSTFILTER_REQUEST:\n`,
      },
      {
        anchor: `#include "opus.h"\n#include "entdec.h"\n`,
        replace: `#include "opus.h"\n#include "opus_smpl_hook.h" /* ${MARKER} per-frame hook */\n#include "entdec.h"\n`,
      },
    ],
  },
  {
    file: "smpl/smpl_core_decoder.c",
    edits: [
      {
        anchor: `    LbQuantParams lb_params;
    memset(&lb_params, 0, sizeof(LbQuantParams));
    for (int frame = 0; frame < num_frames; frame++) {`,
        replace: `    LbQuantParams lb_params;
    memset(&lb_params, 0, sizeof(LbQuantParams));
    /* ${MARKER} the per-frame hook runs on 20 ms wideband mono frames only */
    const int hook_on = decControl->frame_hook.fn != NULL && toc->fs_Hz == 16000
        && decControl->nChannelsInternal == 1
        && frame_length_16 == OPUS_SMPL_HOOK_FRAME && lags_per_frame == 2 * OPUS_SMPL_HOOK_SUBFRAMES;
    opus_smpl_frame_info hook_info;
    float hook_acb[SMPL_MAX_N_SUBFR][SMPL_ACBG_M];
    for (int frame = 0; frame < num_frames; frame++) {`,
      },
      {
        anchor: `        float acb_gains[SMPL_MAX_N_SUBFR][SMPL_ACBG_M];
`,
        replace: `        float acb_gains[SMPL_MAX_N_SUBFR][SMPL_ACBG_M];
        int hook_dtx = 0; /* ${MARKER} DTX concealment writes no gains */
`,
      },
      {
        anchor: `            smpl_plc_conceal_celp_dtx(&dec_state->plc, &lb_params, dec_state->lsf_prev, &A[0][0], &lsfs[0][0], num_subframes, lags + frame * lags_per_frame, lags_per_frame);
`,
        replace: `            smpl_plc_conceal_celp_dtx(&dec_state->plc, &lb_params, dec_state->lsf_prev, &A[0][0], &lsfs[0][0], num_subframes, lags + frame * lags_per_frame, lags_per_frame);
            hook_dtx = 1; /* ${MARKER} */
`,
      },
      {
        anchor: `        float normalized_bitrate = smpl_get_normalized_bitrate(`,
        replace: `        if (hook_on) { /* ${MARKER} the gains as dequantised, before synthesis adjusts them */
            if (hook_dtx) {
                memset(hook_acb, 0, sizeof(hook_acb));
            } else {
                memcpy(hook_acb, acb_gains, sizeof(hook_acb));
            }
        }
        float normalized_bitrate = smpl_get_normalized_bitrate(`,
      },
      {
        anchor: `            // LPC Synthesize
            smpl_filt_ar16(&lpc_res[sf * subframe_length_16], subframe_length_16, A[sf], &y[sf * subframe_length_16]);
            smpl_assert(!res);
        }
        if (frame > 0) {`,
        replace: `            // LPC Synthesize
            if (!hook_on) { /* ${MARKER} with the hook, synthesis waits for the whole frame */
                smpl_filt_ar16(&lpc_res[sf * subframe_length_16], subframe_length_16, A[sf], &y[sf * subframe_length_16]);
            }
            smpl_assert(!res);
        }
        if (hook_on) { /* ${MARKER} per-frame hook, on the excitation, then synthesis */
            CelpTables* hook_tbl = (CelpTables*)g_smpl_celp_tables;
            float* hook_gain_tab = lb_params.voiced ? hook_tbl->fcbgains_v : hook_tbl->fcbgains_uv;
            for (int c = 0; c < OPUS_SMPL_HOOK_SUBFRAMES; c++) {
                const int sf = c * num_subframes / OPUS_SMPL_HOOK_SUBFRAMES;
                for (int i = 0; i < SMPL_LPC_ORDER; i++) {
                    hook_info.lpc[c][i] = -A[sf][i + 1];
                }
                hook_info.lags[c][0] = lags[frame * lags_per_frame + 2 * c];
                hook_info.lags[c][1] = lags[frame * lags_per_frame + 2 * c + 1];
                hook_info.ltp[c][0] = 0.0f;
                hook_info.ltp[c][1] = hook_acb[sf][1];
                hook_info.ltp[c][2] = hook_acb[sf][0];
                hook_info.ltp[c][3] = hook_acb[sf][1];
                hook_info.ltp[c][4] = 0.0f;
                hook_info.fcb_gain[c] = hook_gain_tab[lb_params.fcbg_idx[sf]];
                hook_info.nrgres[c] = lb_params.nrgres[sf];
                float hook_fcb_energy = 0.0f;
                for (int i = 0; i < OPUS_SMPL_HOOK_FRAME / OPUS_SMPL_HOOK_SUBFRAMES; i++) {
                    const float v = fcb[c * (OPUS_SMPL_HOOK_FRAME / OPUS_SMPL_HOOK_SUBFRAMES) + i];
                    hook_fcb_energy += v * v;
                }
                hook_info.fcb_energy[c] = hook_fcb_energy;
            }
            hook_info.lost = updLostFlag != SMPL_FLAG_DECODE_NORMAL;
            hook_info.low_rate = toc->low_rate;
            hook_info.num_bits = (!hook_info.lost && bits_used > 0) ? ec_tell(psRangeDec) - bits_used : 0;
            decControl->frame_hook.fn(decControl->frame_hook.ctx, lpc_res, &hook_info);
            for (int sf = 0; sf < num_subframes; sf++) {
                smpl_filt_ar16(&lpc_res[sf * subframe_length_16], subframe_length_16, A[sf], &y[sf * subframe_length_16]);
            }
        }
        if (frame > 0) {`,
      },
    ],
  },
];

const STAMP_FILE = ".libmlow-wasm-patches";
const PATCH_STAMP = createHash("sha256").update(hookHeader).update(JSON.stringify(edits)).digest("hex");

// "clean" for a tree as extracted, "current" for one carrying these edits, and
// "stale" for one carrying any others.
export async function codecPatchState(sourceDir) {
  try {
    const stamp = (await fs.readFile(path.join(sourceDir, STAMP_FILE), "utf8")).trim();
    return stamp === PATCH_STAMP ? "current" : "stale";
  } catch {
    // No stamp: patched by a version that wrote none, or not at all.
  }
  for (const { file } of edits) {
    const text = await fs.readFile(path.join(sourceDir, file), "utf8");
    if (text.includes(MARKER)) {
      return "stale";
    }
  }
  return "clean";
}

export async function applyCodecPatches(sourceDir) {
  const state = await codecPatchState(sourceDir);
  if (state === "current") {
    return;
  }
  if (state === "stale") {
    throw new Error(`opus_mlow patch: ${sourceDir} carries a different patch set; delete it and re-extract`);
  }
  await fs.writeFile(path.join(sourceDir, "include", "opus_smpl_hook.h"), hookHeader);
  for (const { file, edits: fileEdits } of edits) {
    const full = path.join(sourceDir, file);
    let text = await fs.readFile(full, "utf8");
    for (const { anchor, replace } of fileEdits) {
      const first = text.indexOf(anchor);
      if (first < 0 || text.indexOf(anchor, first + 1) >= 0) {
        throw new Error(`opus_mlow patch: anchor not found exactly once in ${file}: ${anchor.slice(0, 60)}`);
      }
      text = text.replace(anchor, () => replace);
    }
    await fs.writeFile(full, text);
  }
  await fs.writeFile(path.join(sourceDir, STAMP_FILE), `${PATCH_STAMP}
`);
}
