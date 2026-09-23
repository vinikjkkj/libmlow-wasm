/* MLow Companion — DNNw container reader and forward pass.
 *
 * The container is a flat run of 128-byte-aligned chunks, each holding one
 * named tensor. Walking it is deterministic: every chunk's successor comes from
 * its own header, so parsing never scans for the magic and ends exactly at the
 * last byte. A wrong magic therefore means the walk lost alignment, not that a
 * chunk is corrupt.
 */
#include "companion.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "companion_features.h"
#include "companion_net.h"
#include "companion_tables.h"

#define DNNW_MAGIC 0x444e4e77u /* "DNNw" */
#define DNNW_ALIGNMENT 128
#define DNNW_HEADER_BYTES 20
#define DNNW_DTYPE_FLOAT32 0
#define DNNW_DTYPE_INT8 3

#define COMPANION_ADACONV_TAPS 32
#define COMPANION_SHAPE_SIZE 80

/* Layer slots, in the order the forward pass uses them. */
enum {
  L_PITCH_EMBEDDING,
  L_CONV1,
  L_CONV2,
  L_TCONV,
  L_GRU_INPUT,
  L_GRU_RECURRENT,
  L_AF1_KERNEL,
  L_AF1_GAIN,
  L_AF4_KERNEL,
  L_AF4_GAIN,
  L_TDSHAPE_ALPHA1_F,
  L_TDSHAPE_ALPHA1_T,
  L_TDSHAPE_ALPHA2,
  L_FT1,
  L_FT2,
  L_COUNT
};

static const char *const LAYER_NAMES[L_COUNT] = {
  "mlowcompanion_pitch_embedding",
  "mlowcompanion_fnet_conv1",
  "mlowcompanion_fnet_conv2",
  "mlowcompanion_fnet_tconv",
  "mlowcompanion_fnet_gru_input",
  "mlowcompanion_fnet_gru_recurrent",
  "mlowcompanion_af1_kernel",
  "mlowcompanion_af1_gain",
  "mlowcompanion_af4_kernel",
  "mlowcompanion_af4_gain",
  "mlowcompanion_tdshape1_alpha1_f",
  "mlowcompanion_tdshape1_alpha1_t",
  "mlowcompanion_tdshape1_alpha2",
  "mlowcompanion_ft1",
  "mlowcompanion_ft2"
};

struct MlowCompanion {
  CompanionLayer layers[L_COUNT];
  /* Dequantised weights and biases, owned by this instance. */
  float *storage[L_COUNT * 2];

  /* Streaming state, cleared by companion_reset. */
  float hidden[COMPANION_HIDDEN];
  /* conv2 spans two frames: it takes the previous frame's four conv1 outputs
     alongside the current frame's. Forced by the dimensions rather than
     inferred: the GRU consumes 160 per step and tconv emits 640, so there are
     exactly four sub-frames; conv2 takes 768/96 = 8 conv1 vectors, so two
     frames. The rival reading of eight sub-frames in one frame would need
     tconv to emit 1280. */
  float previous_conv1[COMPANION_SUBFRAMES][COMPANION_CONV1_OUT];
  float af1_history[COMPANION_SUBFRAME_SAMPLES];
  float af4_history[COMPANION_SUBFRAME_SAMPLES * 2];  /* two streams */
  CompanionConvState af1_state;
  CompanionConvState af4_state;
  CompanionShapeState shape_state;
  /* The GRU's state one sub-frame back: the older half of both transforms'
     kernel-2 input. */
  float previous_ft[COMPANION_HIDDEN];
  float previous_shape_features[COMPANION_HIDDEN];


