#include <opus.h>
#include <opus_smpl_hook.h>

#include "companion_decoder.h"

/* MLOW_MULTI_TOC_MASK — SID and FEC bits, marking a multiframe packet. */
#define MLOW_MULTIFRAME_MARKER 0x82
/* At and above this the TOC selects CELT, not the MLow layout. */
#define MLOW_CELT_RANGE_START 0xC0
/* The frame-count byte carries the count in its low six bits; the top two are
   flags. Bit 6 marks padding lengths before the size table. Bit 7 is also set
   on the wire — seen in live traffic — for a purpose we have not identified.
   Neither is the RFC 6716 code-3 encoding, where those bits mean other things.

   The count itself never exceeds 18, so the mask has room to spare and stays
   correct if a third flag turns up. */
#define MLOW_FRAME_COUNT_MASK 0x3F
#define MLOW_COUNT_FLAGS 0xC0

int oc_mlow_strip_padding_flag(unsigned char *data, opus_int32 len);

OpusEncoder *oc_create_encoder(int sample_rate, int channels, int application, int *error) {
  return opus_encoder_create(sample_rate, channels, application, error);
}

void oc_destroy_encoder(OpusEncoder *encoder) {
  opus_encoder_destroy(encoder);
}

int oc_encode(
  OpusEncoder *encoder,
  const opus_int16 *pcm,
  int frame_size,
  unsigned char *data,
  opus_int32 max_data_bytes
) {
  return opus_encode(encoder, pcm, frame_size, data, max_data_bytes);
}

int oc_encode_float(
  OpusEncoder *encoder,
  const float *pcm,
  int frame_size,
  unsigned char *data,
  opus_int32 max_data_bytes
) {
  return opus_encode_float(encoder, pcm, frame_size, data, max_data_bytes);
}

