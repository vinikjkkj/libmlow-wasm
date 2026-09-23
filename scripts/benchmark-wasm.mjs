import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { PerformanceObserver, performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  Application,
  Signal,
  createDecoder,
  createEncoder,
  createRepacketizer,
  loadLibopus,
} from "../dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const warmupIterations = Number(process.env.LIBMLOW_WASM_BENCH_WARMUP ?? 2_000);
const iterations = Number(process.env.LIBMLOW_WASM_BENCH_ITERATIONS ?? 5_000);
const trials = Number(process.env.LIBMLOW_WASM_BENCH_TRIALS ?? 5);

// A benchmark that re-encodes one frame converges the encoder onto a fixed
// point: the rate controller settles, no mode switch is ever exercised, and the
// branch predictor sees the same path forever. Real speech keeps moving, so the
// corpus below cycles through voiced, unvoiced, onset and silent frames.
const CORPUS_SECONDS = 2;

const gcMs = trackGc();
const build = await describeBuild();

const suites = [
  await opusSuite(),
  await mlowSuite(),
  await packetInfoSuite(),
  await repacketizerSuite(),
];

report({ build, suites });

async function opusSuite() {
  const sampleRate = 48_000;
  const channels = 2;
  const frameSize = 960; // 20 ms
  const frames = speechCorpus({ sampleRate, channels, frameSize });

  const results = [];
  for (const complexity of [5, 10]) {
    const encoder = await createEncoder({
      application: Application.Audio,
      bitrate: 64_000,
      channels,
      complexity,
      frameSize,
      sampleRate,
    });
    const decoder = await createDecoder({ channels, maxFrameSize: frameSize, sampleRate });
    const packets = frames.map((frame) => encoder.encode(frame));
    const pcmOut = new Int16Array(frameSize * channels);
    try {
      results.push(
        measure(`opus encode 48k stereo 20ms c${complexity}`, (i) => {
          encoder.encode(frames[i % frames.length]);
        }),
        measure(`opus decode 48k stereo 20ms c${complexity}`, (i) => {
          decoder.decode(packets[i % packets.length]);
        }),
        measure(`opus decodeInto 48k stereo 20ms c${complexity}`, (i) => {
          decoder.decodeInto(pcmOut, packets[i % packets.length]);
        }),
      );
      if (complexity === 10) {
        results.push(boundaryFloor(frames[0], packets[0]));
      }
    } finally {
      decoder.free();
      encoder.free();
    }
  }
  return { name: "opus (48 kHz stereo)", meanPacketBytes: undefined, results };
}

async function mlowSuite() {
  // The reason this fork exists. 16 kHz mono, 20 ms — the frame WhatsApp emits.
  const sampleRate = 16_000;
  const channels = 1;
  const frameSize = 320;
  const frames = speechCorpus({ sampleRate, channels, frameSize });

  const encoder = await createEncoder({
    application: Application.Voip,
    bitrate: 8_000,
    channels,
    complexity: 5,
    dtx: true,
    frameSize,
    sampleRate,
    signal: Signal.Voice,
    useSmpl: true,
  });
  const decoder = await createDecoder({
    channels,
    maxFrameSize: frameSize * 3,
    sampleRate,
    useSmpl: true,
  });

  try {
    const packets = frames.map((frame) => encoder.encode(frame));
    const meanPacketBytes = mean(packets.map((p) => p.byteLength));
    const pcmOut = new Int16Array(frameSize * channels);

    // RED needs its own encoder: the codec requires one encodeSecondary() per
    // encode(), so an instance that also serves the plain encode benchmark
    // would break that pairing.
    const redEncoder = await createEncoder({
      application: Application.Voip,
      bitrate: 8_000,
      channels,
      complexity: 5,
      frameSize,
      sampleRate,
      signal: Signal.Voice,
      useSmpl: true,
    });
    redEncoder.setSecondaryBitrate(4_000);
    redEncoder.setSecondaryComplexity(3);

    const results = [
      measure("mlow encode 16k mono 20ms", (i) => {
        encoder.encode(frames[i % frames.length]);
      }),
      measure("mlow encode + RED secondary", (i) => {
        redEncoder.encode(frames[i % frames.length]);
        redEncoder.encodeSecondary();
      }),
      measure("mlow decode 16k mono 20ms", (i) => {
        decoder.decode(packets[i % packets.length]);
      }),
      measure("mlow decodeInto 16k mono 20ms", (i) => {
        decoder.decodeInto(pcmOut, packets[i % packets.length]);
      }),
      measure("mlow decode with FEC", (i) => {
        decoder.decode(packets[i % packets.length], { decodeFec: true });
      }),
      measure("mlow packet-loss concealment", () => {
        decoder.decodePacketLoss(frameSize);
      }),
    ];
    redEncoder.free();
    return { name: "mlow (16 kHz mono, SMPL)", meanPacketBytes, results };
  } finally {
    decoder.free();
    encoder.free();
  }
}