  /* Per-call scratch, sized once so the hot path never allocates. */
  float window[COMPANION_FRAME];
  /* The decoder's excitation, with enough history in front for the widest
     reach back: the cepstrum opens half a frame early and the correlation
     looks one pitch period behind.

     The excitation and not the decoded audio, which is what this used to
     hold: measured against the client's own features, the cepstrum drawn
     from the audio correlates 0.599 with the client's and the one drawn from
     the excitation 1.000. See `excitation` in companion.h. */
  float excitation[COMPANION_HISTORY + COMPANION_FRAME];
  /* Room for a padded polynomial, its spectrum, and the bands drawn from it. */
  float feature_scratch[COMPANION_FRAME + COMPANION_SPECTRUM_BINS + COMPANION_CLEAN_BANDS];
  /* One vector per sub-frame, and conv1's output for each. */
  float features[COMPANION_SUBFRAMES][COMPANION_FEATURES];
  float conv1_out[COMPANION_SUBFRAMES][COMPANION_CONV1_OUT];
  float conv2_out[COMPANION_HIDDEN];
  float tconv_out[COMPANION_HIDDEN * COMPANION_TCONV_UPSAMPLE];
  /* What conditions the adaptive filters, and what conditions the shaping. */
  float ft1_out[COMPANION_HIDDEN];
  float ft2_out[COMPANION_HIDDEN];
  float ft_in[COMPANION_HIDDEN * 2];
  float filtered[COMPANION_FRAME];
  /* af1 emits two streams of one sub-frame each, consecutively. */
  float streams[COMPANION_SUBFRAME_SAMPLES * 2];
  float gru_scratch[COMPANION_HIDDEN * 6];
  /* shape_size * 3 for AdaShape, plus its envelope; AdaConv needs far less. */
  float net_scratch[COMPANION_HIDDEN * 2 + COMPANION_SHAPE_SIZE * 2 + 64];

  /* cos/sin tables for the feature FFT. */
  float *fft_cos;
  float *fft_sin;
};