int oc_encoder_ctl(OpusEncoder *encoder, int request, int value) {
  switch (request) {
    case OPUS_SET_APPLICATION_REQUEST:
      return opus_encoder_ctl(encoder, OPUS_SET_APPLICATION(value));
    case OPUS_SET_BITRATE_REQUEST:
      return opus_encoder_ctl(encoder, OPUS_SET_BITRATE(value));
    case OPUS_SET_MAX_BANDWIDTH_REQUEST:
      return opus_encoder_ctl(encoder, OPUS_SET_MAX_BANDWIDTH(value));
    case OPUS_SET_VBR_REQUEST:
      return opus_encoder_ctl(encoder, OPUS_SET_VBR(value));
    case OPUS_SET_BANDWIDTH_REQUEST:
      return opus_encoder_ctl(encoder, OPUS_SET_BANDWIDTH(value));
    case OPUS_SET_COMPLEXITY_REQUEST:
      return opus_encoder_ctl(encoder, OPUS_SET_COMPLEXITY(value));
    case OPUS_SET_INBAND_FEC_REQUEST:
      return opus_encoder_ctl(encoder, OPUS_SET_INBAND_FEC(value));
    case OPUS_SET_PACKET_LOSS_PERC_REQUEST:
      return opus_encoder_ctl(encoder, OPUS_SET_PACKET_LOSS_PERC(value));
    case OPUS_SET_DTX_REQUEST:
      return opus_encoder_ctl(encoder, OPUS_SET_DTX(value));
    case OPUS_SET_VBR_CONSTRAINT_REQUEST:
      return opus_encoder_ctl(encoder, OPUS_SET_VBR_CONSTRAINT(value));
    case OPUS_SET_FORCE_CHANNELS_REQUEST:
      return opus_encoder_ctl(encoder, OPUS_SET_FORCE_CHANNELS(value));
    case OPUS_SET_SIGNAL_REQUEST:
      return opus_encoder_ctl(encoder, OPUS_SET_SIGNAL(value));
    case OPUS_SET_LSB_DEPTH_REQUEST:
      return opus_encoder_ctl(encoder, OPUS_SET_LSB_DEPTH(value));
    case OPUS_SET_EXPERT_FRAME_DURATION_REQUEST:
      return opus_encoder_ctl(encoder, OPUS_SET_EXPERT_FRAME_DURATION(value));
    case OPUS_SET_PREDICTION_DISABLED_REQUEST:
      return opus_encoder_ctl(encoder, OPUS_SET_PREDICTION_DISABLED(value));
    case OPUS_SET_PHASE_INVERSION_DISABLED_REQUEST:
      return opus_encoder_ctl(encoder, OPUS_SET_PHASE_INVERSION_DISABLED(value));
    case OPUS_SET_USE_SMPL_REQUEST:
      return opus_encoder_ctl(encoder, OPUS_SET_USING_SMPL(value));
    case OPUS_SET_ENC_HP_CUTOFF_REQUEST:
      return opus_encoder_ctl(encoder, OPUS_SET_ENC_HP_CUTOFF(value));
    case OPUS_SET_SECONDARY_COMPLEXITY_REQUEST:
      return opus_encoder_ctl(encoder, OPUS_SET_SECONDARY_COMPLEXITY(value));
    case OPUS_SET_SECONDARY_BITRATE_REQUEST:
      return opus_encoder_ctl(encoder, OPUS_SET_SECONDARY_BITRATE(value));
    case OPUS_SET_MLOW_SUBFRAME_IMP_REQUEST:
      return opus_encoder_ctl(encoder, OPUS_SET_MLOW_SUBFRAME_IMP(value));
    case OPUS_SET_MLOW_USE_SP_ACT_FLAT_REQUEST:
      return opus_encoder_ctl(encoder, OPUS_SET_MLOW_USE_SP_ACT_FLAT(value));
    case OPUS_SET_MLOW_VAD_NL_UPD_SPEED_REQUEST:
      return opus_encoder_ctl(encoder, OPUS_SET_MLOW_VAD_NL_UPD_SPEED(value));
    case OPUS_SET_MLOW_VAD_NON_BINARY_REQUEST:
      return opus_encoder_ctl(encoder, OPUS_SET_MLOW_VAD_NON_BINARY(value));
    case OPUS_SET_MLOW_VAD_HP_SHARPNESS_REQUEST:
      return opus_encoder_ctl(encoder, OPUS_SET_MLOW_VAD_HP_SHARPNESS(value));
    case OPUS_SET_MLOW_USE_FEC_RATE_COMP_REQUEST:
      return opus_encoder_ctl(encoder, OPUS_SET_MLOW_USE_FEC_RATE_COMP(value));
    default:
      return OPUS_UNIMPLEMENTED;
  }
}

int oc_encoder_ctl_get_bitrate(OpusEncoder *encoder) {
  opus_int32 bitrate = 0;
  int error = opus_encoder_ctl(encoder, OPUS_GET_BITRATE(&bitrate));
  if (error != OPUS_OK) {
    return error;
  }
  return bitrate;
}

int oc_encoder_ctl_get_lookahead(OpusEncoder *encoder) {
  int lookahead = 0;
  int error = opus_encoder_ctl(encoder, OPUS_GET_LOOKAHEAD(&lookahead));
  if (error != OPUS_OK) {
    return error;
  }
  return lookahead;
}

int oc_encoder_ctl_get_in_dtx(OpusEncoder *encoder) {
  int in_dtx = 0;
  int error = opus_encoder_ctl(encoder, OPUS_GET_IN_DTX(&in_dtx));
  if (error != OPUS_OK) {
    return error;
  }
  return in_dtx;
}

OpusDecoder *oc_create_decoder(int sample_rate, int channels, int *error) {
  return opus_decoder_create(sample_rate, channels, error);
}

void oc_destroy_decoder(OpusDecoder *decoder) {
  opus_decoder_destroy(decoder);
}

