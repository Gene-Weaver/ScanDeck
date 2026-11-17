// ovseg — run ScanDeck's OpenVINO YOLO leaf segmenter on prepared leaf crops and write one mask per crop.
//
// Build:  clang -O2 -o ovseg ovseg.c -I$(brew --prefix openvino)/include \
//           -L$(brew --prefix openvino)/lib -lopenvino_c -Wl,-rpath,$(brew --prefix openvino)/lib
// Usage:  ./ovseg <model.xml> <min score> <crop.rgb> <mask.gray> [<crop.rgb> <mask.gray> …]
//   crop.rgb   1024 × 1024 × 3 bytes, RGB, already letterboxed (src/main/segment.js prepares it)
//   mask.gray  written: 1024 × 1024 bytes, 255 = keep, 0 = black out
//   model.xml  OpenVINO IR of an end-to-end (NMS-free) YOLO26-seg model, classes 0 Leaf, 1 Petiole, 2 Hole:
//              input [1,3,1024,1024] f32; outputs [1,N,6+K] = x1, y1, x2, y2, score, class, K mask
//              coefficients (input pixels) and [1,K,256,256] mask prototypes
// The mask keeps every Leaf and Petiole instance scoring at least <min score>, minus every Hole instance.
// With OVSEG_NO_PETIOLE set in the environment, Petiole instances are listed but not kept (leaf blade only).
// An instance's mask is its coefficients · prototypes, upsampled bilinearly to 1024 and cut at 0 (= 0.5
// after the sigmoid) inside its box, like Ultralytics' retina masks.
// Prints one JSON object: {"loadMs":…,"crops":[{"inferMs":…,"kept":<pixels>,"instances":[[class,score,x1,y1,x2,y2],…]},…]}

#include <openvino/c/openvino.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define SIZE 1024
#define HOLE 2

static void die(const char *what, ov_status_e st) {
  fprintf(stderr, "ovseg: %s failed: %s\n", what, ov_get_error_info(st));
  exit(1);
}
#define OV(call, what) do { ov_status_e st_ = (call); if (st_ != OK) die(what, st_); } while (0)

static double now_ms(void) {
  struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t);
  return t.tv_sec * 1000.0 + t.tv_nsec / 1e6;
}
static int clampi(int v, int lo, int hi) { return v < lo ? lo : v > hi ? hi : v; }