static uint32_t read_u32(const uint8_t *p) {
  return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

static uint32_t read_u32_be(const uint8_t *p) {
  return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | (uint32_t)p[3];
}

static float read_f32(const uint8_t *p) {
  /* The payload is not guaranteed to be 4-byte aligned in the file, so assemble
     the value rather than dereferencing a float pointer into it. */
  uint32_t bits = read_u32(p);
  float value;
  memcpy(&value, &bits, sizeof value);
  return value;
}

static size_t align_up(size_t value, size_t alignment) {
  return ((value + alignment - 1) / alignment) * alignment;
}

typedef struct {
  const uint8_t *data;
  uint32_t bytes;
  uint32_t dtype;
} Chunk;

/* Finds one tensor by name. Linear, but only during load. */
static int find_chunk(
  const uint8_t *model,
  size_t model_bytes,
  const char *name,
  Chunk *out
) {
  size_t offset = 0;
  const size_t name_len = strlen(name);
  while (offset + DNNW_HEADER_BYTES <= model_bytes) {
    if (read_u32_be(model + offset) != DNNW_MAGIC) {
      return COMPANION_BAD_MODEL;
    }
    const uint32_t dtype = read_u32(model + offset + 8);
    const uint32_t bytes = read_u32(model + offset + 12);
    const uint32_t padded = read_u32(model + offset + 16);

    size_t name_start = offset + DNNW_HEADER_BYTES;
    size_t name_end = name_start;
    while (name_end < model_bytes && model[name_end] != 0) {
      name_end++;
    }
    if (name_end >= model_bytes) {
      return COMPANION_BAD_MODEL;
    }
    /* The payload starts at the next 128-byte boundary after the name, not
       immediately after its terminator: the gap between the two is zero-filled
       alignment padding. Reading from the terminator yields a buffer shifted by
       up to 127 bytes, which still parses as floats — just wrong ones. */
    const size_t data_offset = align_up(name_end + 1, DNNW_ALIGNMENT);
    if (data_offset + bytes > model_bytes) {
      return COMPANION_BAD_MODEL;
    }
    if (name_end - name_start == name_len
        && memcmp(model + name_start, name, name_len) == 0) {
      out->data = model + data_offset;
      out->bytes = bytes;
      out->dtype = dtype;
      return COMPANION_OK;
    }
    /* `padded` is already a multiple of the alignment, so this lands on the
       next chunk exactly. */
    offset = data_offset + padded;
  }
  return COMPANION_MISSING_TENSOR;
}

#ifdef COMPANION_TRACE
/* Reports the largest magnitude a stage produced, so an explosion can be
   attributed to the stage that starts it rather than the one that shows it. */
static void trace_stage(const char *name, const float *v, int n) {
  float peak = 0.0f;
  double energy = 0.0;
  for (int i = 0; i < n; i++) {
    const float a = v[i] < 0.0f ? -v[i] : v[i];
    if (a > peak) peak = a;
    energy += (double)v[i] * v[i];
  }
  const double rms = sqrt(energy / n);
  fprintf(stderr, "    %-22s peak %12.6f  rms %12.6f  crest %6.3f\n",
          name, peak, rms, rms > 0.0 ? peak / rms : 0.0);
}
/* Activations want a different summary from signals. What matters for a tanh
   is how much of it sits at the rails: a trained network has almost nothing
   there, and a constant term large enough to swamp the input pins everything.
   Peak and crest say nothing about that — peak is 1.0 either way. */
static void trace_activation(const char *name, const float *v, int n) {
  double energy = 0.0;
  int railed = 0;
  for (int i = 0; i < n; i++) {
    const float a = v[i] < 0.0f ? -v[i] : v[i];
    energy += (double)v[i] * v[i];
    if (a > 0.99f) railed++;
  }
  fprintf(stderr, "    %-22s rms %7.4f  at the rails %5.1f%%\n",
          name, sqrt(energy / n), 100.0 * railed / n);
}
#define TRACE(name, v, n) trace_stage(name, v, n)
#define TRACE_ACT(name, v, n) trace_activation(name, v, n)
#else
#define TRACE(name, v, n) ((void)0)
#define TRACE_ACT(name, v, n) ((void)0)
#endif

static float *alloc_floats(int count) {
  return (float *)calloc((size_t)count, sizeof(float));
}

/* Loads one layer, dequantising if it was stored as int8.
 *
 * No layer ships both int8 and float weights, so the dtype present decides.
 * int8 layers carry a per-output-channel scale and a subias; the scale is
 * applied as `w = 127 * scale[oc] * q`, and `subias` is not used — see the
 * expansion below for both. */
static int load_layer(
  MlowCompanion *self,
  const uint8_t *model,
  size_t model_bytes,
  int slot
) {
  const char *base = LAYER_NAMES[slot];
  char name[128];

  snprintf(name, sizeof name, "%s_bias", base);
  Chunk bias_chunk;
  int rc = find_chunk(model, model_bytes, name, &bias_chunk);
  if (rc != COMPANION_OK) {
    return rc;
  }
  const int output_size = (int)(bias_chunk.bytes / 4);
  float *bias = alloc_floats(output_size);
  if (bias == NULL) {
    return COMPANION_ALLOC_FAILED;
  }
  for (int i = 0; i < output_size; i++) {
    bias[i] = read_f32(bias_chunk.data + i * 4);
  }
  self->storage[slot * 2] = bias;

  snprintf(name, sizeof name, "%s_weights_int8", base);
  Chunk weight_chunk;
  rc = find_chunk(model, model_bytes, name, &weight_chunk);
  if (rc == COMPANION_OK) {
    Chunk scale_chunk;
    Chunk subias_chunk;
    snprintf(name, sizeof name, "%s_scale", base);
    if (find_chunk(model, model_bytes, name, &scale_chunk) != COMPANION_OK) {
      return COMPANION_MISSING_TENSOR;
    }
    snprintf(name, sizeof name, "%s_subias", base);
    if (find_chunk(model, model_bytes, name, &subias_chunk) != COMPANION_OK) {
      return COMPANION_MISSING_TENSOR;
    }
    if ((int)(scale_chunk.bytes / 4) != output_size
        || (int)(subias_chunk.bytes / 4) != output_size) {
      return COMPANION_BAD_MODEL;
    }
    if (weight_chunk.bytes % (uint32_t)output_size != 0) {
      return COMPANION_BAD_MODEL;
    }
    const int input_size = (int)(weight_chunk.bytes / (uint32_t)output_size);
    float *weights = alloc_floats(input_size * output_size);
    if (weights == NULL) {
      return COMPANION_ALLOC_FAILED;
    }
    /* The client runs these layers as an integer GEMM, which is why the stored
     * numbers look too small to be weights. It quantises the input as
     * q_x = round(x * 127) + 127, accumulates q_x . q_w in integers, then
     * scales the accumulator by scale[o] and adds subias[o].
     *
     * Expanding that back into floats is what this loop does:
     *
     *   w[i][o] = 127 * scale[o] * q_w[i][o]
     *   b[o]    = bias[o] + 127 * scale[o] * sum_i q_w[i][o]
     *
     * The factor of 127 is the input quantisation, and leaving it out is what
     * made every int8 layer degenerate — weights came out at rms 0.0009 where
     * they should be around 0.105, so a constant term outweighed the signal
     * a hundred to one and the layers stopped responding to their input.
     *
     * The second term is the zero point. Every quantised input carries an
     * offset of 127, so the accumulator picks up 127 * sum_i q_w whatever the
     * input is, and expanding the GEMM into floats turns that into a constant
     * per output channel.
     *
     * Whether that second term belongs here is open, and the activations argue
     * it does not: with it, 15% of the GRU's outputs and 32% of ft2's sit at
     * +-1, where a trained network has almost none. Dropping it clears that
     * and blows the output level up by six orders of magnitude instead, so
     * each reading breaks the network somewhere different. Deciding needs the
     * client's input quantisation read from the binary. See
     * COMPANION-EVIDENCE.md.
     *
     * `subias` carries the bias with the zero point already taken out of it;
     * see the load below. An earlier note here called it unused and the wrong
     * magnitude for a trained bias by a factor of twenty, which is what it
     * looks like when read as a bias rather than as a correction.
     */
    /* The weights are laid out for the client's SIMD kernel, not row-major:
       blocks of 8 output channels, and within a block, 4 contiguous inputs per
       channel. Reading them row-major permutes the matrix, which keeps every
       weight's magnitude and destroys which input each one belongs to.

       Recovered from `subias` rather than guessed. The client compensates the
       input's zero point in the accumulator and cancels it with `subias`, so
       `subias[o] = -127 * scale[o] * sum_i q[i][o]` — a per-output-channel sum,
       which any layout that mixes channels gets wrong. Testing candidate
       layouts against it gives r = 0.997 to 0.9998 with slope 1.00 across all
       nine int8 layers for this one, and nothing else comes close. */
    const int SIMD_OUT_BLOCK = 8;
    const int SIMD_IN_GROUP = 4;
    const int blocked = output_size % SIMD_OUT_BLOCK == 0
      && input_size % SIMD_IN_GROUP == 0;
    const int in_blocks = blocked ? input_size / SIMD_IN_GROUP : 0;
    for (int o = 0; o < output_size; o++) {
      const float scale = read_f32(scale_chunk.data + o * 4) * 127.0f;
      const int ob = o / SIMD_OUT_BLOCK, p = o % SIMD_OUT_BLOCK;
      float zero_point = 0.0f;
      for (int i = 0; i < input_size; i++) {
        size_t source;
        if (blocked) {
          const int ib = i / SIMD_IN_GROUP, q = i % SIMD_IN_GROUP;
          source = (((size_t)ob * in_blocks + ib) * SIMD_OUT_BLOCK + p)
            * SIMD_IN_GROUP + q;
        } else {
          source = (size_t)i * output_size + o;
        }
        const float w = (float)(int8_t)weight_chunk.data[source] * scale;
        weights[(size_t)i * output_size + o] = w;
        zero_point += w;
      }
      /* `subias` is not the zero point negated, which is what this used to
         assume, and the difference doubled the bias of every int8 layer.

         Measured against the container across all 2224 output channels of the
         nine int8 layers, `zero_point + subias` reproduces the `_bias` chunk
         to a worst relative error of 4.5e-06, which is float precision. So
         `subias` is `bias - zero_point`: the stored bias with the zero point
         already taken out of it, for a runtime that adds the zero point back
         from the weights as this one does. Adding that to the bias as well
         gave `2 * bias`.

         The two chunks are the same number by two routes, so either is the
         answer and their agreement is the check. This takes the route through
         the weights, because it is the one that exercises the layout: get the
         blocking wrong and `zero_point` changes, and this stops matching. */
      const float subias = subias_chunk.data != NULL
        ? read_f32(subias_chunk.data + o * 4) : 0.0f;
      bias[o] = zero_point + subias;
    }
    self->storage[slot * 2 + 1] = weights;
    self->layers[slot].weights = weights;
    self->layers[slot].bias = bias;
    self->layers[slot].input_size = input_size;
    self->layers[slot].output_size = output_size;
    return COMPANION_OK;
  }

  snprintf(name, sizeof name, "%s_weights_float", base);
  rc = find_chunk(model, model_bytes, name, &weight_chunk);
  if (rc != COMPANION_OK) {
    return rc;
  }
  const int count = (int)(weight_chunk.bytes / 4);
  if (count % output_size != 0) {
    return COMPANION_BAD_MODEL;
  }
  float *weights = alloc_floats(count);
  if (weights == NULL) {
    return COMPANION_ALLOC_FAILED;
  }
  for (int i = 0; i < count; i++) {
    weights[i] = read_f32(weight_chunk.data + i * 4);
  }
  self->storage[slot * 2 + 1] = weights;
  self->layers[slot].weights = weights;
  self->layers[slot].bias = bias;
  self->layers[slot].input_size = count / output_size;
  self->layers[slot].output_size = output_size;
  return COMPANION_OK;
}

MlowCompanion *companion_create(const uint8_t *model, size_t model_bytes, int *error) {
  if (model == NULL || model_bytes < DNNW_HEADER_BYTES) {
    if (error) *error = COMPANION_BAD_ARG;
    return NULL;
  }
  MlowCompanion *self = (MlowCompanion *)calloc(1, sizeof(MlowCompanion));
  if (self == NULL) {
    if (error) *error = COMPANION_ALLOC_FAILED;
    return NULL;
  }

  for (int slot = 0; slot < L_COUNT; slot++) {
    const int rc = load_layer(self, model, model_bytes, slot);
    if (rc != COMPANION_OK) {
      companion_destroy(self);
      if (error) *error = rc;
      return NULL;
    }
  }

  companion_build_window(self->window, COMPANION_FRAME);

  /* Twiddle factors for the feature FFT. cos(2*pi*k*n/N) depends only on
     (k*n) mod N, so one turn of the circle serves every (k, n) pair — N entries
     rather than bins*N, which is 2.5 KB instead of 402 KB. */
  self->fft_cos = alloc_floats(COMPANION_FRAME);
  self->fft_sin = alloc_floats(COMPANION_FRAME);
  if (self->fft_cos == NULL || self->fft_sin == NULL) {
    companion_destroy(self);
    if (error) *error = COMPANION_ALLOC_FAILED;
    return NULL;
  }
  for (int i = 0; i < COMPANION_FRAME; i++) {
    const double angle = 2.0 * M_PI * (double)i / (double)COMPANION_FRAME;
    self->fft_cos[i] = (float)cos(angle);
    self->fft_sin[i] = (float)sin(angle);
  }

  if (error) *error = COMPANION_OK;
  return self;
}

void companion_destroy(MlowCompanion *self) {
  if (self == NULL) {
    return;
  }
  for (int i = 0; i < L_COUNT * 2; i++) {
    free(self->storage[i]);
  }
  free(self->fft_cos);
  free(self->fft_sin);
  free(self);
}

void companion_reset(MlowCompanion *self) {
  if (self == NULL) {
    return;
  }
  memset(self->hidden, 0, sizeof self->hidden);
  memset(self->previous_conv1, 0, sizeof self->previous_conv1);
  memset(&self->af1_state, 0, sizeof self->af1_state);
  memset(&self->af4_state, 0, sizeof self->af4_state);
  memset(self->excitation, 0, sizeof self->excitation);
  memset(self->af1_history, 0, sizeof self->af1_history);
  memset(self->af4_history, 0, sizeof self->af4_history);
  memset(&self->shape_state, 0, sizeof self->shape_state);
  memset(self->previous_ft, 0, sizeof self->previous_ft);
  memset(self->previous_shape_features, 0, sizeof self->previous_shape_features);

}

const float *companion_last_features(const MlowCompanion *self) {
  return self == NULL ? NULL : &self->features[0][0];
}


/* Builds one sub-frame's 165-wide vector: 93 extracted, 64 from the pitch
   table, 8 from the two bit-count embeddings.

   The clean spectrum and the cepstrum are refreshed on even sub-frames and
   reused on odd ones. That is not an optimisation: the codec carries one set
   of predictor coefficients per pair of sub-frames, so recomputing on the odd
   one would produce the same numbers from the same inputs. */
static void build_subframe_features(
  MlowCompanion *self,
  int sub,
  const CompanionFrameState *state
) {
  float *f = self->features[sub];
  const float *excitation =
    self->excitation + COMPANION_HISTORY + sub * COMPANION_SUBFRAME_SAMPLES;

  companion_clean_spectrum(
    f + COMPANION_CLEAN_SPEC_START, state->lpc[sub], state->lpc_order,
    self->fft_cos, self->fft_sin, self->feature_scratch);

  if ((sub & 1) == 0) {
    companion_cepstrum(
      f + COMPANION_NOISY_CEPSTRUM_START, excitation, self->window,
      self->fft_cos, self->fft_sin, self->feature_scratch);
  } else {
    memcpy(
      f + COMPANION_NOISY_CEPSTRUM_START,
      self->features[sub - 1] + COMPANION_NOISY_CEPSTRUM_START,
      COMPANION_NOISY_CEPSTRUM_LENGTH * sizeof(float));
  }

  /* One lag serves both the correlation and the table lookup, so an unvoiced
     sub-frame correlates at the same stand-in lag it is embedded with. */
  const int lag = companion_pitch_index(
    state->lag[sub][0], state->lag[sub][1], COMPANION_PITCH_LAGS);

  companion_acorr(f + COMPANION_ACORR_START, excitation, lag);

  /* These six describe the codec's own decisions for this sub-frame, and they
     are not the reference's layout. The published NoLACE puts five long-term
     predictor coefficients here and a natural log of the gain last; the client
     copies two values through unchanged, takes three base-10 logarithms of
     energies with an affine step each, and ends with an integer.

     The two copied through are the adaptive codebook gains. The codec reports
     them in a symmetric pattern, [0, g1, g0, g1, 0], so they are read out of
     that rather than taken in order. */
  f[COMPANION_LTP_START] = state->ltp[sub][2];
  f[COMPANION_LTP_START + 1] = state->ltp[sub][1];

  /* Three further quantities, each logged base ten and put through an affine
     step. One of each per sub-frame; see `decode_context` in companion.h for
     what they are.

     The client computes `(10 * log10(E) + offset) / divisor`, which reduces to
     the slopes and intercepts below to every digit — two independent reads of
     that code agreeing on four constants. There is **no scaling in front of
     the logarithm**: between the load of `E` and the call there is a widening
     conversion and nothing else.

     This used to apply `x * 0.5 + 32` there, carried over from the pitch
     table's index. Removing it moves the most heavily weighted feature in the
     model from a span of 0.35 to a span of 6.39 over a real decode, which is
     what a network giving its largest weight norm to an input requires, and
     halves that input's contribution.

     The third value carries a floor of `1e-5` inside the logarithm and the
     other two carry none, which is also read rather than chosen.

     The guard is that same `1e-5`, applied to all three. It exists because a
     zero would otherwise produce an infinity, which this library cannot emit
     whatever the client does with one, and a guard has to be *some* number.
     Borrowing the floor the client uses in this very computation is the least
     arbitrary choice available, and it keeps an unfilled struct producing
     features in range: at `1e-30` the first two slots come out at -26 and -21,
     which is worse than useless. It is a guard, not a claim about the client.

     Unrelated to the pitch table's index, which takes the mean of two lags
     with no offset; the two were described as the same thing here until the
     index was read from the client. */
  static const float slope[3] = {1.0f, 0.769f, 0.286f};
  static const float intercept[3] = {3.7f, 1.923f, 0.343f};
  static const float floor_term[3] = {0.0f, 0.0f, 1e-5f};
  for (int e = 0; e < 3; e++) {
    const float value = state->decode_context[sub][e] + floor_term[e];
    f[COMPANION_LTP_START + 2 + e] =
      log10f(value > 1e-5f ? value : 1e-5f) * slope[e] + intercept[e];
  }

  /* The last slot takes an integer from the decoder straight through. It is an
     index, not an energy, so unlike the three above it gets no logarithm and no
     scaling — applying one would be the same class of mistake as reading the
     reference's layout here in the first place. */
  f[COMPANION_LOG_GAIN_START] = state->side_index;

  const CompanionLayer *embedding = &self->layers[L_PITCH_EMBEDDING];
  memcpy(
    f + COMPANION_EXTRACTOR_FEATURES,
    embedding->weights + (size_t)lag * (size_t)embedding->output_size,
    COMPANION_PITCH_EMBED_DIM * sizeof(float));

  /* One embedding of the raw bit count, eight sines wide. The reference embeds
     a smoothed count alongside it and this build does not: the client holds a
     single scalar and one log, and its eight scales sit in two SIMD quads that
     read like two embeddings but multiply the same value. */
  companion_numbits_embedding(
    f + COMPANION_EXTRACTOR_FEATURES + COMPANION_PITCH_EMBED_DIM,
    state->num_bits, companion_numbits_scales,
    COMPANION_NUMBITS_EMBED_DIM, COMPANION_NUMBITS_LOW, COMPANION_NUMBITS_HIGH);
}

int companion_process(
  MlowCompanion *self,
  float *pcm,
  const CompanionFrameState *state
) {
  if (self == NULL || pcm == NULL || state == NULL) {
    return COMPANION_BAD_ARG;
  }
  if (state->lpc_order > COMPANION_LPC_ORDER || state->lpc_order <= 0) {
    return COMPANION_BAD_ARG;
  }

  /* The signal-derived features come from the decoder's excitation, not from
     `pcm`; `pcm` is only filtered. */
  memcpy(
    self->excitation + COMPANION_HISTORY, state->excitation,
    COMPANION_FRAME * sizeof(float));

  for (int sub = 0; sub < COMPANION_SUBFRAMES; sub++) {
    build_subframe_features(self, sub, state);
    companion_dense(
      &self->layers[L_CONV1], self->features[sub], self->conv1_out[sub],
      COMPANION_ACT_TANH);
    TRACE("features", self->features[sub], COMPANION_FEATURES);
    TRACE("conv1", self->conv1_out[sub], COMPANION_CONV1_OUT);
  }

  /* conv2 collapses the frame's four sub-frames, together with the previous
     frame's, into a single conditioning vector; tconv then expands it back out
     to one vector per sub-frame. */
  {
    float conv2_in[2 * COMPANION_SUBFRAMES * COMPANION_CONV1_OUT];
    const size_t half = COMPANION_SUBFRAMES * COMPANION_CONV1_OUT;
    memcpy(conv2_in, self->previous_conv1, half * sizeof(float));
    memcpy(conv2_in + half, self->conv1_out, half * sizeof(float));
    memcpy(self->previous_conv1, self->conv1_out, half * sizeof(float));
    if (companion_dense_checked(
          &self->layers[L_CONV2], conv2_in, (int)(2 * half), self->conv2_out,
          COMPANION_ACT_TANH) != 0) {
      return COMPANION_BAD_MODEL;
    }
  }

  TRACE("conv2", self->conv2_out, COMPANION_HIDDEN);
  companion_dense(
    &self->layers[L_TCONV], self->conv2_out, self->tconv_out, COMPANION_ACT_TANH);
  TRACE("tconv", self->tconv_out, COMPANION_HIDDEN * COMPANION_TCONV_UPSAMPLE);

  const int sub_features = COMPANION_HIDDEN;
  const int sub_samples = COMPANION_SUBFRAME_SAMPLES;

  for (int sub = 0; sub < COMPANION_SUBFRAMES; sub++) {
    const float *features = self->tconv_out + sub * sub_features;
    float *block = pcm + sub * sub_samples;

    /* The GRU steps once per sub-frame, so each one is filtered under state
       that has seen every sub-frame before it, not once per frame. */
    companion_gru_step(
      &self->layers[L_GRU_INPUT], &self->layers[L_GRU_RECURRENT],
      features, self->hidden, COMPANION_HIDDEN, self->gru_scratch);

    /* Two transforms run side by side over the same sequence -- the GRU's
       state, [previous sub-frame || current] -- and neither feeds the other.
       ft1's output conditions both adaptive filters; ft2's conditions the
       shaping.

       Read from the client's memory, with every operand taken from its own
       buffers: ft1 over the GRU's states reproduces the vector its adaptive
       filters read to correlation 0.99999, and ft2 over the same states
       reproduces its own output to 1.00000. Chained instead -- ft2 over ft1's
       output, which is what this build did -- ft2 correlates -0.13. Both
       transforms' older input is the GRU's last state of the previous frame,
       exactly. And their `tanh`, which used to be marked ASSUMED here, is in
       that same reproduction.

       This build used to condition the adaptive filters on the GRU's raw state
       and give the transforms only to the shaping. The conditioning it
       produced then correlated -0.06 with the client's, because it was being
       compared against the wrong vector entirely. */
    memcpy(self->ft_in, self->previous_ft, sub_features * sizeof(float));
    memcpy(self->ft_in + sub_features, self->hidden, sub_features * sizeof(float));
    if (companion_dense_checked(
          &self->layers[L_FT1], self->ft_in, sub_features * 2, self->ft1_out,
          COMPANION_ACT_TANH) != 0
        || companion_dense_checked(
          &self->layers[L_FT2], self->ft_in, sub_features * 2, self->ft2_out,
          COMPANION_ACT_TANH) != 0) {
      return COMPANION_BAD_MODEL;
    }

    /* af1 fans the signal out to two streams; the second is shaped while the
       first passes through; af4 then collapses both back to one. That is what
       the gain widths encode - two for af1, one for af4 - and it is why the
       shaping layer only ever sees a single channel. */
    if (companion_adaconv(
          &self->layers[L_AF1_KERNEL], &self->layers[L_AF1_GAIN],
          self->ft1_out, self->ft1_out, sub_features,
          block, self->af1_history, 1, self->streams,
          sub_samples, &self->af1_state, self->net_scratch) != 0) {
      return COMPANION_BAD_MODEL;
    }
    TRACE_ACT("gru hidden", self->hidden, COMPANION_HIDDEN);
    TRACE_ACT("ft1", self->ft1_out, COMPANION_HIDDEN);
    TRACE("input block", block, sub_samples);
    TRACE("af1 out ch0", self->streams, sub_samples);
    TRACE("af1 out ch1", self->streams + sub_samples, sub_samples);
    memcpy(self->af1_history, block, sub_samples * sizeof(float));

    TRACE_ACT("ft2", self->ft2_out, sub_features);

    if (companion_adashape(
          &self->layers[L_TDSHAPE_ALPHA1_F], &self->layers[L_TDSHAPE_ALPHA1_T],
          &self->layers[L_TDSHAPE_ALPHA2], self->ft2_out, sub_features,
          self->previous_shape_features, self->streams + sub_samples, sub_samples,
          &self->shape_state, self->net_scratch) != 0) {
      return COMPANION_BAD_MODEL;
    }
    TRACE("after adashape", self->streams + sub_samples, sub_samples);
    memcpy(self->previous_shape_features, self->ft2_out, sub_features * sizeof(float));

    /* af4 takes both branches as separate input channels and sums them itself.
       The kernel is out x in x taps = 1 x 2 x 16, which only admits that
       reading; pre-mixing them lowered measured gain but for the wrong reason.

       It reads the same conditioning as af1, bit for bit -- confirmed in the
       client's memory in steady state, 80 of 80 sub-frames. */
    if (companion_adaconv(
          &self->layers[L_AF4_KERNEL], &self->layers[L_AF4_GAIN],
          self->ft1_out, self->ft1_out, sub_features,
          self->streams, self->af4_history, 2, block,
          sub_samples, &self->af4_state, self->net_scratch) != 0) {
      return COMPANION_BAD_MODEL;
    }
    TRACE("af4 out (block)", block, sub_samples);
    memcpy(self->af4_history, self->streams, 2 * sub_samples * sizeof(float));
    memcpy(self->previous_ft, self->hidden, sub_features * sizeof(float));
  }

  /* Slide the history so the next frame can reach back into this one. */
  memmove(
    self->excitation, self->excitation + COMPANION_FRAME,
    COMPANION_HISTORY * sizeof(float));
  return COMPANION_OK;
}
