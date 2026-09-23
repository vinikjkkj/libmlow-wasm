/* Neural primitives for the MLow Companion (NoLACE). */
#ifndef MLOW_COMPANION_NET_H
#define MLOW_COMPANION_NET_H

/* Adaptive-filter gains are bounded: the network emits tanh in [-1, 1], scaled
   before the exponential so a stage can attenuate or boost but never run away
   across frames. The constant is read from the client binary and works out to
   exactly 12 dB (12 * ln(10)/20), giving gains in [0.251, 3.981]. The published
   reference uses 6 dB; this build does not. */
/* Where the filter's centre tap sits. 0 is fully causal; the client's value is
   not yet known, and measurement found the level insensitive to it (3.87x at 0,
   4.35x at 15), so it stays causal until the binary says otherwise. */
#ifndef COMPANION_FILTER_OFFSET
#define COMPANION_FILTER_OFFSET 0
#endif

#ifndef COMPANION_GAIN_SPAN
#define COMPANION_GAIN_SPAN 1.3815510273f
#endif

/* The gain is exp(SPAN * tanh(.) + CENTRE), so CENTRE is where the range sits
   and SPAN is how wide it is. Together they are the decibel limits: the
   reference takes a symmetric pair, which is a centre of zero, and 12 dB of
   span puts the gain in [0.2512, 3.9811].

   ASSUMED, and unlike the span it has never been read from the client. The
   span was; the centre was taken from the reference's symmetry and has sat
   here undocumented. An asymmetric pair of limits would put it off zero, and
   `af4`'s gain spending two thirds of its sub-frames against the floor -- 80%
   on a stationary tone -- is what a wrong centre would look like. It is also
   what weights three times too large look like, which is the other candidate,
   so this is a place to measure rather than to pick.

   Guarded so a build can sweep it. Note that both stages share it, and `af1`
   is healthy at a median gain of 1.42, so a single global centre that fixes
   `af4` would break `af1`: if the centre is the answer it is per-stage. */
#ifndef COMPANION_GAIN_CENTRE
#define COMPANION_GAIN_CENTRE 0.0f
#endif

/* A weight matrix laid out [in][out], the order the container stores. */
typedef struct {
  const float *weights;
  const float *bias;
  int input_size;
  int output_size;
} CompanionLayer;

typedef enum {
  COMPANION_ACT_LINEAR = 0,
  COMPANION_ACT_SIGMOID = 1,
  COMPANION_ACT_TANH = 2,
  COMPANION_ACT_RELU = 3
} CompanionActivation;

void companion_activate(float *values, int count, CompanionActivation activation);

/* out = activation(input . W + b) */
void companion_dense(
  const CompanionLayer *layer,
  const float *input,
  float *out,
  CompanionActivation activation
);

/* One GRU step, CuDNN-style: gate block order [z, r, n], the reset gate applied
   to the recurrent projection of the candidate, and h = z*h_prev + (1-z)*n.
   Input and recurrent halves carry separate biases.

   `scratch` needs 6 * hidden floats. */
void companion_gru_step(
  const CompanionLayer *input_layer,
  const CompanionLayer *recurrent_layer,
  const float *input,
  float *hidden,
  int hidden_size,
  float *scratch
);

/* Dense layer that rejects a dimension mismatch instead of reading past the
   caller's buffer. Returns -1 when `input_count` is not the layer's input size. */
int companion_dense_checked(
  const CompanionLayer *layer,
  const float *input,
  int input_count,
  float *out,
  CompanionActivation activation
);

/* Samples over which a new kernel is faded in. The filter is re-predicted every
   sub-frame, so switching to it abruptly would step the signal at each
   boundary; the two kernels are run in parallel across this many samples and
   mixed under a raised cosine.

   Guarded so a build can override it, which it could not before: the define
   was unconditional, so `-DCOMPANION_KERNEL_OVERLAP=n` was silently ignored
   and a sweep of four values ran the same value four times. That it produced
   four identical results is what caught it. */
#ifndef COMPANION_KERNEL_OVERLAP
#define COMPANION_KERNEL_OVERLAP 15
#endif

/* The largest kernel any stage predicts: 2 channels x 1 input x 16 taps, and
   1 x 2 x 16 for the collapsing stage. */
#define COMPANION_MAX_KERNEL_COEFFS 64

/* The previous sub-frame's kernel, which the next one fades in from. */
typedef struct {
  float last_kernel[COMPANION_MAX_KERNEL_COEFFS];
  /* Cleared on reset; the first sub-frame has nothing to fade from. */
  int primed;
} CompanionConvState;

/* Adaptive convolution: the network predicts both an FIR kernel and its gains,
   which then filter the signal. The kernel is L2-normalised per output channel
   and its gain is folded into it as exp(alpha * tanh(.)) — folded rather than
   applied to the output, because the fade above mixes whole kernels and each
   must already carry the gain it was predicted with.

   The kernel and the gain are predicted from separate control vectors; pass the
   same pointer twice when one drives both.

   Tap and channel counts come from the layers. `in_channels` streams are summed
   before filtering and `channels` are emitted — which is how one stage fans out
   to two and a later one collapses them back. Streams are laid out
   consecutively, `frame_size` apart.

   Returns -1 if the layers do not fit the call. Needs taps + channels scratch. */
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
);

/* Kernel-2 history the shaping convolutions read. Cleared on reset. */
typedef struct {
  float previous_envelope[64];
  float previous_alpha[128];
} CompanionShapeState;

/* Adaptive time-domain shaping.
 *
 * Two branches — one over the features, one over a log envelope of the signal —
 * are concatenated and mixed into per-band gains, which then scale the signal.
 * The layer dimensions fix that wiring: alpha2 takes twice what each branch
 * emits. Returns -1 if they do not line up.

   Needs shape_size * 3 + envelope_size scratch floats. */
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
);

#endif /* MLOW_COMPANION_NET_H */