async function packetInfoSuite() {
  const { getMlowPacketInfo, getPacketInfo } = await import("../dist/index.js");

  // getPacketInfo parses as vanilla Opus, so it needs Opus packets; a native
  // SMPL packet is not valid Opus and it rightly rejects one.
  const opusEncoder = await createEncoder({ channels: 2, frameSize: 960, sampleRate: 48_000 });
  const mlowEncoder = await createEncoder({
    channels: 1,
    frameSize: 320,
    sampleRate: 16_000,
    useSmpl: true,
  });
  try {
    const opusPackets = speechCorpus({ sampleRate: 48_000, channels: 2, frameSize: 960 }).map(
      (frame) => opusEncoder.encode(frame),
    );
    const mlowPackets = speechCorpus({ sampleRate: 16_000, channels: 1, frameSize: 320 }).map(
      (frame) => mlowEncoder.encode(frame),
    );
    return {
      name: "packet inspection",
      results: [
        await measureAsync("getPacketInfo (opus, validates by decoding)", (i) =>
          getPacketInfo(opusPackets[i % opusPackets.length], { sampleRate: 48_000 }),
        ),
        await measureAsync("getMlowPacketInfo (parse only)", (i) =>
          getMlowPacketInfo(mlowPackets[i % mlowPackets.length], { sampleRate: 16_000 }),
        ),
      ],
    };
  } finally {
    mlowEncoder.free();
    opusEncoder.free();
  }
}

async function repacketizerSuite() {
  const sampleRate = 16_000;
  const frameSize = 320;
  const frames = speechCorpus({ sampleRate, channels: 1, frameSize });
  const encoder = await createEncoder({
    application: Application.Voip,
    bitrate: 8_000,
    channels: 1,
    frameSize,
    sampleRate,
    useSmpl: true,
  });
  const repacketizer = await createRepacketizer();
  try {
    const packets = frames.map((frame) => encoder.encode(frame));
    const triples = [];
    for (let i = 0; i + 2 < packets.length; i += 3) {
      triples.push([packets[i], packets[i + 1], packets[i + 2]]);
    }
    return {
      name: "repacketizer (3x20 ms, WhatsApp framing)",
      results: [
        measure("pack 3 frames", (i) => {
          repacketizer.pack(triples[i % triples.length]);
        }),
      ],
    };
  } finally {
    repacketizer.free();
    encoder.free();
  }
}

/** Overhead floor: the JS↔WASM copies with no codec work, so `encode - floor` isolates the codec. */
function boundaryFloor(pcm, packet) {
  const sink = new Int16Array(pcm.length);
  return measure("— boundary floor (copy only, no codec)", () => {
    sink.set(pcm);
    return sink[packet.byteLength % sink.length];
  });
}

