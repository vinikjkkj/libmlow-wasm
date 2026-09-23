/* Vetores de referencia para confrontar o binario do cliente.
 *
 * Em vez de ler o desassemblador, chamar a funcao. Este arquivo emite, em
 * texto, a ENTRADA exata e a MINHA saida em tres niveis, do mais isolado ao
 * mais completo. Quem conseguir chamar o binario roda os mesmos tres e a
 * comparacao e numerica, nao descritiva.
 *
 *   nivel 1  16 coeficientes LPC  ->  64 floats do espectro limpo
 *            (isola [0:64] inteiro; nao precisa de audio nenhum)
 *   nivel 2  320 amostras + estado -> 93 floats
 *            (acrescenta cepstrum, acorr e os slots do decoder)
 *   nivel 3  320 amostras + estado -> 320 amostras filtradas
 *            (a rede toda; so faz sentido se 1 e 2 baterem)
 */
#include "companion.h"
#include "companion_features.h"
#include "companion_tables.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define FRAME 320
#define SUBFRAMES 4
#define LPC_ORDER 16
#define LTP 5

static void *slurp(const char *path, size_t *size) {
  FILE *f = fopen(path, "rb");
  if (!f) { fprintf(stderr, "cannot open %s\n", path); exit(1); }
  fseek(f, 0, SEEK_END);
  long n = ftell(f);
  fseek(f, 0, SEEK_SET);
  void *d = malloc((size_t)n);
  if (!d || fread(d, 1, (size_t)n, f) != (size_t)n) exit(1);
  fclose(f);
  *size = (size_t)n;
  return d;
}

