/* Checks the frame-count byte handling.
 *
 * The four forms below came from buffers scanned out of a running client. Two
 * of them were refused before the fix, because only bit 6 was being cleared.
 * Whether those buffers were finished packets is in doubt, so they stand as
 * cases worth handling rather than as proof of what the wire carries — the
 * masking is justified by the count never exceeding 18, independently of them.
 */
#include <stdio.h>
#include <string.h>
#include <opus.h>

int oc_mlow_strip_padding_flag(unsigned char *data, opus_int32 len);

static int failures = 0;

static void check(const char *name, unsigned char byte1, int expect_count, int expect_changed) {
  /* Marker values seen on the wire: below 0xC0, with bits 1 and 7 set. */
  unsigned char packet[8] = {0xbb, 0x00, 40, 40, 0, 0, 0, 0};
  packet[1] = byte1;

  const int changed = oc_mlow_strip_padding_flag(packet, (opus_int32)sizeof packet);
  const int count = packet[1];
  const int ok = count == expect_count && changed == expect_changed;
  printf("  %-34s 0x%02x -> count %3d (changed %d)  %s\n",
         name, byte1, count, changed, ok ? "ok" : "FAIL");
  if (!ok) {
    printf("       expected count %d, changed %d\n", expect_count, expect_changed);
    failures++;
  }
}

int main(void) {
  printf("frame-count byte, forms captured from live calls:\n");
  check("no flags, three frames",       0x03, 3, 0);
  check("bit 6, six frames",            0x46, 6, 1);
  check("bit 7, six frames",            0x86, 6, 1);
  check("bits 6 and 7, three frames",   0xc3, 3, 1);

  printf("\nforms not seen live, but implied by the mask:\n");
  check("no flags, eighteen frames",    0x12, 18, 0);
  check("both flags, eighteen frames",  0xd2, 18, 1);

  printf("\nnon-multiframe packets are left alone:\n");
  {
    /* A CELT-range marker must not be touched whatever byte 1 holds. */
    unsigned char packet[4] = {0xc8, 0xc3, 0, 0};
    const int changed = oc_mlow_strip_padding_flag(packet, 4);
    const int ok = changed == 0 && packet[1] == 0xc3;
    printf("  %-34s -> changed %d, byte1 0x%02x  %s\n",
           "CELT-range marker", changed, packet[1], ok ? "ok" : "FAIL");
    if (!ok) failures++;
  }
  {
    /* A marker without both marker bits is not a multiframe packet. */
    unsigned char packet[4] = {0x80, 0xc3, 0, 0};
    const int changed = oc_mlow_strip_padding_flag(packet, 4);
    const int ok = changed == 0 && packet[1] == 0xc3;
    printf("  %-34s -> changed %d, byte1 0x%02x  %s\n",
           "marker missing the SID bit", changed, packet[1], ok ? "ok" : "FAIL");
    if (!ok) failures++;
  }
  {
    unsigned char packet[1] = {0xbb};
    const int changed = oc_mlow_strip_padding_flag(packet, 1);
    printf("  %-34s -> changed %d  %s\n",
           "one-byte packet", changed, changed == 0 ? "ok" : "FAIL");
    if (changed != 0) failures++;
  }

  printf("\n%s (%d failure%s)\n", failures ? "FAILED" : "all passed",
         failures, failures == 1 ? "" : "s");
  return failures != 0;
}