/**
 * Runs `trials` alternating rounds and reports the median trial, so a thermal
 * or frequency drift during one round cannot masquerade as a regression. Within
 * a round every iteration is timed individually: for a codec on a 20 ms budget
 * p99 decides, not the mean.
 */
function measure(name, fn) {
  const samples = new Float64Array(iterations);
  const trialStats = [];
  for (let trial = 0; trial < trials; trial += 1) {
    for (let i = 0; i < warmupIterations; i += 1) {
      fn(i);
    }
    const gcBefore = gcMs.total;
    const heapBefore = process.memoryUsage().heapUsed;
    for (let i = 0; i < iterations; i += 1) {
      const start = performance.now();
      fn(i);
      samples[i] = performance.now() - start;
    }
    trialStats.push({
      ...percentiles(samples),
      gcMs: round(gcMs.total - gcBefore, 2),
      heapDeltaBytes: process.memoryUsage().heapUsed - heapBefore,
    });
  }
  return { name, ...medianTrial(trialStats), trials: trialStats.length };
}

async function measureAsync(name, fn) {
  const samples = new Float64Array(iterations);
  const trialStats = [];
  for (let trial = 0; trial < trials; trial += 1) {
    for (let i = 0; i < warmupIterations; i += 1) {
      await fn(i);
    }
    const gcBefore = gcMs.total;
    for (let i = 0; i < iterations; i += 1) {
      const start = performance.now();
      await fn(i);
      samples[i] = performance.now() - start;
    }
    trialStats.push({ ...percentiles(samples), gcMs: round(gcMs.total - gcBefore, 2) });
  }
  return { name, ...medianTrial(trialStats), trials: trialStats.length };
}

function percentiles(samples) {
  const sorted = Float64Array.prototype.slice.call(samples).sort();
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    meanUs: round((total / sorted.length) * 1000, 2),
    p50Us: round(at(0.5) * 1000, 2),
    p90Us: round(at(0.9) * 1000, 2),
    p99Us: round(at(0.99) * 1000, 2),
    maxUs: round(sorted[sorted.length - 1] * 1000, 2),
    opsPerSecond: Math.round(sorted.length / (total / 1000)),
  };
}

/** Median by p50, plus the spread across trials — if spread exceeds your delta, the delta is noise. */
function medianTrial(trialStats) {
  const sorted = [...trialStats].sort((a, b) => a.p50Us - b.p50Us);
  const median = sorted[Math.floor(sorted.length / 2)];
  const p50s = trialStats.map((t) => t.p50Us);
  return {
    ...median,
    trialSpreadPct: round(((Math.max(...p50s) - Math.min(...p50s)) / median.p50Us) * 100, 1),
  };
}

/**
 * Speech-like corpus: voiced frames with harmonics and drifting pitch, unvoiced
 * noise, onsets, and silence. Channels are decorrelated so mid/side cannot
 * collapse the side channel the way a duplicated tone does.
 */
function speechCorpus({ sampleRate, channels, frameSize }) {
  const frameCount = Math.floor((CORPUS_SECONDS * sampleRate) / frameSize);
  const frames = [];
  let phase = 0;
  for (let f = 0; f < frameCount; f += 1) {
    const frame = new Int16Array(frameSize * channels);
    const position = f / frameCount;
    // Cycle: voiced -> onset -> unvoiced -> silence.
    const segment = f % 20;
    const silent = segment >= 17;
    const unvoiced = segment >= 12 && segment < 17;
    const onset = segment === 0 || segment === 11;
    const f0 = 95 + 55 * Math.sin(position * Math.PI * 4);
    const envelope = silent ? 0 : onset ? 1 : 0.55 + 0.45 * Math.sin(position * Math.PI * 9);

    for (let s = 0; s < frameSize; s += 1) {
      phase += (2 * Math.PI * f0) / sampleRate;
      let value = 0;
      if (unvoiced) {
        value = (Math.random() * 2 - 1) * 0.35;
      } else if (!silent) {
        // A few harmonics with falling amplitude approximate a glottal pulse.
        for (let h = 1; h <= 6; h += 1) {
          value += Math.sin(phase * h) / (h * 1.5);
        }
        value *= 0.4;
        value += (Math.random() * 2 - 1) * 0.04; // breath
      }
      value *= envelope;
      for (let c = 0; c < channels; c += 1) {
        // Slight per-channel delay and gain keeps the channels decorrelated.
        const spread = c === 0 ? 1 : 0.82;
        const jitter = c === 0 ? 0 : Math.sin(phase * 0.5) * 0.06;
        frame[s * channels + c] = clampInt16((value * spread + jitter) * 26_000);
      }
    }
    frames.push(frame);
  }
  return frames;
}