int oc_decode(
  OpusDecoder *decoder,
  const unsigned char *data,
  opus_int32 len,
  opus_int16 *pcm,
  int frame_size,
  int decode_fec
) {
  return opus_decode(decoder, data, len, pcm, frame_size, decode_fec);
}

int oc_decode_float(
  OpusDecoder *decoder,
  const unsigned char *data,
  opus_int32 len,
  float *pcm,
  int frame_size,
  int decode_fec
) {
  return opus_decode_float(decoder, data, len, pcm, frame_size, decode_fec);
}

int oc_packet_get_bandwidth(const unsigned char *data) {
  return opus_packet_get_bandwidth(data);
}

int oc_packet_get_nb_channels(const unsigned char *data) {
  return opus_packet_get_nb_channels(data);
}

int oc_packet_get_nb_frames(const unsigned char *data, opus_int32 len) {
  return opus_packet_get_nb_frames(data, len);
}

int oc_packet_get_nb_samples(const unsigned char *data, opus_int32 len, opus_int32 sample_rate) {
  return opus_packet_get_nb_samples(data, len, sample_rate);
}

int oc_packet_get_samples_per_frame(const unsigned char *data, opus_int32 sample_rate) {
  return opus_packet_get_samples_per_frame(data, sample_rate);
}

int oc_packet_parse(const unsigned char *data, opus_int32 len) {
  unsigned char toc = 0;
  /* opus_packet_parse() fills only the entries it reports, so pre-zeroing
     288 bytes per call was wasted work. */
  const unsigned char *frames[48];
  opus_int16 frame_sizes[48];
  int payload_offset = 0;
  return opus_packet_parse(data, len, &toc, frames, frame_sizes, &payload_offset);
}

/* Validation decoders, kept alive and reused.
   Building one costs a ~50 KB allocation plus ~85 KB of zeroing, which is far
   more than the decode itself; since the PCM is discarded, carrying state
   across packets is harmless. Five rates x two channel counts covers every
   combination the API accepts. */
#define OC_VALIDATE_RATES 5
static const opus_int32 oc_validate_rate_table[OC_VALIDATE_RATES] = {8000, 12000, 16000, 24000, 48000};
static OpusDecoder *oc_validate_decoders[OC_VALIDATE_RATES][2] = {{0}};

/* Scratch for discarded PCM. In BSS rather than on the stack, where it was
   23 KB zeroed per call. */
static opus_int16 oc_validate_pcm[5760 * 2];

static OpusDecoder *oc_validation_decoder(opus_int32 sample_rate, int channels, int *error) {
  int rate_index = -1;
  for (int i = 0; i < OC_VALIDATE_RATES; i++) {
    if (oc_validate_rate_table[i] == sample_rate) {
      rate_index = i;
      break;
    }
  }
  if (rate_index < 0 || (channels != 1 && channels != 2)) {
    *error = OPUS_BAD_ARG;
    return 0;
  }
  OpusDecoder **slot = &oc_validate_decoders[rate_index][channels - 1];
  if (*slot == 0) {
    *slot = opus_decoder_create(sample_rate, channels, error);
    if (*error != OPUS_OK) {
      *slot = 0;
      return 0;
    }
  }
  *error = OPUS_OK;
  return *slot;
}

int oc_packet_validate_decode(const unsigned char *data, opus_int32 len, opus_int32 sample_rate) {
  if (len < 1) {
    return OPUS_INVALID_PACKET;
  }
  int channels = opus_packet_get_nb_channels(data);
  if (channels != 1 && channels != 2) {
    return OPUS_INVALID_PACKET;
  }
  int error = OPUS_OK;
  OpusDecoder *decoder = oc_validation_decoder(sample_rate, channels, &error);
  if (decoder == 0) {
    return error;
  }
  int max_frame_size = (sample_rate / 1000) * 120;
  return opus_decode(decoder, data, len, oc_validate_pcm, max_frame_size, 0);
}

