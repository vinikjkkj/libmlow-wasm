import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { OpusEncoder as DiscordOpusEncoder } from "../src/discordjs.js";
import {
  Application,
  Bandwidth,
  Bitrate,
  DecoderCtl,
  EncoderCtl,
  OpusError,
  OpusErrorCode,
  Signal,
  createDecoder,
  createEncoder,
  createRepacketizer,
  getMlowPacketInfo,
  getPacketInfo,
  MlowMode,
  isOpusError,
  loadLibopus,
  opusGlobalCreate,
  opusGlobalFree,
} from "../src/index.js";

describe("libmlow-wasm", () => {
  it("reports the bundled opus_mlow version", async () => {
    const info = await loadLibopus();

    expect(info.version).toContain("libopus");
    expect(info.version).toMatch(/1\.0\.1/);
  });

  it("uses Discord-ready defaults", async () => {
    const encoder = await createEncoder();
    const decoder = await createDecoder();
    try {
      const pcm = makeSineFrame(encoder.frameSize, encoder.channels);

      const packet = encoder.encode(pcm);
      const decoded = decoder.decode(packet);

      expect(encoder.application).toBe(Application.Audio);
      expect(encoder.channels).toBe(2);
      expect(encoder.frameSize).toBe(960);
      expect(encoder.sampleRate).toBe(48_000);
      expect(packet.byteLength).toBeGreaterThan(0);
      expect(packet.byteLength).toBeLessThan(4000);
      expect(decoded.length).toBe(encoder.frameSize * encoder.channels);
    } finally {
      encoder.free();
      decoder.free();
    }
  });

  it("encodes and decodes batches", async () => {
    const encoder = await createEncoder({
      bitrate: 64_000,
      channels: 2,
      complexity: 7,
      frameSize: 960,
      fec: true,
      maxBandwidth: Bandwidth.Fullband,
      packetLossPercent: 5,
      sampleRate: 48_000,
      signal: Signal.Music,
      vbr: true,
      vbrConstraint: true,
    });
    const decoder = await createDecoder({ channels: 2, sampleRate: 48_000 });
    try {
      const frames = [makeSineFrame(960, 2), makeSineFrame(960, 2)];

      const packets = encoder.encodeFrames(frames);
      const decoded = decoder.decodeFrames(packets);

      expect(packets).toHaveLength(2);
      expect(decoded.map((frame) => frame.length)).toEqual([1920, 1920]);
      expect(encoder.getBitrate()).toBe(64_000);
      expect(encoder.getLookahead()).toBeGreaterThan(0);
      expect(encoder.getInDtx()).toBe(false);
    } finally {
      encoder.free();
      decoder.free();
    }
  });

  it("derives 20 ms default frames from non-48 kHz sample rates", async () => {
    const encoder = await createEncoder({ channels: 1, sampleRate: 8000 });
    const decoder = await createDecoder({ channels: 1, sampleRate: 8000 });
    try {
      const packet = encoder.encode(makeSineFrame(encoder.frameSize, encoder.channels));
      const decoded = decoder.decode(packet);

      expect(encoder.frameSize).toBe(160);
      expect(decoder.maxFrameSize).toBe(960);
      expect(decoded.length).toBe(160);
    } finally {
      encoder.free();
      decoder.free();
    }
  });

  it("supports raw encoder CTLs", async () => {
    const encoder = await createEncoder();
    try {
      encoder.encoderCtl(EncoderCtl.SetBitrate, 32_000);
      encoder.encoderCtl(EncoderCtl.SetUseSmpl, 1);

      expect(encoder.getBitrate()).toBe(32_000);
    } finally {
      encoder.free();
    }
  });

  it("accepts Opus bitrate sentinels", async () => {
    const encoder = await createEncoder({ bitrate: "auto" });
    try {
      expect(encoder.getBitrate()).toBeGreaterThan(0);

      encoder.setBitrate("max");
      expect(encoder.getBitrate()).toBeGreaterThan(0);

      encoder.setBitrate(Bitrate.Auto);
      expect(encoder.getBitrate()).toBeGreaterThan(0);
    } finally {
      encoder.free();
    }
  });

  it("encodes and decodes Float32 PCM", async () => {
    const encoder = await createEncoder();
    const decoder = await createDecoder();
    try {
      const packet = encoder.encodeFloat(makeSineFloatFrame(encoder.frameSize, encoder.channels));
      const decoded = decoder.decodeFloat(packet);
      const decodedBatch = decoder.decodeFloatFrames([packet]);

      expect(packet.byteLength).toBeGreaterThan(0);
      expect(decoded).toBeInstanceOf(Float32Array);
      expect(decoded.length).toBe(encoder.frameSize * encoder.channels);
      expect(decodedBatch).toHaveLength(1);
      expect(decodedBatch[0]?.length).toBe(encoder.frameSize * encoder.channels);
    } finally {
      encoder.free();
      decoder.free();
    }
  });

  it("reports raw packet metadata without decoding", async () => {
    const encoder = await createEncoder({ frameSize: 960, sampleRate: 48_000 });
    try {
      const packet = encoder.encode(makeSineFrame(encoder.frameSize, encoder.channels));
      const info = await getPacketInfo(packet);

      expect(Object.values(Bandwidth)).toContain(info.bandwidth);
      expect(info.channels).toBe(2);
      expect(info.durationMs).toBe(20);
      expect(info.frames).toBe(1);
      expect(info.samples).toBe(960);
      expect(info.samplesPerFrame).toBe(960);
      expect(info.sampleRate).toBe(48_000);
    } finally {
      encoder.free();
    }
  });

  it("reports MLow packet metadata via mlow_packet helpers", async () => {
    const encoder = await createEncoder({ frameSize: 960, sampleRate: 48_000 });
    try {
      const packet = encoder.encode(makeSineFrame(encoder.frameSize, encoder.channels));
      const info = await getMlowPacketInfo(packet);

      expect(info.durationMs).toBe(20);
      expect(info.frames).toBe(1);
      expect(info.samples).toBe(960);
      expect(info.samplesPerFrame).toBe(960);
      expect(info.sampleRate).toBe(48_000);
      expect(Object.values(Bandwidth)).toContain(info.bandwidth);
      expect(typeof info.hasVadFlag).toBe("boolean");
      expect(typeof info.hasFecContent).toBe("boolean");
      expect(info.toc).toMatchObject({
        mode: expect.any(Number),
        bandwidth: expect.any(Number),
        samplesPerFrame: expect.any(Number),
        stereo: expect.any(Number),
      });
    } finally {
      encoder.free();
    }
  });

  it("encodes and decodes with SMPL/MLow enabled", async () => {
    const encoder = await createEncoder({
      bitrate: 8_000,
      channels: 1,
      sampleRate: 48_000,
      useSmpl: true,
    });
    const decoder = await createDecoder({ channels: 1, sampleRate: 48_000, useSmpl: true });
    try {
      const pcm = makeSineFrame(encoder.frameSize, encoder.channels);
      const packet = encoder.encode(pcm);
      const decoded = decoder.decode(packet);
      const info = await getMlowPacketInfo(packet);

      expect(packet.byteLength).toBeGreaterThan(0);
      expect(info.frames).toBe(1);
      expect(info.samples).toBe(encoder.frameSize);
      expect(decoded.length).toBe(encoder.frameSize * encoder.channels);
    } finally {
      encoder.free();
      decoder.free();
    }
  });

  it("reinitializes SMPL globals after opusGlobalFree", async () => {
    await opusGlobalFree();
    const encoder = await createEncoder({
      channels: 1,
      bitrate: 8_000,
      sampleRate: 48_000,
      useSmpl: true,
    });
    const decoder = await createDecoder({ channels: 1, sampleRate: 48_000, useSmpl: true });
    try {
      const packet = encoder.encode(makeSineFrame(encoder.frameSize, encoder.channels));
      const decoded = decoder.decode(packet);
      expect(packet.byteLength).toBeGreaterThan(0);
      expect(decoded.length).toBe(encoder.frameSize * encoder.channels);
    } finally {
      encoder.free();
      decoder.free();
    }
  });

  it("initializes SMPL globals explicitly with opusGlobalCreate", async () => {
    await opusGlobalFree();
    await opusGlobalCreate();
    const encoder = await createEncoder({
      channels: 1,
      bitrate: 8_000,
      sampleRate: 48_000,
      useSmpl: true,
    });
    try {
      const packet = encoder.encode(makeSineFrame(encoder.frameSize, encoder.channels));
      expect(packet.byteLength).toBeGreaterThan(0);
    } finally {
      encoder.free();
    }
  });

  it("reports packet metadata at the caller-selected sample rate", async () => {
    const encoder = await createEncoder({ channels: 1, sampleRate: 16_000 });
    try {
      const packet = encoder.encode(makeSineFrame(encoder.frameSize, encoder.channels));
      const info = await getPacketInfo(packet, { sampleRate: 16_000 });

      expect(info.channels).toBe(1);
      expect(info.durationMs).toBe(20);
      expect(info.samples).toBe(320);
      expect(info.samplesPerFrame).toBe(320);
      expect(info.sampleRate).toBe(16_000);
    } finally {
      encoder.free();
    }
  });

  it("rejects invalid packet metadata requests", async () => {
    await expect(getPacketInfo(new Uint8Array())).rejects.toThrow(RangeError);
    await expect(getPacketInfo(new Uint8Array([1]), { sampleRate: 44_100 as 48_000 })).rejects.toThrow(
      RangeError,
    );
    await expect(getPacketInfo(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow(OpusError);
  });

  it("synthesizes packet-loss concealment frames", async () => {
    const encoder = await createEncoder({ fec: true, packetLossPercent: 15 });
    const decoder = await createDecoder();
    try {
      const packet = encoder.encode(makeSineFrame(encoder.frameSize, encoder.channels));
      decoder.decode(packet);

      const concealed = decoder.decodePacketLoss(encoder.frameSize);
      const concealedViaNull = decoder.decode(null, { frameSize: encoder.frameSize });
      const concealedThirtyMs = decoder.decodePacketLoss(1440);
      const concealedFloat = decoder.decodePacketLossFloat(encoder.frameSize);

      expect(concealed.length).toBe(encoder.frameSize * encoder.channels);
      expect(concealedViaNull.length).toBe(encoder.frameSize * encoder.channels);
      expect(concealedThirtyMs.length).toBe(1440 * encoder.channels);
      expect(concealedFloat.length).toBe(encoder.frameSize * encoder.channels);
    } finally {
      encoder.free();
      decoder.free();
    }
  });

  it("rejects pointer-style CTL requests at the JS boundary", async () => {
    const encoder = await createEncoder();
    const decoder = await createDecoder();
    try {
      decoder.decoderCtl(DecoderCtl.SetGain, 0);

      expect(() => encoder.encoderCtl(4003, 0)).toThrow(RangeError);
      expect(() => decoder.decoderCtl(4045, 0)).toThrow(RangeError);
    } finally {
      encoder.free();
      decoder.free();
    }
  });

  it("returns JS errors for invalid packets", async () => {
    const decoder = await createDecoder();
    try {
      expect(() => decoder.decode(new Uint8Array())).toThrow(RangeError);
      expect(() => decoder.decode(null, { decodeFec: true })).toThrow(RangeError);
      let error: unknown;
      try {
        decoder.decode(new Uint8Array([1, 2, 3, 4]));
      } catch (err) {
        error = err;
      }

      expect(error).toBeInstanceOf(OpusError);
      expect(isOpusError(error)).toBe(true);
      expect(error).toMatchObject({
        code: OpusErrorCode.InvalidPacket,
        codeName: "InvalidPacket",
        operation: "decode",
      });
      expect(
        isOpusError({
          name: "OpusError",
          message: "libmlow decode failed (-4): corrupted stream",
          code: OpusErrorCode.InvalidPacket,
          codeName: "InvalidPacket",
          operation: "decode",
        }),
      ).toBe(true);
    } finally {
      decoder.free();
    }
  });

  it("rejects invalid frame sizes before touching wasm", async () => {
    const encoder = await createEncoder({ channels: 1, sampleRate: 8000 });
    try {
      expect(() => encoder.encode(new Int16Array(0), { frameSize: 0 })).toThrow(RangeError);
      expect(() => encoder.encode(new Int16Array(5760), { frameSize: 5760 })).toThrow(
        /samples at 8000 Hz/,
      );
      expect(() => encoder.encode(makeSineFrame(160, 1), { maxPacketBytes: 0 })).toThrow(RangeError);
      expect(() => encoder.encodeFloat(new Float32Array(0), { frameSize: 160 })).toThrow(RangeError);
    } finally {
      encoder.free();
    }
  });

  it("rejects invalid codec and tuning options", async () => {
    await expect(createEncoder({ sampleRate: 44_100 as 48_000 })).rejects.toThrow(RangeError);
    await expect(createDecoder({ channels: 3 as 2 })).rejects.toThrow(RangeError);
    await expect(createEncoder({ frameSize: 123 })).rejects.toThrow(RangeError);
    await expect(createDecoder({ maxFrameSize: 0 })).rejects.toThrow(RangeError);
    await expect(createEncoder({ maxBandwidth: 9999 as Bandwidth })).rejects.toThrow(RangeError);

    const encoder = await createEncoder();
    try {
      expect(() => encoder.setComplexity(11)).toThrow(RangeError);
      expect(() => encoder.setPacketLossPercent(101)).toThrow(RangeError);
      expect(() => encoder.setMaxBandwidth(9999 as Bandwidth)).toThrow(RangeError);
      expect(() => encoder.setSignal(9999 as Signal)).toThrow(RangeError);
      expect(() => encoder.setBitrate(0)).toThrow(RangeError);
      expect(() => encoder.encoderCtl(EncoderCtl.SetBitrate + 0.5, 32_000)).toThrow(RangeError);
      expect(() => encoder.encoderCtl(EncoderCtl.SetBitrate, 32_000.5)).toThrow(RangeError);
    } finally {
      encoder.free();
    }
  });

  it("validates decode capacity and freed decoders", async () => {
    const encoder = await createEncoder();
    const decoder = await createDecoder();
    try {
      const packet = encoder.encode(makeSineFrame(encoder.frameSize, encoder.channels));

      expect(() => decoder.decode(packet, { maxFrameSize: 0 })).toThrow(RangeError);
      expect(() => decoder.decode(null, { frameSize: 119 })).toThrow(RangeError);
      expect(() => decoder.decoderCtl(DecoderCtl.SetGain + 0.5, 0)).toThrow(RangeError);
      expect(() => decoder.decoderCtl(DecoderCtl.SetGain, 0.5)).toThrow(RangeError);

      decoder[Symbol.dispose]();
      decoder.free();
      expect(() => decoder.decode(packet)).toThrow(/freed/);
    } finally {
      encoder.free();
      decoder.free();
    }
  });

  it("offers an async @discordjs/opus-compatible adapter", async () => {
    const opus = await DiscordOpusEncoder.create(48_000, 2);
    try {
      const pcm = Buffer.from(makeSineFrame(960, 2).buffer);

      const packet = opus.encode(pcm);
      const decoded = opus.decode(packet);
      opus.applyEncoderCTL(EncoderCtl.SetBandwidth, 1105);
      opus.applyEncoderCTL(EncoderCtl.SetForceChannels, 2);
      opus.applyDecoderCTL(DecoderCtl.SetPhaseInversionDisabled, 1);
      opus.setBitrate(48_000);
      opus.setFEC(true);
      opus.setPLP(10);

      expect(packet).toBeInstanceOf(Buffer);
      expect(decoded).toBeInstanceOf(Buffer);
      expect(decoded.byteLength).toBe(960 * 2 * 2);
      expect(opus.getBitrate()).toBe(48_000);
    } finally {
      opus.free();
    }
  });

  it("surfaces async discord adapter init failures from sync methods", async () => {
    const opus = new DiscordOpusEncoder(44_100, 2);
    await expect(opus.ready).rejects.toThrow(RangeError);

    expect(() => opus.encode(Buffer.alloc(960 * 2 * 2))).toThrow(/failed to initialize/);
  });

  it("guards discord adapter readiness, frame sizing, and disposal", async () => {
    const pending = new DiscordOpusEncoder();
    try {
      expect(() => pending.encode(Buffer.alloc(960 * 2 * 2))).toThrow(/not ready/);
    } finally {
      pending.free();
      await pending.ready;
    }

    const opus = await DiscordOpusEncoder.create();
    expect(() => opus.encode(Buffer.alloc(1))).toThrow(RangeError);
    opus[Symbol.dispose]();
    opus.free();
    expect(() => opus.encode(Buffer.alloc(960 * 2 * 2))).toThrow(/not ready/);
    expect(() => opus.decode(Buffer.from([1, 2, 3]))).toThrow(/not ready/);
  });

  it("supports explicit disposal", async () => {
    const encoder = await createEncoder();
    encoder[Symbol.dispose]();

    expect(() => encoder.encode(makeSineFrame(960, 2))).toThrow(/freed/);
  });

  it("accepts the frame durations each mode actually has", async () => {
    // MLow's durations are not a subset of Opus's: it has 120 ms and lacks 40.
    // The codec indexes its own set from two bits of the TOC and refuses
    // anything else with a bare internal error, so validating both against
    // Opus's list turned a valid request away and let an invalid one through
    // to a message that explained nothing.
    const mlow = [160, 320, 960, 1920]; // 10, 20, 60, 120 ms at 16 kHz
    for (const frameSize of mlow) {
      const encoder = await createEncoder({ ...MLOW_VOICE_OPTIONS, frameSize });
      try {
        const packet = encoder.encode(makeSineFrame(frameSize, 1));
        // frame duration is carried in bits 4-3 of the TOC
        expect((packet[0]! >> 3) & 3).toBe(mlow.indexOf(frameSize));
      } finally {
        encoder.free();
      }
    }

    await expect(
      createEncoder({ ...MLOW_VOICE_OPTIONS, frameSize: 640 }),
    ).rejects.toThrow(/frameSize/);

    await expect(
      createEncoder({ channels: 1, sampleRate: MLOW_SAMPLE_RATE, frameSize: 1920 }),
    ).rejects.toThrow(/frameSize/);
  });

  it("routes a captured Opus packet away from the MLow path", async () => {
    // Bit 7 is what separates the families on the wire: an MLow multiframe
    // marker is 0x82 | (toc & 0x39), so bit 7 is always set. This packet was
    // captured from a live call with the codec forced to plain Opus, and its
    // TOC is 0x5a — bit 7 clear, config 11, code 2.
    //
    // Worth a test because the two families share a transport and a port, and
    // nothing but this bit distinguishes them before parsing.
    const payload = new Uint8Array(
      Buffer.from(
        "5a6fed169c4a3277b8b29dcb6e047336718cabeeb8dae8611cc557a5bf7a33d0874e51" +
          "41e61d245ed17beadd87e272fac02379fdb870ff08d4ff3f74eb7caa16b8ee9d670b5" +
          "9d92ef14c01a20b849db2a37e7cdff99970141e7739d76cdaca5076cf4709bae7a4dc" +
          "4ddc06d17ae36215c2ea1c87f17bc3652e3c5c0d2bb96e839bcfc5964e571c8196785" +
          "24abb683382eadaaaa0b5b7080067deeecff8b599d566d4c630af9cd338e9bcf0b44f" +
          "3e59718a6acdbfb68d3b20df14ea78bc91b7282dece8f989af4ed4a48ae60f93555a4" +
          "bf23f10031a9cbe6ff7e3d404b877d273",
        "hex",
      ),
    );

    expect(payload[0]! & 0x80).toBe(0); // not MLow
    expect(payload[0]! >> 3).toBe(11); // SILK wideband
    expect(payload[0]! & 3).toBe(2); // two frames, VBR

    const info = await getPacketInfo(payload, { sampleRate: 48_000 });
    expect(info.frames).toBe(2);

    const decoder = await createDecoder({ channels: 1, sampleRate: 48_000 });
    try {
      expect(decoder.decode(payload, 5760)).toHaveLength(5760);
    } finally {
      decoder.free();
    }
  });

  it("parses a multiframe packet captured from a live call", async () => {
    // Taken off the wire in the clear: with the relay down, SRTP is never
    // applied to the buffer. Byte 0 of the payload was identical across six
    // consecutive sequence numbers, which a counter-mode keystream would have
    // randomised, so it is cleartext rather than assumed to be.
    //
    // 0x92 = 0x82 | (toc & 0x39) — the marker with the sub-frames' fixed
    // fields carried over. Both inner TOCs are 0x50 and agree with it, which
    // is what MLOW_TOC_FIXED_MASK requires; buffers that only looked like
    // packets failed exactly there.
    //
    // The tail is stale memory, so the audio is not checkable. The framing is.
    const wire = Buffer.from(
      "92026350d802dd57b030224a1802074e4fef0d42c2b8807d1e78a109ee96094f6d3a17c" +
        "c77cea85f16d96c66edf48d0a843182af275c90d99579a7489f683f0c60da6bd190478" +
        "74623c6c533f08280dcbf13258a78051646f5d2606e99a688e0b25351124be650e5027" +
        "8cc6f904d84dce7625ea1aca68ada72632234b89eec427d3dacbeb9fbbe14e12b20a9e" +
        "d1bbe591f0b28",
      "hex",
    );
    const packet = new Uint8Array(wire);

    expect(packet[0]! & 0x82).toBe(0x82);
    expect(packet[0]!).toBeLessThan(0xc0);
    expect(packet[1]! & 0x3f).toBe(2);

    const sizeOfFirst = packet[2]!;
    const firstToc = packet[3]!;
    const secondToc = packet[3 + sizeOfFirst]!;
    // rate, frame size and channel count are fixed across a packet
    expect(secondToc & 0x39).toBe(firstToc & 0x39);
    expect(packet[0]! & 0x39).toBe(firstToc & 0x39);

    const info = await getMlowPacketInfo(packet, { sampleRate: MLOW_SAMPLE_RATE });
    expect(info.frames).toBe(2);
    expect(info.samples).toBe(1920);

    // A second capture, at 20 ms rather than 60 — same structure, different
    // duration in the TOC, which is where the duration lives.
    const shorter = new Uint8Array(
      Buffer.from(
        "8a022348d7d42404a37c837de3af557aa86842a6ce75e4e571b5ece4911caa4e9e6144" +
          "d492c448e4e87180580aa66fbdaaae1c6d4ce88c967630f1e98824c34c630c72342cf10",
        "hex",
      ),
    );
    expect(shorter[0]! & 0x82).toBe(0x82);
    expect(shorter[1]! & 0x3f).toBe(2);
    expect((shorter[3]! >> 3) & 3).toBe(1); // 20 ms
    expect((shorter[0]! >> 3) & 3).toBe(1); // and the marker carries it
    const shortInfo = await getMlowPacketInfo(shorter, { sampleRate: MLOW_SAMPLE_RATE });
    expect(shortInfo.frames).toBe(2);
    expect(shortInfo.samples).toBe(640);

    const decoder = await createDecoder({
      channels: 1,
      sampleRate: MLOW_SAMPLE_RATE,
      useSmpl: true,
    });
    try {
      expect(decoder.decode(packet, 1920)).toHaveLength(1920);
      expect(decoder.decode(shorter, 640)).toHaveLength(640);
    } finally {
      decoder.free();
    }
  });

  it("refuses redundancy and discontinuous transmission together", async () => {
    // The codec asserts inside the secondary encoder when a silent frame does
    // not advance its counter, and an assert aborts the module rather than
    // returning an error — the whole instance is gone, not just the call.
    // Reachable from the public API by enabling both and feeding silence
    // followed by speech, so the combination is refused up front.
    const first = await createEncoder(MLOW_VOICE_OPTIONS);
    try {
      first.setDtx(true);
      expect(() => first.setSecondaryBitrate(6000)).toThrow(/discontinuous transmission/);
    } finally {
      first.free();
    }

    const second = await createEncoder(MLOW_VOICE_OPTIONS);
    try {
      second.setSecondaryBitrate(6000);
      expect(() => second.setDtx(true)).toThrow(/redundancy/);
    } finally {
      second.free();
    }

    // Either alone stays available.
    const third = await createEncoder(MLOW_VOICE_OPTIONS);
    try {
      expect(() => third.setSecondaryBitrate(6000)).not.toThrow();
    } finally {
      third.free();
    }

    const fourth = await createEncoder(MLOW_VOICE_OPTIONS);
    try {
      expect(() => fourth.setDtx(true)).not.toThrow();
    } finally {
      fourth.free();
    }
  });

  it("reads the frame count whatever flags accompany it", async () => {
    // Only the low six bits are the count, and it never exceeds 18. The client
    // sets the top two — bit 6 marks padding before the size table, bit 7 for a
    // purpose we have not identified — and reading the byte whole puts a
    // three-frame packet at 131 or 195, outside the 2..18 a parser accepts.
    //
    // Inspecting a packet has to tolerate exactly what decoding it tolerates:
    // this went the other way once, where decode stripped the flags and
    // inspection did not, so a packet decoded fine and could not be described.
    const encoder = await createEncoder(MLOW_VOICE_OPTIONS);
    const repacketizer = await createRepacketizer();
    try {
      const frames = [0, 1, 2].map(() =>
        encoder.encode(makeSineFrame(encoder.frameSize, encoder.channels)),
      );
      const packet = repacketizer.pack(frames);
      const count = packet[1]! & 0x3f;

      for (const flags of [0x00, 0x40, 0x80, 0xc0]) {
        const probe = Uint8Array.from(packet);
        probe[1] = count | flags;
        const info = await getMlowPacketInfo(probe, { sampleRate: MLOW_SAMPLE_RATE });
        expect(info.frames).toBe(3);
        expect(info.samples).toBe(encoder.frameSize * 3);
      }
    } finally {
      encoder.free();
      repacketizer.free();
    }
  });

  it("packs MLow frames into one multiframe packet", async () => {
    const encoder = await createEncoder(MLOW_VOICE_OPTIONS);
    const repacketizer = await createRepacketizer();
    try {
      const frames = [0, 1, 2].map(() =>
        encoder.encode(makeSineFrame(encoder.frameSize, encoder.channels)),
      );

      const packet = repacketizer.pack(frames);
      const info = await getMlowPacketInfo(packet, { sampleRate: MLOW_SAMPLE_RATE });

      expect(info.frames).toBe(3);
      expect(info.samples).toBe(encoder.frameSize * 3);

      // 0x8a = 0x82 multiframe marker, plus the fixed bits carried over from the
      // sub-frames' TOC (0x39 = rate, frame length, stereo) — 16 kHz, 20 ms,
      // mono. The two assertions below are the client's own acceptance gate,
      // read out of its decompiled parser: a packet is treated as multiframe iff
      // (b0 & 0x82) == 0x82 and b0 < 0xC0. Pinning the exact byte guards against
      // silently drifting to a value that still passes the gate but describes a
      // different rate or frame length.
      expect(packet[0]).toBe(0x8a);
      expect(packet[0]! & 0x82).toBe(0x82);
      expect(packet[0]!).toBeLessThan(0xc0);

      // What we emit carries no flags, so the byte is the count on its own:
      // opus_smpl_repacketizer.c:145 writes it raw and opus_smpl_decode.c:122
      // reads it raw. What we *accept* is wider than that, because the client
      // does set the top two bits — see the test below.
      expect(packet[1]).toBe(3);
    } finally {
      encoder.free();
      repacketizer.free();
    }
  });

  it("decodes a packed multiframe packet back to every frame", async () => {
    const encoder = await createEncoder(MLOW_VOICE_OPTIONS);
    const decoder = await createDecoder({
      channels: 1,
      maxFrameSize: MLOW_FRAME_SIZE * 3,
      sampleRate: MLOW_SAMPLE_RATE,
      useSmpl: true,
    });
    const repacketizer = await createRepacketizer();
    try {
      const frames = [0, 1, 2].map(() =>
        encoder.encode(makeSineFrame(encoder.frameSize, encoder.channels)),
      );
      const packet = repacketizer.pack(frames);

      // On the normal decode path capacity comes from maxFrameSize; frameSize
      // only applies to PLC and FEC.
      const decoded = decoder.decode(packet, { maxFrameSize: MLOW_FRAME_SIZE * 3 });

      expect(decoded.length).toBe(MLOW_FRAME_SIZE * 3);
    } finally {
      encoder.free();
      decoder.free();
      repacketizer.free();
    }
  });

  it("packs incrementally through add/out", async () => {
    const encoder = await createEncoder(MLOW_VOICE_OPTIONS);
    const repacketizer = await createRepacketizer();
    try {
      repacketizer.reset();
      for (let i = 0; i < 3; i += 1) {
        repacketizer.add(encoder.encode(makeSineFrame(encoder.frameSize, encoder.channels)));
      }

      expect(repacketizer.getFrameCount()).toBe(3);

      const packet = repacketizer.out();
      const info = await getMlowPacketInfo(packet, { sampleRate: MLOW_SAMPLE_RATE });

      expect(info.frames).toBe(3);
    } finally {
      encoder.free();
      repacketizer.free();
    }
  });

  it("keeps each add()ed frame's bytes distinct until out()", async () => {
    // opus_repacketizer_cat() stores pointers into the caller's buffer instead
    // of copying, so reusing one staging address would make every frame alias
    // the last one. Distinct payloads catch that.
    const encoder = await createEncoder(MLOW_VOICE_OPTIONS);
    const repacketizer = await createRepacketizer();
    try {
      const frames = [220, 440, 880].map((freq) =>
        encoder.encode(makeSineFrame(encoder.frameSize, encoder.channels, freq)),
      );
      const viaPack = repacketizer.pack(frames);

      repacketizer.reset();
      for (const frame of frames) {
        repacketizer.add(frame);
      }
      const viaAdd = repacketizer.out();

      // Both routes pack the same three frames, so the bytes must match.
      expect(Array.from(viaAdd)).toEqual(Array.from(viaPack));
    } finally {
      encoder.free();
      repacketizer.free();
    }
  });

  it("decodes a multiframe packet that carries the size-table bit", async () => {
    // WhatsApp's encoder sets bit 6 of the frame-count byte when per-frame sizes
    // follow; opus_mlow's parser reads that byte whole and rejects anything over
    // 18, so a three-frame packet arrives as 0x43 (67) and is refused. The
    // decoder clears the flag in its staged copy before parsing.
    const encoder = await createEncoder(MLOW_VOICE_OPTIONS);
    const decoderOptions = {
      channels: 1,
      maxFrameSize: MLOW_FRAME_SIZE * 3,
      sampleRate: MLOW_SAMPLE_RATE,
      useSmpl: true,
    } as const;
    // Decoders are stateful, so each variant needs its own instance.
    const plainDecoder = await createDecoder(decoderOptions);
    const flaggedDecoder = await createDecoder(decoderOptions);
    const repacketizer = await createRepacketizer();
    try {
      const frames = [220, 440, 880].map((freq) =>
        encoder.encode(makeSineFrame(encoder.frameSize, encoder.channels, freq)),
      );
      const packet = repacketizer.pack(frames);

      // Same packet as the client would send it, with the flag set.
      const clientStyle = Uint8Array.from(packet);
      clientStyle[1] = (clientStyle[1] as number) | 0x40;
      expect(clientStyle[1]).toBe(0x43);

      const expected = plainDecoder.decode(packet, { maxFrameSize: MLOW_FRAME_SIZE * 3 });
      const decoded = flaggedDecoder.decode(clientStyle, { maxFrameSize: MLOW_FRAME_SIZE * 3 });

      expect(decoded.length).toBe(MLOW_FRAME_SIZE * 3);
      // The caller's buffer must be left alone.
      expect(clientStyle[1]).toBe(0x43);
      // And the flag must not change what comes out.
      expect(Array.from(decoded)).toEqual(Array.from(expected));
    } finally {
      encoder.free();
      plainDecoder.free();
      flaggedDecoder.free();
      repacketizer.free();
    }
  });

  it("refuses the flagged packet without the fix", async () => {
    // Guards the fix itself: with the bit left in place the upstream parser sees
    // a frame count of 67 and rejects the packet. useSmpl: false skips the
    // normalisation, which is what a pre-fix decoder did.
    const encoder = await createEncoder(MLOW_VOICE_OPTIONS);
    const rawDecoder = await createDecoder({
      channels: 1,
      maxFrameSize: MLOW_FRAME_SIZE * 3,
      sampleRate: MLOW_SAMPLE_RATE,
    });
    const repacketizer = await createRepacketizer();
    try {
      const frames = [220, 440, 880].map((freq) =>
        encoder.encode(makeSineFrame(encoder.frameSize, encoder.channels, freq)),
      );
      const clientStyle = Uint8Array.from(repacketizer.pack(frames));
      clientStyle[1] = (clientStyle[1] as number) | 0x40;

      expect(() => rawDecoder.decode(clientStyle, { maxFrameSize: MLOW_FRAME_SIZE * 3 })).toThrow(
        OpusError,
      );
    } finally {
      encoder.free();
      rawDecoder.free();
      repacketizer.free();
    }
  });

  it("rejects more frames than one MLow packet can carry", async () => {
    const encoder = await createEncoder(MLOW_VOICE_OPTIONS);
    const repacketizer = await createRepacketizer();
    try {
      const frame = encoder.encode(makeSineFrame(encoder.frameSize, encoder.channels));
      const tooMany = Array.from({ length: 19 }, () => frame);

      expect(() => repacketizer.pack(tooMany)).toThrow(/at most 18/);
      expect(() => repacketizer.pack([])).toThrow(/must not be empty/);
    } finally {
      encoder.free();
      repacketizer.free();
    }
  });

  it("rejects use after free", async () => {
    const repacketizer = await createRepacketizer();
    repacketizer.free();

    expect(() => repacketizer.getFrameCount()).toThrow(/freed/);
  });

  // Both codecs are stateful, so the same input twice through one instance
  // gives different output. These compare two instances driven identically.
  it("encodeInto matches encode without allocating", async () => {
    const viaEncode = await createEncoder(MLOW_VOICE_OPTIONS);
    const viaEncodeInto = await createEncoder(MLOW_VOICE_OPTIONS);
    try {
      const target = new Uint8Array(4000);
      for (let i = 0; i < 4; i += 1) {
        const pcm = makeSineFrame(viaEncode.frameSize, viaEncode.channels, i + 1);
        const expected = viaEncode.encode(pcm);
        const written = viaEncodeInto.encodeInto(pcm, target);

        expect(written).toBe(expected.byteLength);
        expect(Array.from(target.subarray(0, written))).toEqual(Array.from(expected));
      }
    } finally {
      viaEncode.free();
      viaEncodeInto.free();
    }
  });

  it("decodeInto matches decode and reports samples per channel", async () => {
    const encoder = await createEncoder({ channels: 2, frameSize: 960, sampleRate: 48_000 });
    const viaDecode = await createDecoder({ channels: 2, sampleRate: 48_000 });
    const viaDecodeInto = await createDecoder({ channels: 2, sampleRate: 48_000 });
    try {
      const target = new Int16Array(960 * 2);
      for (let i = 0; i < 4; i += 1) {
        const packet = encoder.encode(makeSineFrame(960, 2, i + 1));
        const expected = viaDecode.decode(packet);
        const samples = viaDecodeInto.decodeInto(target, packet);

        expect(samples).toBe(960);
        expect(Array.from(target.subarray(0, samples * 2))).toEqual(Array.from(expected));
      }
    } finally {
      viaDecode.free();
      viaDecodeInto.free();
      encoder.free();
    }
  });

  it("rejects an undersized target buffer", async () => {
    const encoder = await createEncoder({ channels: 2, frameSize: 960, sampleRate: 48_000 });
    const decoder = await createDecoder({ channels: 2, sampleRate: 48_000 });
    try {
      const packet = encoder.encode(makeSineFrame(960, 2));

      expect(() => decoder.decodeInto(new Int16Array(4), packet)).toThrow(/target holds/);
      expect(() => encoder.encodeInto(makeSineFrame(960, 2), new Uint8Array(1))).toThrow(
        /target holds/,
      );
    } finally {
      decoder.free();
      encoder.free();
    }
  });

  it("still conceals packet loss after the decode refactor", async () => {
    const encoder = await createEncoder(MLOW_VOICE_OPTIONS);
    const decoder = await createDecoder({
      channels: 1,
      sampleRate: MLOW_SAMPLE_RATE,
      useSmpl: true,
    });
    try {
      // Prime the decoder so concealment has history to work from.
      decoder.decode(encoder.encode(makeSineFrame(encoder.frameSize, encoder.channels)));

      const concealed = decoder.decodePacketLoss(MLOW_FRAME_SIZE);
      const viaNull = decoder.decode(null, { frameSize: MLOW_FRAME_SIZE });

      expect(concealed.length).toBe(MLOW_FRAME_SIZE);
      expect(viaNull.length).toBe(MLOW_FRAME_SIZE);
    } finally {
      decoder.free();
      encoder.free();
    }
  });

  it("labels the coding mode of an MLow packet", async () => {
    const encoder = await createEncoder(MLOW_VOICE_OPTIONS);
    try {
      const packet = encoder.encode(makeSineFrame(encoder.frameSize, encoder.channels));
      const info = await getMlowPacketInfo(packet, { sampleRate: MLOW_SAMPLE_RATE });

      expect(info.toc.mode).toBe(MlowMode.Smpl);
      // Bits 7-6 of the TOC are what decides; 0b11 would mean CELT.
      expect(packet[0]! >> 6).not.toBe(3);
    } finally {
      encoder.free();
    }
  });

  it("encodes a RED secondary payload alongside the main packet", async () => {
    const encoder = await createEncoder(MLOW_VOICE_OPTIONS);
    try {
      encoder.setSecondaryBitrate(4_000);
      encoder.setSecondaryComplexity(3);

      for (let i = 0; i < 4; i += 1) {
        encoder.encode(makeSineFrame(encoder.frameSize, encoder.channels, i + 1));
        const redundant = encoder.encodeSecondary();

        expect(redundant.byteLength).toBeGreaterThan(0);
      }
    } finally {
      encoder.free();
    }
  });

  it("refuses RED calls that would abort the wasm module", async () => {
    // The codec asserts that the primary encoder stays ahead of the secondary,
    // and that assert aborts the entire module rather than returning an error.
    // These two misuse patterns are the ones that trip it.
    const encoder = await createEncoder(MLOW_VOICE_OPTIONS);
    try {
      encoder.setSecondaryBitrate(4_000);

      encoder.encode(makeSineFrame(encoder.frameSize, encoder.channels));
      encoder.encodeSecondary();
      expect(() => encoder.encodeSecondary()).toThrow(/exactly one encode/);

      // A gap also breaks it: the codec zeroes both counters on a large skew.
      encoder.encode(makeSineFrame(encoder.frameSize, encoder.channels));
      encoder.encode(makeSineFrame(encoder.frameSize, encoder.channels));
      expect(() => encoder.encodeSecondary()).toThrow(/2 encode\(\) calls/);

      // The encoder is still usable afterwards — nothing was torn down.
      expect(encoder.encode(makeSineFrame(encoder.frameSize, encoder.channels)).byteLength)
        .toBeGreaterThan(0);
    } finally {
      encoder.free();
    }
  });
});

const MLOW_SAMPLE_RATE = 16_000 as const;
const MLOW_FRAME_SIZE = 320; // 20 ms — the native MLow frame WhatsApp emits.
const MLOW_VOICE_OPTIONS = {
  application: Application.Voip,
  bitrate: 8_000,
  channels: 1,
  frameSize: MLOW_FRAME_SIZE,
  sampleRate: MLOW_SAMPLE_RATE,
  signal: Signal.Voice,
  useSmpl: true,
} as const;

function makeSineFrame(frameSize: number, channels: 1 | 2, cycles = 1): Int16Array {
  const pcm = new Int16Array(frameSize * channels);
  for (let sample = 0; sample < frameSize; sample += 1) {
    const value = Math.round(Math.sin((sample / frameSize) * Math.PI * 2 * cycles) * 8000);
    for (let channel = 0; channel < channels; channel += 1) {
      pcm[sample * channels + channel] = value;
    }
  }
  return pcm;
}

function makeSineFloatFrame(frameSize: number, channels: 1 | 2): Float32Array {
  const pcm = new Float32Array(frameSize * channels);
  for (let sample = 0; sample < frameSize; sample += 1) {
    const value = Math.sin((sample / frameSize) * Math.PI * 2) * 0.25;
    for (let channel = 0; channel < channels; channel += 1) {
      pcm[sample * channels + channel] = value;
    }
  }
  return pcm;
}
