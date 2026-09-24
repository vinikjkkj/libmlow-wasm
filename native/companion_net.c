/* Neural primitives for the MLow Companion.
 *
 * Every matmul walks inputs in the outer loop, because weights are stored
 * [in][out]: that keeps the inner loop contiguous over outputs and lets the
 * compiler vectorise it.
 */
#include "companion_net.h"

#include <math.h>
#include <string.h>

#ifdef COMPANION_TRACE
#include <stdio.h>
static void net_trace(const char *name, const float *v, int n) {
  float peak = 0.0f;
  for (int i = 0; i < n; i++) {
    const float a = v[i] < 0.0f ? -v[i] : v[i];
    if (a > peak) peak = a;
  }
  fprintf(stderr, "      %-20s peak %.6g\n", name, peak);
}
#define NTRACE(n, v, c) net_trace(n, v, c)
#else
#define NTRACE(n, v, c) ((void)0)
#endif

void companion_activate(float *values, int count, CompanionActivation activation) {
  switch (activation) {
    case COMPANION_ACT_SIGMOID:
      for (int i = 0; i < count; i++) {
        values[i] = 1.0f / (1.0f + expf(-values[i]));
      }
      break;
    case COMPANION_ACT_TANH:
      for (int i = 0; i < count; i++) {
        values[i] = tanhf(values[i]);
      }
      break;
    case COMPANION_ACT_RELU:
      for (int i = 0; i < count; i++) {
        if (values[i] < 0.0f) {
          values[i] = 0.0f;
        }
      }
      break;
    case COMPANION_ACT_LINEAR:
    default:
      break;
  }
}

int companion_dense_checked(
  const CompanionLayer *layer,
  const float *input,
  int input_count,
  float *out,
  CompanionActivation activation
) {
  /* Wiring mistakes otherwise read past the caller's buffer and surface as NaN
     several layers downstream, where the cause is invisible. */
  if (layer->input_size != input_count) {
    return -1;
  }
  companion_dense(layer, input, out, activation);
  return 0;
}

void companion_dense(
  const CompanionLayer *layer,
  const float *input,
  float *out,
  CompanionActivation activation
) {
  const int in_size = layer->input_size;
  const int out_size = layer->output_size;
  memcpy(out, layer->bias, (size_t)out_size * sizeof(float));
  for (int i = 0; i < in_size; i++) {
    const float x = input[i];
    if (x == 0.0f) {
      continue;
    }
    const float *row = layer->weights + (size_t)i * (size_t)out_size;
    for (int o = 0; o < out_size; o++) {
      out[o] += x * row[o];
    }
  }
  companion_activate(out, out_size, activation);
}

void companion_gru_step(
  const CompanionLayer *input_layer,
  const CompanionLayer *recurrent_layer,
  const float *input,
  float *hidden,
  int hidden_size,
  float *scratch
) {
  float *gi = scratch;
  float *gh = scratch + 3 * hidden_size;

  companion_dense(input_layer, input, gi, COMPANION_ACT_LINEAR);
  companion_dense(recurrent_layer, hidden, gh, COMPANION_ACT_LINEAR);

  /* Block 0 update, block 1 reset, block 2 candidate. */
  const int r_off = hidden_size;
  const int n_off = 2 * hidden_size;
  for (int i = 0; i < hidden_size; i++) {
    const float z = 1.0f / (1.0f + expf(-(gi[i] + gh[i])));
    const float r = 1.0f / (1.0f + expf(-(gi[r_off + i] + gh[r_off + i])));
    /* Reset gates the recurrent projection, not the hidden state before it. */
    const float n = tanhf(gi[n_off + i] + r * gh[n_off + i]);
    hidden[i] = z * hidden[i] + (1.0f - z) * n;
  }
}