/* Fills `out` with everything getPacketInfo needs in one crossing.
   [0]=frames [1]=samples [2]=samples_per_frame [3]=channels [4]=bandwidth */
int oc_packet_info(const unsigned char *data, opus_int32 len, opus_int32 sample_rate, int *out) {
  if (len < 1) {
    return OPUS_INVALID_PACKET;
  }
  int validated = oc_packet_validate_decode(data, len, sample_rate);
  if (validated < 0) {
    return validated;
  }
  unsigned char toc = 0;
  const unsigned char *frames[48];
  opus_int16 frame_sizes[48];
  int payload_offset = 0;
  int nb_frames = opus_packet_parse(data, len, &toc, frames, frame_sizes, &payload_offset);
  if (nb_frames < 0) {
    return nb_frames;
  }
  int samples = opus_packet_get_nb_samples(data, len, sample_rate);
  if (samples < 0) {
    return samples;
  }
  int bandwidth = opus_packet_get_bandwidth(data);
  if (bandwidth < 0) {
    return bandwidth;
  }
  out[0] = nb_frames;
  out[1] = samples;
  out[2] = opus_packet_get_samples_per_frame(data, sample_rate);
  out[3] = opus_packet_get_nb_channels(data);
  out[4] = bandwidth;
  return OPUS_OK;
}

/* Same idea for MLow packets, which previously took eight crossings.
   [0]=frames [1]=samples [2]=samples_per_frame [3]=channels [4]=bandwidth
   [5]=has_vad [6]=has_fec [7..10]=toc{mode,bandwidth,samples_per_frame,stereo} */
/* `data` is the caller's staged copy, so the flag bits can be cleared in place
   here rather than making the caller do it first. Inspecting a packet has to
   tolerate exactly what decoding it tolerates: a WhatsApp packet carrying the
   flags parses one way through the decoder and was refused here. */
int oc_mlow_packet_info(unsigned char *data, opus_int32 len, opus_int32 sample_rate, int *out) {
  if (len < 1) {
    return OPUS_INVALID_PACKET;
  }
  oc_mlow_strip_padding_flag(data, len);
  unsigned char toc = 0;
  const unsigned char *frames[48];
  opus_int16 frame_sizes[48];
  int payload_offset = 0;
  int nb_frames = mlow_packet_parse(data, len, &toc, frames, frame_sizes, &payload_offset);
  if (nb_frames < 0) {
    return nb_frames;
  }
  int samples = mlow_packet_get_nb_samples(data, len, sample_rate);
  if (samples < 0) {
    return samples;
  }
  int bandwidth = mlow_packet_get_bandwidth(data);
  if (bandwidth < 0) {
    return bandwidth;
  }
  out[0] = nb_frames;
  out[1] = samples;
  out[2] = mlow_packet_get_samples_per_frame(data, sample_rate);
  out[3] = mlow_packet_get_nb_channels(data);
  out[4] = bandwidth;
  out[5] = mlow_packet_has_vad_flag(data);
  out[6] = mlow_packet_has_fec_content(data);
  mlow_packet_parse_toc(data, &out[7]);
  return OPUS_OK;
}

int oc_decoder_ctl(OpusDecoder *decoder, int request, int value) {
  switch (request) {
    case OPUS_SET_GAIN_REQUEST:
      return opus_decoder_ctl(decoder, OPUS_SET_GAIN(value));
    case OPUS_SET_PHASE_INVERSION_DISABLED_REQUEST:
      return opus_decoder_ctl(decoder, OPUS_SET_PHASE_INVERSION_DISABLED(value));
    case OPUS_SET_USE_LPC_POSTFILTER_REQUEST:
      return opus_decoder_ctl(decoder, OPUS_SET_USE_LPC_POSTFILTER(value));
    case OPUS_SET_USE_SMPL_REQUEST:
      return opus_decoder_ctl(decoder, OPUS_SET_USING_SMPL(value));
    default:
      return OPUS_UNIMPLEMENTED;
  }
}

