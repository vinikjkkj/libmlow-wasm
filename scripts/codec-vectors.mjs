/**
 * Emits a deterministic fingerprint of the codec's actual output across every
 * path the library exposes. Run it against two builds and diff the JSON: if the
 * hashes match, the codec behaves identically, whatever changed around it.
 *
 *   node scripts/codec-vectors.mjs > before.json
 *   ...change something, rebuild...
 *   node scripts/codec-vectors.mjs > after.json
 *   diff before.json after.json
 */
import { createHash } from "node:crypto";
import { Application, Signal, createDecoder, createEncoder, loadLibopus } from "../dist/index.js";

const results = {};

/** Deterministic PCM — no Math.random, so two runs are always comparable. */
function pcmFrame(frameSize, channels, seed) {
  const frame = new Int16Array(frameSize * channels);
  let state = seed >>> 0;
  for (let s = 0; s < frameSize; s += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const noise = ((state >>> 16) / 32768 - 1) * 0.15;
    const voiced = Math.sin((s / frameSize) * Math.PI * 2 * (3 + (seed % 5)));
    for (let c = 0; c < channels; c += 1) {
      const v = (voiced * (c === 0 ? 1 : 0.7) + noise) * 20000;
      frame[s * channels + c] = Math.max(-32768, Math.min(32767, Math.round(v)));
    }
  }
  return frame;
}

