# Benchmark

A WASM codec is only useful if it keeps up with realtime. The repo ships a
WASM-only throughput benchmark for encode and decode on fixed 48 kHz stereo
20 ms frames.

## Run it

```bash
pnpm benchmark
```

This builds the library and runs `scripts/benchmark-wasm.mjs`. No native addons
or node-gyp toolchain are required.

Tune warmup and iteration counts with environment variables:

```bash
LIBMLOW_WASM_BENCH_WARMUP=500 LIBMLOW_WASM_BENCH_ITERATIONS=10000 pnpm benchmark
```

## Sample output

```json
{
  "codec": "libopus 1.4 ...",
  "results": [
    { "name": "wasm encode", "opsPerSecond": 15304, "durationMs": 1308.15 },
    { "name": "wasm decode", "opsPerSecond": 38416, "durationMs": 520.61 }
  ]
}
```

For 20 ms frames, ~50 ops/sec is enough for one realtime stream. Typical results
are orders of magnitude above that, leaving headroom for many concurrent streams.

> These numbers are a regression check, not a portable score. Throughput depends
> on CPU, Node version, and Emscripten flags — compare runs on the same machine.

## In CI

The GitHub Actions workflow exposes a manual **Benchmark** job
(`workflow_dispatch`) so you can capture WASM numbers on the CI runner on demand.

## Next

- [Building from source](building.md) — produce the build the benchmark runs.
- [Encoder tuning](encoder-tuning.md) — `complexity` is the main throughput knob.