int oc_mlow_packet_parse(const unsigned char *data, opus_int32 len) {
  unsigned char toc = 0;
  const unsigned char *frames[48];
  opus_int16 frame_sizes[48];
  int payload_offset = 0;
  return mlow_packet_parse(data, len, &toc, frames, frame_sizes, &payload_offset);
}

int oc_mlow_packet_get_bandwidth(const unsigned char *data) {
  return mlow_packet_get_bandwidth(data);
}

int oc_mlow_packet_get_nb_channels(const unsigned char *data) {
  return mlow_packet_get_nb_channels(data);
}

int oc_mlow_packet_get_nb_frames(const unsigned char *data, opus_int32 len) {
  return mlow_packet_get_nb_frames(data, len);
}

int oc_mlow_packet_get_nb_samples(const unsigned char *data, opus_int32 len, opus_int32 sample_rate) {
  return mlow_packet_get_nb_samples(data, len, sample_rate);
}

int oc_mlow_packet_get_samples_per_frame(const unsigned char *data, opus_int32 sample_rate) {
  return mlow_packet_get_samples_per_frame(data, sample_rate);
}

/* Clears the flag bits in a staged multiframe packet's frame-count byte so the
   upstream parser accepts it.

   Only the low six bits carry the count. WhatsApp uses the top two as flags,
   while opus_mlow never sets either and so reads the byte whole, rejecting
   anything outside 2..18.

Masking rather than clearing known bits one at a time is the point: the count
   cannot exceed 18, so anything above the low six bits is a flag whether or not
   we have identified it, and a flag we have not seen would otherwise be read as
   part of the count and reject the packet.

   The byte was seen as 0x03, 0x46, 0x86 and 0xc3 in buffers scanned from a
   running client. Those buffers were later withdrawn as probably not packets,
   and a packet since captured from a live call carries 0x00 here — so no flag
   has ever been observed on real traffic. The masking still stands on the
   argument above rather than on that evidence, and is strictly more permissive
   than clearing known bits one at a time.

   The parser reads the size table regardless of these bits, so dropping them
   loses nothing it would have acted on.

   Operates on the decoder's staged copy, never on caller memory. Returns 1 if
   the packet was altered. */
int oc_mlow_strip_padding_flag(unsigned char *data, opus_int32 len) {
  if (len < 2) {
    return 0;
  }
  unsigned char marker = data[0];
  int is_multiframe = (marker & MLOW_MULTIFRAME_MARKER) == MLOW_MULTIFRAME_MARKER
                      && marker < MLOW_CELT_RANGE_START;
  if (!is_multiframe || (data[1] & MLOW_COUNT_FLAGS) == 0) {
    return 0;
  }
  data[1] &= MLOW_FRAME_COUNT_MASK;
  return 1;
}

int oc_mlow_packet_has_vad_flag(const unsigned char *data) {
  return mlow_packet_has_vad_flag(data);
}

int oc_mlow_packet_has_fec_content(const unsigned char *data) {
  return mlow_packet_has_fec_content(data);
}

void oc_mlow_packet_parse_toc(const unsigned char *data, int *toc_fields) {
  mlow_packet_parse_toc(data, toc_fields);
}

OpusRepacketizer *oc_repacketizer_create(void) {
  return opus_repacketizer_create();
}

void oc_repacketizer_destroy(OpusRepacketizer *rp) {
  opus_repacketizer_destroy(rp);
}

void oc_repacketizer_init(OpusRepacketizer *rp) {
  opus_repacketizer_init(rp);
}

void oc_repacketizer_set_using_mlow(OpusRepacketizer *rp, int using_mlow) {
  opus_repacketizer_set_using_mlow(rp, using_mlow);
}

int oc_repacketizer_cat(OpusRepacketizer *rp, const unsigned char *data, opus_int32 len) {
  return opus_repacketizer_cat(rp, data, len);
}

