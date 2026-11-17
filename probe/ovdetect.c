// ovdetect — run ScanDeck's OpenVINO YOLO detectors on one prepared image.
//
// Build:  clang -O2 -o ovdetect ovdetect.c -I$(brew --prefix openvino)/include \
//           -L$(brew --prefix openvino)/lib -lopenvino_c -Wl,-rpath,$(brew --prefix openvino)/lib
// Usage:  ./ovdetect <image.rgb> <model.xml> [model.xml …]
//   image.rgb  640 × 640 × 3 bytes, RGB, already letterboxed (src/main/detect.js prepares it)
//   model.xml  OpenVINO IR of an end-to-end (NMS-free) YOLO26 detector: input [1,3,640,640] f32,
//              output [1,N,6] = x1, y1, x2, y2, score, class in input pixels
// Prints one JSON object: {"models":[{"model":"…","ms":12.3,"dets":[[x1,y1,x2,y2,score,class],…]}, …]}
// Boxes scoring below 0.01 are dropped; the caller applies the real threshold.
//
// Needs only Homebrew's openvino (C API + the ARM CPU plugin).

#include <openvino/c/openvino.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define SIZE 640
#define MIN_SCORE 0.01f

static void die(const char *what, ov_status_e st) {
  fprintf(stderr, "ovdetect: %s failed: %s\n", what, ov_get_error_info(st));
  exit(1);
}
#define OV(call, what) do { ov_status_e st_ = (call); if (st_ != OK) die(what, st_); } while (0)

static double now_ms(void) {
  struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t);
  return t.tv_sec * 1000.0 + t.tv_nsec / 1e6;
}

int main(int argc, char **argv) {
  if (argc < 3) { fprintf(stderr, "usage: ovdetect <image.rgb> <model.xml> [model.xml …]\n"); return 2; }

  // HWC uint8 RGB → CHW float in [0, 1]
  FILE *f = fopen(argv[1], "rb");
  if (!f) { perror(argv[1]); return 1; }
  static unsigned char rgb[SIZE * SIZE * 3];
  if (fread(rgb, 1, sizeof rgb, f) != sizeof rgb) { fprintf(stderr, "ovdetect: %s is not 640x640 RGB\n", argv[1]); return 1; }
  fclose(f);
  static float input[3 * SIZE * SIZE];
  for (int i = 0; i < SIZE * SIZE; i++)
    for (int c = 0; c < 3; c++) input[c * SIZE * SIZE + i] = rgb[i * 3 + c] / 255.0f;

  ov_core_t *core = NULL;
  OV(ov_core_create(&core), "core");
  int64_t dims[4] = {1, 3, SIZE, SIZE};
  ov_shape_t shape;
  OV(ov_shape_create(4, dims, &shape), "shape");
  ov_tensor_t *tensor = NULL;
  OV(ov_tensor_create_from_host_ptr(F32, shape, input, &tensor), "input tensor");

  printf("{\"models\":[");
  for (int m = 2; m < argc; m++) {
    double t0 = now_ms();
    ov_model_t *model = NULL;
    ov_compiled_model_t *compiled = NULL;
    ov_infer_request_t *req = NULL;
    OV(ov_core_read_model(core, argv[m], NULL, &model), "read model");
    OV(ov_core_compile_model(core, model, "CPU", 0, &compiled), "compile model");
    OV(ov_compiled_model_create_infer_request(compiled, &req), "infer request");
    double t1 = now_ms();
    OV(ov_infer_request_set_input_tensor_by_index(req, 0, tensor), "set input");
    OV(ov_infer_request_infer(req), "infer");
    double t2 = now_ms();

    ov_tensor_t *out = NULL;
    OV(ov_infer_request_get_output_tensor_by_index(req, 0, &out), "output");
    ov_shape_t os;
    OV(ov_tensor_get_shape(out, &os), "output shape");
    if (os.rank != 3 || os.dims[2] != 6) { fprintf(stderr, "ovdetect: %s: expected output [1,N,6]\n", argv[m]); return 1; }
    float *d = NULL;
    OV(ov_tensor_data(out, (void **)&d), "output data");

    printf("%s{\"model\":\"%s\",\"loadMs\":%.1f,\"inferMs\":%.1f,\"dets\":[", m > 2 ? "," : "", argv[m], t1 - t0, t2 - t1);
    int n = 0;
    for (int64_t i = 0; i < os.dims[1]; i++) {
      const float *r = d + i * 6;
      if (r[4] < MIN_SCORE) continue;
      printf("%s[%.2f,%.2f,%.2f,%.2f,%.4f,%d]", n++ ? "," : "", r[0], r[1], r[2], r[3], r[4], (int)r[5]);
    }
    printf("]}");
    ov_shape_free(&os);
    ov_tensor_free(out);
    ov_infer_request_free(req);
    ov_compiled_model_free(compiled);
    ov_model_free(model);
  }
  printf("]}\n");
  ov_tensor_free(tensor);
  ov_shape_free(&shape);
  ov_core_free(core);
  return 0;
}