int companion_adaconv(
  const CompanionLayer *kernel_layer,
  const CompanionLayer *gain_layer,
  const float *kernel_features,
  const float *gain_features,
  int feature_count,
  const float *input,
  const float *history,
  int in_channels,
  float *out,
  int frame_size,
  CompanionConvState *state,
  float *scratch
) {
  const int channels = gain_layer->output_size;
  /* The kernel layer emits out_channels * in_channels * taps values, not a
     flat tap list: one filter per (input, output) pair, as a convolution with
     several channels on each side. Treating all 32 as taps of a single filter
     both lengthens the impulse response and counts every input twice. */
  const int coefficients = kernel_layer->output_size;
  if (kernel_layer->input_size != feature_count
      || gain_layer->input_size != feature_count
      || channels <= 0
      || in_channels <= 0
      || coefficients % (channels * in_channels) != 0) {
    return -1;
  }
  const int taps = coefficients / (channels * in_channels);
  if (taps <= 0 || taps > frame_size) {
    return -1;
  }

  if (coefficients > COMPANION_MAX_KERNEL_COEFFS) {
    return -1;
  }

  float *kernel = scratch;
  float *gains = scratch + coefficients;

  /* The kernel layer is read linearly. Its scale is set by the normalisation
     below, so squashing it beforehand would only bend its shape. */
  companion_dense(kernel_layer, kernel_features, kernel, COMPANION_ACT_LINEAR);
  companion_dense(gain_layer, gain_features, gains, COMPANION_ACT_TANH);

  /* Map tanh's [-1, 1] onto the permitted gain range before exponentiating:
     gain = exp(a * tanh(.)), with `a` set by the decibel limit. Unbounded, a
     filter whose gain can exceed unity compounds until the signal runs away. */
  for (int c = 0; c < channels; c++) {
    gains[c] = expf(COMPANION_GAIN_SPAN * gains[c] + COMPANION_GAIN_CENTRE);
  }

  /* L2-normalise per output channel, over that channel's inputs and taps
     together, not over the whole kernel, then fold the gain in. Each output
     filter thus has unit norm regardless of how many channels feed it, so its
     magnitude carries no level of its own. Normalising globally instead would
     scale a 2-output filter's branches down by root 2 each. */
  const int per_channel = in_channels * taps;
  for (int c = 0; c < channels; c++) {
    float *filter = kernel + (size_t)c * (size_t)per_channel;
    float energy = 0.0f;
    for (int t = 0; t < per_channel; t++) {
      energy += filter[t] * filter[t];
    }
    const float norm = gains[c] / (1e-6f + sqrtf(energy));
    for (int t = 0; t < per_channel; t++) {
      filter[t] *= norm;
    }
  }

  /* Nothing to fade from on the first sub-frame after a reset. */
  if (!state->primed) {
    memcpy(state->last_kernel, kernel, (size_t)coefficients * sizeof(float));
    state->primed = 1;
  }

  const int overlap = COMPANION_KERNEL_OVERLAP < frame_size
    ? COMPANION_KERNEL_OVERLAP : frame_size;

  for (int c = 0; c < channels; c++) {
    float *channel_out = out + (size_t)c * (size_t)frame_size;
    for (int i = 0; i < frame_size; i++) {
      float current = 0.0f;
      float previous = 0.0f;
      const int fading = i < overlap;
      for (int ic = 0; ic < in_channels; ic++) {
        const float *stream = input + (size_t)ic * (size_t)frame_size;
        const float *stream_history = history + (size_t)ic * (size_t)frame_size;
        const size_t offset = ((size_t)c * (size_t)in_channels + (size_t)ic) * (size_t)taps;
        const float *filter = kernel + offset;
        const float *stale = state->last_kernel + offset;
        for (int t = 0; t < taps; t++) {
          /* The kernel runs backwards in time: k[0] weights the oldest sample
             within the filter's reach and k[taps-1] the current one. Read from
             the client, and corroborated by the model itself, both kernels
             zero their tap 0, which under this order drops the oldest sample
             and leaves fifteen effective taps, and under the opposite order
             would leave a filter blind to its own input. Reversing a FIR
             preserves its magnitude response and changes only its phase, so no
             level measurement can catch this being wrong. */
          const int index = i - (taps - 1 - t) + COMPANION_FILTER_OFFSET;
          /* `history` holds each stream's samples preceding the frame; samples
             past its end are not available and read as silence. */
          float sample;
          if (index >= frame_size) {
            sample = 0.0f;
          } else if (index >= 0) {
            sample = stream[index];
          } else {
            sample = stream_history[frame_size + index];
          }
          current += filter[t] * sample;
          if (fading) {
            previous += stale[t] * sample;
          }
        }
      }
      if (fading) {
        /* Raised cosine: full weight on the outgoing kernel at the boundary,
           none by the end of the overlap. */
        const float w = 0.5f + 0.5f * cosf((float)M_PI * ((float)i + 0.5f) / (float)overlap);
        channel_out[i] = w * previous + (1.0f - w) * current;
      } else {
        channel_out[i] = current;
      }
    }
  }

  memcpy(state->last_kernel, kernel, (size_t)coefficients * sizeof(float));
  return 0;
}