int oc_repacketizer_get_nb_frames(OpusRepacketizer *rp) {
  return opus_repacketizer_get_nb_frames(rp);
}

int oc_repacketizer_out(OpusRepacketizer *rp, unsigned char *data, opus_int32 maxlen) {
  return opus_repacketizer_out(rp, data, maxlen);
}

int oc_repacketizer_out_range(
  OpusRepacketizer *rp,
  int begin,
  int end,
  unsigned char *data,
  opus_int32 maxlen
) {
  return opus_repacketizer_out_range(rp, begin, end, data, maxlen);
}

/* Packs `count` contiguous frames into one MLow multiframe packet in a single
   call, so the JS side crosses the boundary once instead of once per frame.
   `data` holds the frames back to back; `lengths` holds their sizes. */
int oc_mlow_repacketize(
  OpusRepacketizer *rp,
  const unsigned char *data,
  const int *lengths,
  int count,
  int using_mlow,
  unsigned char *out,
  opus_int32 max_out
) {
  if (count <= 0) {
    return OPUS_BAD_ARG;
  }
  opus_repacketizer_init(rp);
  opus_repacketizer_set_using_mlow(rp, using_mlow);
  opus_int32 offset = 0;
  for (int i = 0; i < count; i++) {
    int len = lengths[i];
    if (len <= 0) {
      return OPUS_BAD_ARG;
    }
    int error = opus_repacketizer_cat(rp, data + offset, len);
    if (error != OPUS_OK) {
      return error;
    }
    offset += len;
  }
  return opus_repacketizer_out(rp, out, max_out);
}

int oc_encode_secondary(OpusEncoder *encoder, unsigned char *data, opus_int32 max_data_bytes) {
  return opus_encode_secondary(encoder, data, max_data_bytes);
}

void oc_global_create(void) {
  opus_global_create();
}

void oc_global_free(void) {
  for (int rate = 0; rate < OC_VALIDATE_RATES; rate++) {
    for (int ch = 0; ch < 2; ch++) {
      if (oc_validate_decoders[rate][ch] != 0) {
        opus_decoder_destroy(oc_validate_decoders[rate][ch]);
        oc_validate_decoders[rate][ch] = 0;
      }
    }
  }
  opus_global_free();
}

/* The MLow Companion. One instance filters one decoder's stream: it carries
   that stream's recurrent state and filter memories, so two decoders cannot
   share one. The model buffer is only read by oc_companion_create. */
MlowCompanion *oc_companion_create(const unsigned char *model, int model_bytes, int *error) {
  if (model == 0 || model_bytes <= 0) {
    if (error != 0) {
      *error = COMPANION_BAD_ARG;
    }
    return 0;
  }
  return companion_create(model, (size_t)model_bytes, error);
}

void oc_companion_destroy(MlowCompanion *companion) {
  companion_destroy(companion);
}

void oc_companion_reset(MlowCompanion *companion) {
  if (companion != 0) {
    companion_reset(companion);
  }
}

/* Registers `companion` as the decoder's per-frame SMPL hook, or removes it
   when `companion` is null. The decoder only calls it on 20 ms wideband MLow
   frames; everything else decodes as before. OPUS_RESET_STATE does not remove
   it, and does not reset the companion either. */
int oc_decoder_set_companion(OpusDecoder *decoder, MlowCompanion *companion) {
  if (companion == 0) {
    return opus_decoder_ctl(decoder, OPUS_SET_SMPL_FRAME_HOOK_REQUEST, (const opus_smpl_frame_hook *)0);
  }
  const opus_smpl_frame_hook hook = { companion_decoder_hook, companion };
  return opus_decoder_ctl(decoder, OPUS_SET_SMPL_FRAME_HOOK_REQUEST, &hook);
}

const char *oc_strerror(int code) {
  return opus_strerror(code);
}

const char *oc_get_version_string(void) {
  return opus_get_version_string();
}