int main(int argc, char **argv) {
  size_t mb = 0;
  unsigned char *model = slurp(argc > 1 ? argv[1] : "m.pte", &mb);
  int err = 0;
  MlowCompanion *c = companion_create(model, mb, &err);
  if (!c) { fprintf(stderr, "create failed %d\n", err); return 1; }

  size_t nk, nl, ng, nt, np, nb, no;
  short *coded = slurp("coded.s16", &nk);
  float *lpc = slurp("features_lpc.f32", &nl);
  float *gain = slurp("features_gain.f32", &ng);
  float *ltp = slurp("features_ltp.f32", &nt);
  short *period = slurp("features_period.s16", &np);
  int *bits = slurp("packet_bits.s32", &nb);
  float *offset = slurp("features_offset.f32", &no);
  /* The decoder's excitation, three components per sample -- fcb, lpc_res -
     fcb, noise -- which the cepstrum and the pitch correlation read in place
     of the decoded audio. */
  size_t nx = 0;
  float *exc3 = slurp("exclpc_dec.f32", &nx);

  /* Quatro quadros espalhados por fala ativa, mais um de silencio. */
  const int PICK[5] = {60, 120, 180, 240, 30};

  printf("# Vetores de referencia do MLow Companion\n");
  printf("# Gerados por esta build. Rode o binario do cliente com as MESMAS\n");
  printf("# entradas e diferencie numero a numero.\n");
  printf("# Fala gravada, 16 kHz, MLow a ~15.3 kbps.\n\n");

  printf("## NIVEL 1 - espectro limpo: 16 coeficientes LPC -> 64 floats\n");
  printf("# A cadeia sob suspeita, isolada. Nao precisa de audio.\n");
  printf("# Entrada: o polinomio preditor como o dump do codec o escreve,\n");
  printf("#   que ja e -A[i+1]. A build monta poly[0]=1, poly[1+i]=lpc[i].\n");
  printf("# Saida: 0.3*ln(filterbank(1/(|A|^2 + 1e-9)) + 1e-9), 64 bandas.\n\n");

  for (int p = 0; p < 5; p++) {
    const int f = PICK[p];
    const size_t k = (size_t)f * SUBFRAMES;  /* sub-quadro 0 do quadro */
    const float *L = lpc + k * LPC_ORDER;
    printf("### caso %d  (quadro %d, sub-quadro 0)\n", p + 1, f);
    printf("lpc_in =");
    for (int i = 0; i < LPC_ORDER; i++) printf(" %.9g", L[i]);
    printf("\n");

    float out[COMPANION_CLEAN_BANDS];
    float scratch[4 * FRAME];
    float cs[FRAME], sn[FRAME];
    for (int i = 0; i < FRAME; i++) {
      cs[i] = (float)cos(2.0 * M_PI * (double)i / (double)FRAME);
      sn[i] = (float)sin(2.0 * M_PI * (double)i / (double)FRAME);
    }
    companion_clean_spectrum(out, L, LPC_ORDER, cs, sn, scratch);
    printf("spec_out =");
    for (int i = 0; i < COMPANION_CLEAN_BANDS; i++) printf(" %.6f", out[i]);
    printf("\n\n");
  }

  printf("## NIVEL 2 - as 93 features de um sub-quadro\n");
  printf("# Acrescenta cepstrum, autocorrelacao e os slots do decoder.\n");
  printf("# Precisa do sinal decodificado e do estado do decoder abaixo.\n\n");

  for (int p = 0; p < 2; p++) {
    const int f = PICK[p];
    printf("### caso %d  (quadro %d)\n", p + 1, f);
    printf("# 320 amostras int16 de coded.s16, a partir da amostra %d:\n", f * FRAME);
    printf("pcm_in =");
    for (int n = 0; n < FRAME; n++) printf(" %d", coded[(size_t)f * FRAME + n]);
    printf("\n");
    printf("num_bits = %d\n", bits[f]);
    for (int sub = 0; sub < SUBFRAMES; sub++) {
      const size_t k = (size_t)f * SUBFRAMES + sub;
      printf("sub%d_lpc =", sub);
      for (int i = 0; i < LPC_ORDER; i++) printf(" %.9g", lpc[k * LPC_ORDER + i]);
      printf("\nsub%d_lag = %d\n", sub, (int)period[k]);
      printf("sub%d_ltp =", sub);
      for (int i = 0; i < LTP; i++) printf(" %.9g", ltp[k * LTP + i]);
      printf("\nsub%d_gain = %.9g\n", sub, gain[k]);
      printf("sub%d_gain_tab = %.9g   sub%d_nrgres = %.9g\n",
             sub, offset[k * 2], sub, offset[k * 2 + 1]);
    }
    printf("\n");
  }

  printf("## NIVEL 3 - a saida do filtro\n");
  printf("# So compare este se 1 e 2 baterem. A entrada e a do NIVEL 2.\n\n");
  for (int p = 0; p < 2; p++) {
    const int f = PICK[p];
    CompanionFrameState st;
    memset(&st, 0, sizeof st);
    st.lpc_order = LPC_ORDER;
    for (int h = 0; h < SUBFRAMES; h++)
      memcpy(st.lpc[h], lpc + ((size_t)f * SUBFRAMES + (size_t)h) * LPC_ORDER,
             LPC_ORDER * sizeof(float));
    for (int sub = 0; sub < SUBFRAMES; sub++) {
      const size_t k = (size_t)f * SUBFRAMES + sub;
      const float lg = (float)period[k];
      st.lag[sub][0] = lg;
      st.lag[sub][1] = lg;
      memcpy(st.ltp[sub], ltp + k * LTP, LTP * sizeof(float));
      st.gain[sub] = gain[k];
      st.decode_context[sub][0] = offset[k * 2];
      st.decode_context[sub][1] = 1e-5f;
      st.decode_context[sub][2] = offset[k * 2 + 1];
    }
    st.num_bits = (float)bits[f];
    for (int n = 0; n < FRAME; n++) {
      const size_t q = ((size_t)f * FRAME + (size_t)n) * 3;
      st.excitation[n] = exc3[q] + exc3[q + 1] + exc3[q + 2];
    }

    float pcm[FRAME];
    for (int n = 0; n < FRAME; n++) pcm[n] = (float)coded[(size_t)f * FRAME + n] / 32768.0f;
    companion_process(c, pcm, &st);
    printf("### caso %d  (quadro %d, estado da rede zerado antes)\n", p + 1, f);
    printf("pcm_out =");
    for (int n = 0; n < FRAME; n++) printf(" %.6f", pcm[n]);
    printf("\n\n");
  }
  return 0;
}
