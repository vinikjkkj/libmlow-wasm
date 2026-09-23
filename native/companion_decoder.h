#ifndef COMPANION_DECODER_H
#define COMPANION_DECODER_H

#include "companion.h"
#include <opus_smpl_hook.h>

/* The SMPL decoder's per-frame hook, with the Companion as its context:
   register it through OPUS_SET_SMPL_FRAME_HOOK_REQUEST. */
void companion_decoder_hook(void *ctx, float *excitation, const opus_smpl_frame_info *info);

#endif
