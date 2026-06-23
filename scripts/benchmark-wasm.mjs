import { performance } from "node:perf_hooks";
import { Application, createDecoder, createEncoder, loadLibopus } from "../dist/index.js";

const sampleRate = 48_000;
const channels = 2;
const frameSize = 960;
const warmupIterations = Number(process.env.LIBMLOW_WASM_BENCH_WARMUP ?? 1_000);
const iterations = Number(process.env.LIBMLOW_WASM_BENCH_ITERATIONS ?? 20_000);
const pcm = createToneFrame();

const encoder = await createEncoder({
  application: Application.Audio,
  bitrate: 64_000,
  channels,
  sampleRate,
});
const decoder = await createDecoder({ channels, sampleRate });

try {
  const packet = encoder.encode(pcm, { frameSize });
  const libopus = await loadLibopus();

  const results = [
    bench("wasm encode", warmupIterations, iterations, () => {
      encoder.encode(pcm, { frameSize });
    }),
    bench("wasm decode", warmupIterations, iterations, () => {
      decoder.decode(packet, { maxFrameSize: frameSize });
    }),
  ];

  console.log(
    JSON.stringify(
      {
        channels,
        codec: libopus.version,
        frameSize,
        iterations,
        packetBytes: packet.byteLength,
        results,
        sampleRate,
        warmupIterations,
      },
      null,
      2,
    ),
  );
} finally {
  decoder.free();
  encoder.free();
}

function bench(name, warmup, count, fn) {
  for (let index = 0; index < warmup; index += 1) {
    fn();
  }
  const start = performance.now();
  for (let index = 0; index < count; index += 1) {
    fn();
  }
  const durationMs = performance.now() - start;
  return {
    durationMs: Math.round(durationMs * 100) / 100,
    name,
    opsPerSecond: Math.round((count / durationMs) * 1000),
  };
}

function createToneFrame() {
  const frame = new Int16Array(frameSize * channels);
  for (let sample = 0; sample < frameSize; sample += 1) {
    const value = Math.round(Math.sin((sample / frameSize) * Math.PI * 2) * 8000);
    frame[sample * channels] = value;
    frame[sample * channels + 1] = value;
  }
  return frame;
}