int main(int argc, char **argv) {
  if (argc < 5 || (argc - 3) % 2) { fprintf(stderr, "usage: ovseg <model.xml> <min score> <crop.rgb> <mask.gray> [...]\n"); return 2; }
  const float minScore = (float)atof(argv[2]);
  const int noPetiole = getenv("OVSEG_NO_PETIOLE") != NULL;

  static unsigned char rgb[SIZE * SIZE * 3];
  static float input[3 * SIZE * SIZE];
  static unsigned char keep[SIZE * SIZE], hole[SIZE * SIZE];

  double t0 = now_ms();
  ov_core_t *core = NULL;
  ov_model_t *model = NULL;
  ov_compiled_model_t *compiled = NULL;
  ov_infer_request_t *req = NULL;
  OV(ov_core_create(&core), "core");
  OV(ov_core_read_model(core, argv[1], NULL, &model), "read model");
  OV(ov_core_compile_model(core, model, "CPU", 0, &compiled), "compile model");
  OV(ov_compiled_model_create_infer_request(compiled, &req), "infer request");
  int64_t dims[4] = {1, 3, SIZE, SIZE};
  ov_shape_t shape;
  OV(ov_shape_create(4, dims, &shape), "shape");
  ov_tensor_t *tensor = NULL;
  OV(ov_tensor_create_from_host_ptr(F32, shape, input, &tensor), "input tensor");
  printf("{\"loadMs\":%.1f,\"crops\":[", now_ms() - t0);

  float *logit = NULL;
  for (int a = 3; a < argc; a += 2) {
    FILE *f = fopen(argv[a], "rb");
    if (!f) { perror(argv[a]); return 1; }
    if (fread(rgb, 1, sizeof rgb, f) != sizeof rgb) { fprintf(stderr, "ovseg: %s is not 1024x1024 RGB\n", argv[a]); return 1; }
    fclose(f);
    for (int i = 0; i < SIZE * SIZE; i++)
      for (int c = 0; c < 3; c++) input[c * SIZE * SIZE + i] = rgb[i * 3 + c] / 255.0f;

    double t1 = now_ms();
    OV(ov_infer_request_set_input_tensor_by_index(req, 0, tensor), "set input");
    OV(ov_infer_request_infer(req), "infer");
    double t2 = now_ms();

    // the two outputs, told apart by rank: detections [1,N,6+K] and prototypes [1,K,ph,pw]
    ov_tensor_t *o[2] = {NULL, NULL}, *detT = NULL, *protoT = NULL;
    ov_shape_t ds = {0}, ps = {0};
    for (int i = 0; i < 2; i++) {
      OV(ov_infer_request_get_output_tensor_by_index(req, i, &o[i]), "output");
      ov_shape_t s;
      OV(ov_tensor_get_shape(o[i], &s), "output shape");
      if (s.rank == 3 && !detT) { detT = o[i]; ds = s; }
      else if (s.rank == 4 && !protoT) { protoT = o[i]; ps = s; }
      else ov_shape_free(&s);
    }
    if (!detT || !protoT || ds.dims[2] - 6 != ps.dims[1]) { fprintf(stderr, "ovseg: %s: expected outputs [1,N,6+K] and [1,K,h,w]\n", argv[1]); return 1; }
    const int n = (int)ds.dims[1], stride = (int)ds.dims[2], K = (int)ps.dims[1], ph = (int)ps.dims[2], pw = (int)ps.dims[3];
    float *det = NULL, *proto = NULL;
    OV(ov_tensor_data(detT, (void **)&det), "detections");
    OV(ov_tensor_data(protoT, (void **)&proto), "prototypes");
    if (!logit) logit = malloc(sizeof(float) * ph * pw);

    memset(keep, 0, sizeof keep);
    memset(hole, 0, sizeof hole);
    printf("%s{\"inferMs\":%.1f,\"instances\":[", a > 3 ? "," : "", t2 - t1);
    int shown = 0;
    const float sx = (float)pw / SIZE, sy = (float)ph / SIZE;
    for (int i = 0; i < n; i++) {
      const float *r = det + (size_t)i * stride;
      if (r[4] < minScore) continue;
      const int cls = (int)r[5];
      const int x1 = clampi((int)floorf(r[0]), 0, SIZE), y1 = clampi((int)floorf(r[1]), 0, SIZE);
      const int x2 = clampi((int)ceilf(r[2]), 0, SIZE), y2 = clampi((int)ceilf(r[3]), 0, SIZE);
      printf("%s[%d,%.4f,%d,%d,%d,%d]", shown++ ? "," : "", cls, r[4], x1, y1, x2, y2);
      if (x2 <= x1 || y2 <= y1) continue;
      if (noPetiole && cls == 1) continue;
      // coefficients · prototypes, only over the prototype cells the box touches
      const int px1 = clampi((int)floorf(x1 * sx) - 1, 0, pw - 1), px2 = clampi((int)ceilf(x2 * sx) + 1, 0, pw - 1);
      const int py1 = clampi((int)floorf(y1 * sy) - 1, 0, ph - 1), py2 = clampi((int)ceilf(y2 * sy) + 1, 0, ph - 1);
      for (int y = py1; y <= py2; y++)
        for (int x = px1; x <= px2; x++) {
          float v = 0;
          for (int k = 0; k < K; k++) v += r[6 + k] * proto[((size_t)k * ph + y) * pw + x];
          logit[y * pw + x] = v;
        }
      unsigned char *dst = cls == HOLE ? hole : keep;
      for (int y = y1; y < y2; y++) {
        const float fy = (y + 0.5f) * sy - 0.5f;
        const int ya = clampi((int)floorf(fy), py1, py2), yb = clampi(ya + 1, py1, py2);
        const float wy = fy - floorf(fy);
        for (int x = x1; x < x2; x++) {
          const float fx = (x + 0.5f) * sx - 0.5f;
          const int xa = clampi((int)floorf(fx), px1, px2), xb = clampi(xa + 1, px1, px2);
          const float wx = fx - floorf(fx);
          const float v = (1 - wy) * ((1 - wx) * logit[ya * pw + xa] + wx * logit[ya * pw + xb])
                        + wy * ((1 - wx) * logit[yb * pw + xa] + wx * logit[yb * pw + xb]);
          if (v > 0) dst[y * SIZE + x] = 255;
        }
      }
    }
    long kept = 0;
    for (int i = 0; i < SIZE * SIZE; i++) { if (hole[i]) keep[i] = 0; kept += keep[i] != 0; }
    printf("],\"kept\":%ld}", kept);

    FILE *g = fopen(argv[a + 1], "wb");
    if (!g) { perror(argv[a + 1]); return 1; }
    if (fwrite(keep, 1, sizeof keep, g) != sizeof keep) { fprintf(stderr, "ovseg: could not write %s\n", argv[a + 1]); return 1; }
    fclose(g);
    ov_shape_free(&ds); ov_shape_free(&ps);
    ov_tensor_free(o[0]); ov_tensor_free(o[1]);
  }
  printf("]}\n");
  free(logit);
  ov_tensor_free(tensor);
  ov_shape_free(&shape);
  ov_infer_request_free(req);
  ov_compiled_model_free(compiled);
  ov_model_free(model);
  ov_core_free(core);
  return 0;
}