function hash(chunks) {
  const h = createHash("sha256");
  for (const chunk of chunks) {
    h.update(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
  }
  return h.digest("hex").slice(0, 32);
}

async function roundTrip(label, encOpts, decOpts, frameSize) {
  let encoder;
  let decoder;
  try {
    encoder = await createEncoder(encOpts);
    decoder = await createDecoder(decOpts);
  } catch (error) {
    // Lets the same harness run against builds that lack a capability, so the
    // diff shows the gain instead of failing outright.
    results[label] = { unsupported: error.message };
    encoder?.free();
    decoder?.free();
    return;
  }
  try {
    const packets = [];
    const pcms = [];
    for (let i = 0; i < 40; i += 1) {
      const packet = encoder.encode(pcmFrame(frameSize, encOpts.channels ?? 2, i));
      packets.push(packet);
      pcms.push(decoder.decode(packet));
    }
    results[label] = {
      packetHash: hash(packets),
      pcmHash: hash(pcms),
      totalPacketBytes: packets.reduce((n, p) => n + p.byteLength, 0),
      totalSamples: pcms.reduce((n, p) => n + p.length, 0),
    };
  } finally {
    decoder.free();
    encoder.free();
  }
}

// Opus at every supported rate and both channel counts.
for (const sampleRate of [8000, 12000, 16000, 24000, 48000]) {
  for (const channels of [1, 2]) {
    const frameSize = (sampleRate / 1000) * 20;
    await roundTrip(
      `opus-${sampleRate}-${channels}ch`,
      { channels, frameSize, sampleRate },
      { channels, sampleRate },
      frameSize,
    );
  }
}

// MLow/SMPL at each native frame duration.
for (const durationMs of [10, 20, 60, 120]) {
  const frameSize = 16 * durationMs;
  await roundTrip(
    `mlow-16k-${durationMs}ms`,
    {
      application: Application.Voip,
      bitrate: 8000,
      channels: 1,
      frameSize,
      sampleRate: 16000,
      signal: Signal.Voice,
      useSmpl: true,
    },
    { channels: 1, maxFrameSize: frameSize, sampleRate: 16000, useSmpl: true },
    frameSize,
  );
}

// Deepest stack path the library allows: 120 ms at 48 kHz stereo, float decode.
{
  const encoder = await createEncoder({ channels: 2, frameSize: 2880, sampleRate: 48000 });
  const decoder = await createDecoder({ channels: 2, maxFrameSize: 5760, sampleRate: 48000 });
  try {
    const out = [];
    for (let i = 0; i < 20; i += 1) {
      out.push(decoder.decodeFloat(encoder.encode(pcmFrame(2880, 2, i))));
    }
    results["deep-stack-48k-stereo-float"] = { pcmHash: hash(out), frames: out.length };
  } finally {
    decoder.free();
    encoder.free();
  }
}

// Float path, FEC, and packet-loss concealment.
{
  const encoder = await createEncoder({ channels: 1, fec: true, frameSize: 320, packetLossPercent: 20, sampleRate: 16000, useSmpl: true });
  const decoder = await createDecoder({ channels: 1, sampleRate: 16000, useSmpl: true });
  try {
    const packets = [];
    for (let i = 0; i < 20; i += 1) {
      packets.push(encoder.encode(pcmFrame(320, 1, i)));
    }
    const plc = [];
    for (let i = 0; i < packets.length; i += 1) {
      plc.push(i % 3 === 1 ? decoder.decodePacketLoss(320) : decoder.decode(packets[i]));
    }
    results["mlow-fec-plc"] = { packetHash: hash(packets), pcmHash: hash(plc) };
  } finally {
    decoder.free();
    encoder.free();
  }
}

/**
 * Error identity for malformed input. Packet validation moved into a single C
 * call, so this pins down that a given bad packet still produces the same error
 * class, code and message rather than merely "some error".
 */
const errors = {};

async function errorCase(label, fn) {
  try {
    const value = await fn();
    errors[label] = { threw: false, value: String(value) };
  } catch (error) {
    errors[label] = {
      threw: true,
      name: error.constructor.name,
      code: error.code ?? null,
      codeName: error.codeName ?? null,
      operation: error.operation ?? null,
      message: error.message,
    };
  }
}

{
  const { getMlowPacketInfo, getPacketInfo } = await import("../dist/index.js");
  const bad = {
    empty: new Uint8Array(),
    oneByte: new Uint8Array([1]),
    fourBytes: new Uint8Array([1, 2, 3, 4]),
    allZero: new Uint8Array(16),
    allOnes: new Uint8Array(16).fill(0xff),
    truncatedCelt: new Uint8Array([0xfc, 0x01]),
    tocOnly: new Uint8Array([0x08]),
    longGarbage: Uint8Array.from({ length: 200 }, (_, i) => (i * 37) % 256),
  };
  for (const [name, packet] of Object.entries(bad)) {
    await errorCase(`getPacketInfo:${name}`, () => getPacketInfo(packet));
    await errorCase(`getMlowPacketInfo:${name}`, () => getMlowPacketInfo(packet, { sampleRate: 16000 }));
  }
  await errorCase("getPacketInfo:badRate", () => getPacketInfo(bad.fourBytes, { sampleRate: 44100 }));

  const decoder = await createDecoder({ channels: 2, sampleRate: 48000 });
  try {
    for (const [name, packet] of Object.entries(bad)) {
      await errorCase(`decode:${name}`, () => decoder.decode(packet));
    }
    await errorCase("decode:fecWithoutPacket", () => decoder.decode(null, { decodeFec: true }));
  } finally {
    decoder.free();
  }

  const encoder = await createEncoder({ channels: 2, frameSize: 960, sampleRate: 48000 });
  try {
    await errorCase("encode:shortPcm", () => encoder.encode(new Int16Array(10)));
    await errorCase("encode:badFrameSize", () => encoder.encode(new Int16Array(1920), { frameSize: 7 }));
    await errorCase("encode:zeroMaxPacket", () =>
      encoder.encode(new Int16Array(1920), { maxPacketBytes: 0 }),
    );
    await errorCase("ctl:pointerRequest", () => encoder.encoderCtl(4031, 0));
  } finally {
    encoder.free();
  }
}

const { version } = await loadLibopus();
console.log(JSON.stringify({ codec: version, vectors: results, errors }, null, 2));
