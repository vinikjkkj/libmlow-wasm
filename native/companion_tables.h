/* Fixed tables the Companion's feature extractor uses.
 *
 * The band *centres* were recovered from the client binary and match the
 * published NoLACE tables bin for bin, which is what identifies this filterbank
 * rather than a lookalike.
 *
 * The *weights* were not measured - they are the published ones. Every interior
 * band equals `2 / (centre[i+1] - centre[i-1])`, but the two edge bands follow
 * a different convention, which is exactly where a difference from the client
 * would hide without showing up anywhere else. See COMPANION-EVIDENCE.md.
 *
 * Both banks are triangular and overlapping - each FFT bin feeds the two
 * adjacent bands with weights summing to one.
 */
#ifndef MLOW_COMPANION_TABLES_H
#define MLOW_COMPANION_TABLES_H

/* The clean bank runs on the LPC envelope, the noisy one on the signal. */
#define COMPANION_CLEAN_BANDS 64
#define COMPANION_NOISY_BANDS 18

/* Band centres as FFT-320 bin indices; the spectrum has 161 bins, so the last
   centre sits on the final bin. */
static const int companion_clean_centres[COMPANION_CLEAN_BANDS] = {
  0, 2, 5, 8, 10, 12, 15, 18,
  20, 22, 25, 28, 30, 33, 35, 38,
  40, 42, 45, 48, 50, 52, 55, 58,
  60, 62, 65, 68, 70, 73, 75, 78,
  80, 82, 85, 88, 90, 92, 95, 98,
  100, 102, 105, 108, 110, 112, 115, 118,
  120, 122, 125, 128, 130, 132, 135, 138,
  140, 142, 145, 148, 150, 152, 155, 160
};

static const float companion_clean_weights[COMPANION_CLEAN_BANDS] = {
  0.666666666667f, 0.400000000000f, 0.333333333333f, 0.400000000000f,
  0.500000000000f, 0.400000000000f, 0.333333333333f, 0.400000000000f,
  0.500000000000f, 0.400000000000f, 0.333333333333f, 0.400000000000f,
  0.400000000000f, 0.400000000000f, 0.400000000000f, 0.400000000000f,
  0.500000000000f, 0.400000000000f, 0.333333333333f, 0.400000000000f,
  0.500000000000f, 0.400000000000f, 0.333333333333f, 0.400000000000f,
  0.500000000000f, 0.400000000000f, 0.333333333333f, 0.400000000000f,
  0.400000000000f, 0.400000000000f, 0.400000000000f, 0.400000000000f,
  0.500000000000f, 0.400000000000f, 0.333333333333f, 0.400000000000f,
  0.500000000000f, 0.400000000000f, 0.333333333333f, 0.400000000000f,
  0.500000000000f, 0.400000000000f, 0.333333333333f, 0.400000000000f,
  0.500000000000f, 0.400000000000f, 0.333333333333f, 0.400000000000f,
  0.500000000000f, 0.400000000000f, 0.333333333333f, 0.400000000000f,
  0.500000000000f, 0.400000000000f, 0.333333333333f, 0.400000000000f,
  0.500000000000f, 0.400000000000f, 0.333333333333f, 0.400000000000f,
  0.500000000000f, 0.400000000000f, 0.250000000000f, 0.333333333333f
};

static const int companion_noisy_centres[COMPANION_NOISY_BANDS] = {
  0, 4, 8, 12, 16, 20, 24, 28,
  32, 40, 48, 56, 64, 80, 96, 112,
  136, 160
};

static const float companion_noisy_weights[COMPANION_NOISY_BANDS] = {
  0.400000000000f, 0.250000000000f, 0.250000000000f, 0.250000000000f,
  0.250000000000f, 0.250000000000f, 0.250000000000f, 0.250000000000f,
  0.166666666667f, 0.125000000000f, 0.125000000000f, 0.125000000000f,
  0.083333333333f, 0.062500000000f, 0.062500000000f, 0.050000000000f,
  0.041666666667f, 0.080000000000f
};

/* Constants measured from the client binary. Every one of these was checked
   against the published reference and three of the four differ, so none of
   them may be "corrected" back to a reference default without a new
   measurement.

   The bit-count embedding maps a bit count onto sines of differing rates. Its
   scale factors are a trained parameter in the reference, initialised to
   (i + 1) * pi / (log(high) - log(low)) and then learned, so the closed form
   describes only where they started. These are where they ended up. */
#define COMPANION_NUMBITS_LOW 10.0f    /* reference uses 50 */
#define COMPANION_NUMBITS_HIGH 650.0f

/* Two embeddings of four, one for the raw bit count and one for the smoothed
   one, each with its own scales: the client holds them at separate addresses,
   which a single reused module would not do. */
#define COMPANION_NUMBITS_EMBED_DIM 8
static const float companion_numbits_scales[COMPANION_NUMBITS_EMBED_DIM] = {
  0.915437f, 1.250892f, 2.286139f, 2.782086f,
  3.379605f, 4.267438f, 4.975252f, 5.613419f
};

/* Stand-in lag when the sub-frame is unvoiced; indexes the pitch table like
   any other lag. */
#define COMPANION_NO_PITCH_VALUE 7

#endif /* MLOW_COMPANION_TABLES_H */