function clampInt16(value) {
  return Math.max(-32_768, Math.min(32_767, Math.round(value)));
}

function trackGc() {
  const state = { total: 0 };
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        state.total += entry.duration;
      }
    });
    observer.observe({ entryTypes: ["gc"] });
  } catch {
    // GC timing is best-effort; the rest of the run is still valid without it.
  }
  return state;
}

/**
 * Identifies exactly which artifact produced these numbers. Without this you can
 * measure a stale dist/ and credit a change that was never compiled.
 */
async function describeBuild() {
  const generated = path.join(repoRoot, "dist", "generated", "libmlow.generated.mjs");
  const entry = path.join(repoRoot, "dist", "index.js");
  const [libopus, generatedStat, entryStat] = await Promise.all([
    loadLibopus(),
    fs.stat(generated).catch(() => undefined),
    fs.stat(entry).catch(() => undefined),
  ]);
  const hash = generatedStat
    ? createHash("sha256").update(await fs.readFile(generated)).digest("hex").slice(0, 16)
    : undefined;
  return {
    codec: libopus.version,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    wasmBuiltAt: generatedStat?.mtime.toISOString(),
    wasmBytes: generatedStat?.size,
    wasmSha256: hash,
    distBuiltAt: entryStat?.mtime.toISOString(),
  };
}

function report(payload) {
  if (process.env.LIBMLOW_WASM_BENCH_JSON === "1") {
    console.log(JSON.stringify({ ...payload, iterations, trials, warmupIterations }, null, 2));
    return;
  }
  console.log(`codec       ${payload.build.codec}`);
  console.log(`node        ${payload.build.node} (${payload.build.platform})`);
  console.log(`wasm        ${payload.build.wasmSha256 ?? "MISSING"} · ${payload.build.wasmBuiltAt ?? "-"}`);
  console.log(`sampling    ${iterations} iters x ${trials} trials (warmup ${warmupIterations})\n`);

  for (const suite of payload.suites) {
    const extra = suite.meanPacketBytes ? ` — mean packet ${round(suite.meanPacketBytes, 1)} B` : "";
    console.log(`${suite.name}${extra}`);
    console.log(
      `  ${"case".padEnd(42)}${"p50".padStart(9)}${"p90".padStart(9)}${"p99".padStart(9)}${"max".padStart(9)}${"ops/s".padStart(10)}${"gc ms".padStart(8)}${"spread".padStart(9)}`,
    );
    for (const r of suite.results) {
      console.log(
        `  ${r.name.padEnd(42)}${fmt(r.p50Us)}${fmt(r.p90Us)}${fmt(r.p99Us)}${fmt(r.maxUs)}${String(r.opsPerSecond).padStart(10)}${String(r.gcMs ?? "-").padStart(8)}${`${r.trialSpreadPct}%`.padStart(9)}`,
      );
    }
    console.log();
  }
  console.log("times in microseconds. spread = variation of p50 across trials;");
  console.log("a delta smaller than the spread is noise, not a result.");
}

function fmt(value) {
  return value.toFixed(1).padStart(9);
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