int companion_adashape(
  const CompanionLayer *alpha1_f,
  const CompanionLayer *alpha1_t,
  const CompanionLayer *alpha2,
  const float *features,
  int feature_count,
  const float *previous_features,
  float *signal,
  int frame_size,
  CompanionShapeState *state,
  float *scratch
) {
  /* All three are 1-D convolutions of kernel 2 over the frame axis, so each
     reads the current step and the one before it. That is where the input
     widths come from: they are twice the channel count, not two branches
     concatenated:
       alpha1_f  2 x 160 features    -> shape
       alpha1_t  2 x  21 envelope    -> shape
       alpha2    2 x  shape          -> shape
     and the envelope width follows shape/pool + 1. */
  const int shape = alpha1_f->output_size;
  const int env_dim = alpha1_t->input_size / 2;
  const int pooled = env_dim - 1;

  if (alpha1_f->input_size != feature_count * 2
      || alpha1_t->output_size != shape
      || alpha1_t->input_size != env_dim * 2
      || alpha2->input_size != shape * 2
      || alpha2->output_size != shape
      || pooled <= 0
      || shape % pooled != 0
      || frame_size % shape != 0) {
    return -1;
  }
  const int pool = shape / pooled;

  float *window = scratch;                    /* kernel-2 input window */
  float *alpha = window + feature_count * 2;  /* [shape] */
  float *branch = alpha + shape;              /* [shape] */
  float *envelope = branch + shape;           /* [env_dim] */

  /* Envelope: average-pooled magnitude, logged, demeaned, and the mean goes
     in the twenty-first slot. That is the reference's `adashape_process_frame`
     (`tenv[tenv_size] = mean`), and it is what the client does: run on the
     client's own inputs, its signal, its conditioning, carried from one
     sub-frame to the next, this reproduces the client's shaped output to
     correlation 0.999999, worst error 6.9e-5, 54.5 dB SNR. With a zero in the
     slot, which this build had, it reads 0.846 and 5.9 dB; not demeaning at
     all reads 0.37.

     This build used to drop the mean altogether, on the grounds that carrying
     it made the filter's level move with the exponential of the input's. That
     was measured while the adaptive filters were conditioned on the wrong
     vector and the transforms chained, and it does not survive their fix: the
     scale-equivariance check in companion_test.c passes with the mean in
     place. See native/COMPANION-EVIDENCE.md. */
  float mean = 0.0f;
  for (int e = 0; e < pooled; e++) {
    float sum = 0.0f;
    const int start = e * pool;
    for (int k = 0; k < pool; k++) {
      sum += fabsf(signal[start + k]);
    }
    /* .5^16, the reference's floor. */
    envelope[e] = logf(sum / (float)pool + 1.52587890625e-5f);
    mean += envelope[e];
  }
  mean /= (float)pooled;
  for (int e = 0; e < pooled; e++) {
    envelope[e] -= mean;
  }
  envelope[pooled] = mean;

  /* Feature branch over [previous, current]. */
  memcpy(window, previous_features, (size_t)feature_count * sizeof(float));
  memcpy(window + feature_count, features, (size_t)feature_count * sizeof(float));
  companion_dense(alpha1_f, window, alpha, COMPANION_ACT_LINEAR);

  /* Envelope branch over the same two-step window. */
  memcpy(window, state->previous_envelope, (size_t)env_dim * sizeof(float));
  memcpy(window + env_dim, envelope, (size_t)env_dim * sizeof(float));
  companion_dense(alpha1_t, window, branch, COMPANION_ACT_LINEAR);
  memcpy(state->previous_envelope, envelope, (size_t)env_dim * sizeof(float));

#ifdef COMPANION_TRACE
  {
    /* Which branch is spiky decides where the runaway gain comes from: for a
       clean tone both should vary smoothly across the sub-frame. */
    float flo = alpha[0], fhi = alpha[0], tlo = branch[0], thi = branch[0];
    for (int i = 1; i < shape; i++) {
      if (alpha[i] < flo) flo = alpha[i];
      if (alpha[i] > fhi) fhi = alpha[i];
      if (branch[i] < tlo) tlo = branch[i];
      if (branch[i] > thi) thi = branch[i];
    }
    fprintf(stderr, "      alpha1_f [%8.3f,%8.3f] span %7.3f   alpha1_t [%8.3f,%8.3f] span %7.3f\n",
            flo, fhi, fhi - flo, tlo, thi, thi - tlo);
  }
#endif
  NTRACE("envelope", envelope, env_dim);
  /* The branches add, they do not concatenate. */
  for (int i = 0; i < shape; i++) {
    alpha[i] += branch[i];
    /* Leaky ReLU, slope 0.2. */
    if (alpha[i] < 0.0f) {
      alpha[i] *= 0.2f;
    }
  }

  memcpy(window, state->previous_alpha, (size_t)shape * sizeof(float));
  memcpy(window + shape, alpha, (size_t)shape * sizeof(float));
  memcpy(state->previous_alpha, alpha, (size_t)shape * sizeof(float));
  companion_dense(alpha2, window, branch, COMPANION_ACT_LINEAR);

  NTRACE("alpha2 (pre-exp)", branch, shape);
  for (int i = 0; i < shape; i++) {
    branch[i] = expf(branch[i]);
  }
#ifdef COMPANION_TRACE
  {
    /* The gain the shaping applies, sample by sample. A gain that swings
       across a sub-frame turns a clean tone into a spiky one whatever the
       signal was. */
    float lo = branch[0], hi = branch[0];
    for (int i = 1; i < shape; i++) {
      if (branch[i] < lo) lo = branch[i];
      if (branch[i] > hi) hi = branch[i];
    }
    fprintf(stderr, "      %-20s min %.4f  max %.4f  spread %.1fx\n",
            "shaping gain", lo, hi, lo > 0 ? hi / lo : 0.0);
  }
#endif

  /* One gain per sample within the shaping frame, repeated across the signal. */
  for (int i = 0; i < frame_size; i++) {
    signal[i] *= branch[i % shape];
  }
  return 0;
}
