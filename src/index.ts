import createLibmlowModule from "./generated/libmlow.generated.mjs";

export const Application = {
  Voip: 2048,
  Audio: 2049,
  RestrictedLowDelay: 2051,
} as const;

export const Signal = {
  Auto: -1000,
  Voice: 3001,
  Music: 3002,
} as const;

export const Bitrate = {
  Auto: -1000,
  Max: -1,
} as const;

export const Bandwidth = {
  Narrowband: 1101,
  Mediumband: 1102,
  Wideband: 1103,
  Superwideband: 1104,
  Fullband: 1105,
} as const;

export const EncoderCtl = {
  SetApplication: 4000,
  SetBitrate: 4002,
  SetMaxBandwidth: 4004,
  SetVbr: 4006,
  SetBandwidth: 4008,
  SetComplexity: 4010,
  SetInBandFec: 4012,
  SetPacketLossPercent: 4014,
  SetDtx: 4016,
  SetVbrConstraint: 4020,
  SetForceChannels: 4022,
  SetSignal: 4024,
  SetLsbDepth: 4036,
  SetExpertFrameDuration: 4040,
  SetPredictionDisabled: 4042,
  SetPhaseInversionDisabled: 4046,
  SetUseSmpl: 4050,
  SetEncHpCutoff: 4052,
  SetSecondaryComplexity: 4054,
  SetSecondaryBitrate: 4056,
  SetMlowSubframeImp: 4060,
  SetMlowUseSpActFlat: 4062,
  SetMlowVadNlUpdSpeed: 4064,
  SetMlowVadNonBinary: 4066,
  SetMlowVadHpSharpness: 4068,
  SetMlowUseFecRateComp: 4070,
} as const;

/**
 * Which coding mode a packet's TOC selects. The first byte decides: bits 7-6
 * equal to `0b11` mean CELT, anything else means the native SMPL/MLow layout.
 * This is the field that tells a WhatsApp-style MLow packet apart from a CELT
 * fallback.
 */
export const MlowMode = {
  Celt: 3,
  Smpl: 4,
} as const;

export const DecoderCtl = {
  SetGain: 4034,
  SetPhaseInversionDisabled: 4046,
  SetUseLpcPostfilter: 4058,
  SetUseSmpl: 4050,
} as const;

export type Application = (typeof Application)[keyof typeof Application];
export type Signal = (typeof Signal)[keyof typeof Signal];
export type Bitrate = number | "auto" | "max";
export type Bandwidth = (typeof Bandwidth)[keyof typeof Bandwidth];
export type SampleRate = 8000 | 12000 | 16000 | 24000 | 48000;
export type ChannelCount = 1 | 2;

export type CodecOptions = {
  channels?: ChannelCount;
  sampleRate?: SampleRate;
};

export type EncoderOptions = CodecOptions & {
  application?: Application;
  bitrate?: Bitrate;
  complexity?: number;
  dtx?: boolean;
  fec?: boolean;
  frameSize?: number;
  maxBandwidth?: Bandwidth;
  packetLossPercent?: number;
  signal?: Signal;
  useSmpl?: boolean;
  vbr?: boolean;
  vbrConstraint?: boolean;
};

export type DecoderOptions = CodecOptions & {
  maxFrameSize?: number;
  useLpcPostfilter?: boolean;
  useSmpl?: boolean;
};

export type DecodeOptions = {
  decodeFec?: boolean;
  frameSize?: number;
  maxFrameSize?: number;
};

export type RepacketizerOptions = {
  maxPacketBytes?: number;
  useMlow?: boolean;
};

export type PackOptions = {
  maxPacketBytes?: number;
};

export type EncodeOptions = {
  frameSize?: number;
  maxPacketBytes?: number;
};

export type PacketInfoOptions = {
  sampleRate?: SampleRate;
};

export type OpusPacketInfo = {
  readonly bandwidth: Bandwidth;
  readonly channels: ChannelCount;
  readonly durationMs: number;
  readonly frames: number;
  readonly samples: number;
  readonly samplesPerFrame: number;
  readonly sampleRate: SampleRate;
};

export type MlowMode = (typeof MlowMode)[keyof typeof MlowMode];

export type MlowPacketToc = {
  /**
   * Compare against {@link MlowMode}: `MlowMode.Smpl` for a native MLow packet,
   * `MlowMode.Celt` otherwise. Stays `number` so the field keeps accepting any
   * future mode the codec adds.
   */
  readonly mode: number;
  readonly bandwidth: number;
  readonly samplesPerFrame: number;
  readonly stereo: number;
};

export type MlowPacketInfo = OpusPacketInfo & {
  readonly hasVadFlag: boolean;
  readonly hasFecContent: boolean;
  readonly toc: MlowPacketToc;
};

export type OpusEncoderHandle = {
  readonly application: Application;
  readonly channels: ChannelCount;
  readonly frameSize: number;
  readonly sampleRate: SampleRate;
  encode(pcm: Int16Array | Uint8Array, options?: EncodeOptions): Uint8Array;
  encodeFloat(pcm: Float32Array, options?: EncodeOptions): Uint8Array;
  encodeFrames(frames: readonly (Int16Array | Uint8Array)[], options?: EncodeOptions): Uint8Array[];
  encodeFloatFrames(frames: readonly Float32Array[], options?: EncodeOptions): Uint8Array[];
  /**
   * Encodes the redundant (RED) copy of the frame just passed to {@link encode}.
   * Call it right after `encode()` on the same frame. Requires `useSmpl` plus a
   * secondary bitrate — see `setSecondaryBitrate`.
   */
  /**
   * Encodes into a caller-owned buffer and returns the byte count, allocating
   * nothing. Use it when per-frame garbage matters; `encode()` is the same work
   * plus a fresh `Uint8Array` each call.
   */
  encodeInto(pcm: Int16Array | Uint8Array, target: Uint8Array, options?: EncodeOptions): number;
  encodeFloatInto(pcm: Float32Array, target: Uint8Array, options?: EncodeOptions): number;
  encodeSecondary(options?: EncodeOptions): Uint8Array;
  setSecondaryBitrate(bitrate: number): void;
  setSecondaryComplexity(complexity: number): void;
  readonly useSmpl: boolean;
  encoderCtl(request: number, value: number): void;
  free(): void;
  getBitrate(): number;
  getInDtx(): boolean;
  getLookahead(): number;
  setBitrate(bitrate: Bitrate): void;
  setComplexity(complexity: number): void;
  setDtx(enabled: boolean): void;
  setFec(enabled: boolean): void;
  setMaxBandwidth(bandwidth: Bandwidth): void;
  setPacketLossPercent(percentage: number): void;
  setSignal(signal: Signal): void;
  setVbr(enabled: boolean): void;
  setVbrConstraint(enabled: boolean): void;
  [Symbol.dispose](): void;
};

export type MlowRepacketizerHandle = {
  readonly useMlow: boolean;
  /** Packs frames into one multiframe packet in a single WASM call. */
  pack(frames: readonly Uint8Array[], options?: PackOptions): Uint8Array;
  /** Clears the queued frames so the state can be reused. */
  reset(): void;
  /** Queues one frame for the next {@link out} call. */
  add(frame: Uint8Array): void;
  /** Number of frames queued so far. */
  getFrameCount(): number;
  /** Emits every queued frame as one packet. */
  out(options?: PackOptions): Uint8Array;
  /** Emits `[begin, end)` of the queued frames as one packet. */
  outRange(begin: number, end: number, options?: PackOptions): Uint8Array;
  free(): void;
  [Symbol.dispose](): void;
};

export type OpusDecoderHandle = {
  readonly channels: ChannelCount;
  readonly maxFrameSize: number;
  readonly sampleRate: SampleRate;
  decode(packet: Uint8Array | null, options?: DecodeOptions): Int16Array;
  decodeFloat(packet: Uint8Array | null, options?: DecodeOptions): Float32Array;
  /**
   * Decodes into a caller-owned buffer and returns the sample count (per
   * channel), allocating nothing. `decode()` is the same work plus a fresh
   * `Int16Array` each call — at 48 kHz stereo that is 3,840 bytes per frame.
   */
  decodeInto(target: Int16Array, packet: Uint8Array | null, options?: DecodeOptions): number;
  decodeFloatInto(target: Float32Array, packet: Uint8Array | null, options?: DecodeOptions): number;
  decodeFrames(packets: readonly (Uint8Array | null)[], options?: DecodeOptions): Int16Array[];
  decodeFloatFrames(packets: readonly (Uint8Array | null)[], options?: DecodeOptions): Float32Array[];
  readonly useSmpl: boolean;
  decodePacketLoss(frameSize?: number): Int16Array;
  decodePacketLossFloat(frameSize?: number): Float32Array;
  decoderCtl(request: number, value: number): void;
  free(): void;
  [Symbol.dispose](): void;
};

const DEFAULT_CHANNELS = 2 satisfies ChannelCount;
const DEFAULT_FRAME_DURATION_MS = 20;
const MAX_PACKET_DURATION_MS = 120;
const DEFAULT_MAX_PACKET_BYTES = 4000;
const DEFAULT_SAMPLE_RATE = 48_000 satisfies SampleRate;
const BANDWIDTH_VALUES = new Set<number>(Object.values(Bandwidth));
const SIGNAL_VALUES = new Set<number>(Object.values(Signal));
const DECODER_INTEGER_CTL_REQUESTS = new Set<number>(Object.values(DecoderCtl));
const ENCODER_INTEGER_CTL_REQUESTS = new Set<number>(Object.values(EncoderCtl));
const ENCODE_FRAME_DURATIONS_MS = [2.5, 5, 10, 20, 40, 60] as const;
/* MLow's own set, which is not a subset of Opus's: it has 120 ms and lacks 40.
   The codec indexes it from two bits of the TOC and refuses anything else with
   a bare internal error, so the two must be distinguished here or a caller
   asking for 40 ms gets told nothing useful, and one asking for 120 ms — which
   the codec encodes happily — is turned away for no reason. */
const MLOW_FRAME_DURATIONS_MS = [10, 20, 60, 120] as const;
/** `MAX_MLOW_FRAMES_PER_PACKET` in opus_smpl_repacketizer.h — 18 frames, up to 180 ms. */
const MAX_MLOW_FRAMES_PER_PACKET = 18;
const VALID_SAMPLE_RATES: readonly SampleRate[] = [8000, 12000, 16000, 24000, 48000];

type LibmlowModule = Awaited<ReturnType<typeof createLibmlowModule>>;
type NormalizedRepacketizerOptions = {
  maxPacketBytes: number;
  useMlow: boolean;
};
type NormalizedEncoderOptions = {
  application: Application;
  bitrate: number;
  channels: ChannelCount;
  complexity: number;
  dtx: boolean;
  fec: boolean;
  frameSize: number;
  maxBandwidth: Bandwidth | undefined;
  packetLossPercent: number;
  sampleRate: SampleRate;
  signal: Signal;
  useSmpl: boolean;
  vbr: boolean | undefined;
  vbrConstraint: boolean | undefined;
};

type NormalizedDecoderOptions = {
  channels: ChannelCount;
  maxFrameSize: number;
  sampleRate: SampleRate;
  useLpcPostfilter: boolean | undefined;
  useSmpl: boolean;
};

let modulePromise: Promise<LibmlowModule> | undefined;
let smplGlobalsReady = false;

export async function opusGlobalCreate(): Promise<void> {
  const module = await getModule();
  module._oc_global_create();
  smplGlobalsReady = true;
}

export async function opusGlobalFree(): Promise<void> {
  const module = await getModule();
  module._oc_global_free();
  smplGlobalsReady = false;
}

async function ensureSmplGlobals(): Promise<void> {
  if (smplGlobalsReady) {
    return;
  }
  const module = await getModule();
  ensureSmplGlobalsSync(module);
}

function ensureSmplGlobalsSync(module: LibmlowModule): void {
  if (smplGlobalsReady) {
    return;
  }
  module._oc_global_create();
  smplGlobalsReady = true;
}

export async function loadLibopus(): Promise<{
  version: string;
}> {
  const module = await getModule();
  return { version: module.UTF8ToString(module._oc_get_version_string()) };
}

export async function createEncoder(options: EncoderOptions = {}): Promise<OpusEncoderHandle> {
  const normalized = normalizeEncoderOptions(options);
  if (normalized.useSmpl) {
    await ensureSmplGlobals();
  }
  const module = await getModule();
  return new WasmOpusEncoder(module, normalized);
}

/**
 * Creates a repacketizer that packs several MLow frames into one multiframe
 * packet — the framing WhatsApp calls use (3×20 ms per packet is typical).
 * `opus_encode` does not do this on the SMPL path, so packing is the only way
 * to produce interoperable multiframe packets.
 */
export async function createRepacketizer(
  options: RepacketizerOptions = {},
): Promise<MlowRepacketizerHandle> {
  const normalized = normalizeRepacketizerOptions(options);
  if (normalized.useMlow) {
    await ensureSmplGlobals();
  }
  const module = await getModule();
  return new WasmMlowRepacketizer(module, normalized);
}

export async function createDecoder(options: DecoderOptions = {}): Promise<OpusDecoderHandle> {
  const normalized = normalizeDecoderOptions(options);
  if (normalized.useSmpl) {
    await ensureSmplGlobals();
  }
  const module = await getModule();
  return new WasmOpusDecoder(module, normalized);
}

export async function getPacketInfo(
  packet: Uint8Array,
  options: PacketInfoOptions = {},
): Promise<OpusPacketInfo> {
  const sampleRate = options.sampleRate ?? DEFAULT_SAMPLE_RATE;
  validateCodecOptions({ channels: DEFAULT_CHANNELS, sampleRate });
  if (packet.byteLength === 0) {
    throw new RangeError("packet must not be empty");
  }
  const module = await getModule();
  const scratch = packetScratch(module, packet);
  const code = module._oc_packet_info(scratch.packetPtr, packet.byteLength, sampleRate, scratch.outPtr);
  if (code < 0) {
    throw createOpusError(module, code, "getPacketInfo");
  }
  const out = scratch.outPtr >> 2;
  const heap = module.HEAP32;
  const channels = heap[out + 3];
  if (channels !== 1 && channels !== 2) {
    throw new OpusError(
      channels ?? 0,
      `libmlow getPacketInfo failed (${channels}): invalid channel count`,
    );
  }
  const bandwidth = heap[out + 4] as Bandwidth;
  validateBandwidth(bandwidth, "packet bandwidth");
  const samples = heap[out + 1] as number;
  return {
    bandwidth,
    channels,
    durationMs: (samples / sampleRate) * 1000,
    frames: heap[out] as number,
    samples,
    samplesPerFrame: heap[out + 2] as number,
    sampleRate,
  };
}

/**
 * Module-scoped staging for packet inspection. These used to malloc/free per
 * call; the buffers only grow, so a receiver inspecting every packet stops
 * churning the allocator.
 */
const PACKET_INFO_FIELDS = 11;
let infoPacketPtr = 0;
let infoPacketBytes = 0;
let infoOutPtr = 0;

function packetScratch(
  module: LibmlowModule,
  packet: Uint8Array,
): { packetPtr: number; outPtr: number } {
  if (infoOutPtr === 0) {
    infoOutPtr = checkedMalloc(module, PACKET_INFO_FIELDS * 4);
  }
  if (infoPacketPtr === 0 || infoPacketBytes < packet.byteLength) {
    if (infoPacketPtr !== 0) {
      module._free(infoPacketPtr);
    }
    infoPacketPtr = checkedMalloc(module, packet.byteLength);
    infoPacketBytes = packet.byteLength;
  }
  module.HEAPU8.set(packet, infoPacketPtr);
  return { packetPtr: infoPacketPtr, outPtr: infoOutPtr };
}

export async function getMlowPacketInfo(
  packet: Uint8Array,
  options: PacketInfoOptions = {},
): Promise<MlowPacketInfo> {
  const sampleRate = options.sampleRate ?? DEFAULT_SAMPLE_RATE;
  validateCodecOptions({ channels: DEFAULT_CHANNELS, sampleRate });
  if (packet.byteLength === 0) {
    throw new RangeError("packet must not be empty");
  }
  const module = await getModule();
  const scratch = packetScratch(module, packet);
  const code = module._oc_mlow_packet_info(
    scratch.packetPtr,
    packet.byteLength,
    sampleRate,
    scratch.outPtr,
  );
  if (code < 0) {
    throw createOpusError(module, code, "getMlowPacketInfo");
  }
  const out = scratch.outPtr >> 2;
  const heap = module.HEAP32;
  const channels = heap[out + 3];
  if (channels !== 1 && channels !== 2) {
    throw new OpusError(
      channels ?? 0,
      `libmlow getMlowPacketInfo failed (${channels}): invalid channel count`,
    );
  }
  const bandwidth = heap[out + 4] as Bandwidth;
  validateBandwidth(bandwidth, "packet bandwidth");
  const samples = heap[out + 1] as number;
  return {
    bandwidth,
    channels,
    durationMs: (samples / sampleRate) * 1000,
    frames: heap[out] as number,
    hasFecContent: heap[out + 6] !== 0,
    hasVadFlag: heap[out + 5] !== 0,
    samples,
    samplesPerFrame: heap[out + 2] as number,
    sampleRate,
    toc: {
      mode: heap[out + 7] ?? 0,
      bandwidth: heap[out + 8] ?? 0,
      samplesPerFrame: heap[out + 9] ?? 0,
      stereo: heap[out + 10] ?? 0,
    },
  };
}

class WasmOpusEncoder implements OpusEncoderHandle {
  readonly application: Application;
  readonly channels: ChannelCount;
  readonly frameSize: number;
  readonly sampleRate: SampleRate;
  /* Which set of frame durations applies, among other things — MLow's are not
     a subset of Opus's. The decoder already exposed this. */
  readonly useSmpl: boolean;
  #framesSinceSecondary = 0;
  /* Redundancy and discontinuous transmission cannot both be on. The codec
     asserts inside the secondary encoder when a silent frame fails to advance
     its counter, and an assert here aborts the whole module rather than
     returning an error — the instance is gone, not just the call. Reachable
     from the public API with silence followed by speech, so it is refused
     before it can happen. */
  #dtxEnabled = false;
  #secondaryEnabled = false;
  #freed = false;
  #module: LibmlowModule;
  #packetBytes = 0;
  #packetPtr = 0;
  #pcmBytes = 0;
  #pcmPtr = 0;
  #ptr: number;

  constructor(module: LibmlowModule, options: NormalizedEncoderOptions) {
    this.#module = module;
    this.application = options.application;
    this.channels = options.channels;
    this.frameSize = options.frameSize;
    this.sampleRate = options.sampleRate;
    this.useSmpl = options.useSmpl;
    const errorPtr = checkedMalloc(module, 4);
    try {
      const ptr = module._oc_create_encoder(
        options.sampleRate,
        options.channels,
        options.application,
        errorPtr,
      );
      const error = module.HEAP32[errorPtr >> 2] ?? 0;
      if (!ptr || error !== 0) {
        throw createOpusError(module, error, "createEncoder");
      }
      this.#ptr = ptr;
    } finally {
      module._free(errorPtr);
    }
    // From here the encoder owns WASM memory, so any failure below has to
    // release it rather than leaking the state.
    try {
      this.setBitrate(options.bitrate);
      this.setComplexity(options.complexity);
      this.setDtx(options.dtx);
      this.setFec(options.fec);
      if (options.maxBandwidth !== undefined) {
        this.setMaxBandwidth(options.maxBandwidth);
      }
      this.setPacketLossPercent(options.packetLossPercent);
      this.setSignal(options.signal);
      if (options.vbr !== undefined) {
        this.setVbr(options.vbr);
      }
      if (options.vbrConstraint !== undefined) {
        this.setVbrConstraint(options.vbrConstraint);
      }
      if (options.useSmpl) {
        this.encoderCtl(EncoderCtl.SetLsbDepth, 16);
        this.encoderCtl(EncoderCtl.SetUseSmpl, 1);
      }
      // Pre-size the scratch buffers so the hot path never calls malloc, which
      // keeps memory growth out of encode() entirely.
      this.#ensurePcmBytes(options.frameSize * options.channels * 4);
      this.#ensurePacketBytes(DEFAULT_MAX_PACKET_BYTES);
    } catch (error) {
      this.#freeScratch();
      module._oc_destroy_encoder(this.#ptr);
      this.#freed = true;
      throw error;
    }
  }

  encode(pcm: Int16Array | Uint8Array, options: EncodeOptions = {}): Uint8Array {
    const encodedBytes = this.#encodeToScratch(pcm, options);
    return this.#module.HEAPU8.slice(this.#packetPtr, this.#packetPtr + encodedBytes);
  }

  encodeInto(pcm: Int16Array | Uint8Array, target: Uint8Array, options: EncodeOptions = {}): number {
    const encodedBytes = this.#encodeToScratch(pcm, options);
    if (target.byteLength < encodedBytes) {
      throw new RangeError(
        `target holds ${target.byteLength} bytes; the packet needs ${encodedBytes}`,
      );
    }
    target.set(this.#module.HEAPU8.subarray(this.#packetPtr, this.#packetPtr + encodedBytes));
    return encodedBytes;
  }

  encodeFloat(pcm: Float32Array, options: EncodeOptions = {}): Uint8Array {
    const encodedBytes = this.#encodeFloatToScratch(pcm, options);
    return this.#module.HEAPU8.slice(this.#packetPtr, this.#packetPtr + encodedBytes);
  }

  encodeFloatInto(pcm: Float32Array, target: Uint8Array, options: EncodeOptions = {}): number {
    const encodedBytes = this.#encodeFloatToScratch(pcm, options);
    if (target.byteLength < encodedBytes) {
      throw new RangeError(
        `target holds ${target.byteLength} bytes; the packet needs ${encodedBytes}`,
      );
    }
    target.set(this.#module.HEAPU8.subarray(this.#packetPtr, this.#packetPtr + encodedBytes));
    return encodedBytes;
  }

  /** Encodes into the cached packet scratch and returns its byte count. */
  #encodeToScratch(pcm: Int16Array | Uint8Array, options: EncodeOptions): number {
    this.#assertLive();
    const frameSize = options.frameSize ?? this.frameSize;
    // The constructor already validated the default, so only re-check overrides.
    if (frameSize !== this.frameSize) {
      validateEncodeFrameSize(frameSize, this.sampleRate, "frameSize", this.useSmpl);
    }
    const expectedBytes = frameSize * this.channels * 2;
    if (pcm.byteLength !== expectedBytes) {
      throw new RangeError(
        `PCM frame has ${pcm.byteLength} bytes; expected ${expectedBytes} for ${frameSize} samples and ${this.channels} channel(s)`,
      );
    }
    const maxPacketBytes = options.maxPacketBytes ?? DEFAULT_MAX_PACKET_BYTES;
    validatePositiveInteger(maxPacketBytes, "maxPacketBytes");
    const pcmPtr = this.#ensurePcmBytes(expectedBytes);
    const packetPtr = this.#ensurePacketBytes(maxPacketBytes);
    // Copy through the widest matching view to skip building a throwaway one.
    if (pcm instanceof Int16Array) {
      this.#module.HEAP16.set(pcm, pcmPtr >> 1);
    } else {
      this.#module.HEAPU8.set(pcm, pcmPtr);
    }
    const encodedBytes = this.#module._oc_encode(
      this.#ptr,
      pcmPtr,
      frameSize,
      packetPtr,
      maxPacketBytes,
    );
    if (encodedBytes < 0) {
      throw createOpusError(this.#module, encodedBytes, "encode");
    }
    this.#framesSinceSecondary += 1;
    return encodedBytes;
  }

  #encodeFloatToScratch(pcm: Float32Array, options: EncodeOptions): number {
    this.#assertLive();
    const frameSize = options.frameSize ?? this.frameSize;
    if (frameSize !== this.frameSize) {
      validateEncodeFrameSize(frameSize, this.sampleRate, "frameSize");
    }
    const expectedSamples = frameSize * this.channels;
    if (pcm.length !== expectedSamples) {
      throw new RangeError(
        `Float32 PCM frame has ${pcm.length} samples; expected ${expectedSamples} for ${frameSize} samples and ${this.channels} channel(s)`,
      );
    }
    const maxPacketBytes = options.maxPacketBytes ?? DEFAULT_MAX_PACKET_BYTES;
    validatePositiveInteger(maxPacketBytes, "maxPacketBytes");
    const pcmPtr = this.#ensurePcmBytes(pcm.byteLength);
    const packetPtr = this.#ensurePacketBytes(maxPacketBytes);
    this.#module.HEAPF32.set(pcm, pcmPtr >> 2);
    const encodedBytes = this.#module._oc_encode_float(
      this.#ptr,
      pcmPtr,
      frameSize,
      packetPtr,
      maxPacketBytes,
    );
    if (encodedBytes < 0) {
      throw createOpusError(this.#module, encodedBytes, "encodeFloat");
    }
    this.#framesSinceSecondary += 1;
    return encodedBytes;
  }

  encodeFrames(frames: readonly (Int16Array | Uint8Array)[], options: EncodeOptions = {}): Uint8Array[] {
    return frames.map((frame) => this.encode(frame, options));
  }

  encodeFloatFrames(frames: readonly Float32Array[], options: EncodeOptions = {}): Uint8Array[] {
    return frames.map((frame) => this.encodeFloat(frame, options));
  }

  encodeSecondary(options: EncodeOptions = {}): Uint8Array {
    this.#assertLive();
    // The codec tracks a frame counter per encoder and asserts that the primary
    // one is strictly ahead. Calling twice in a row, or skipping frames, breaks
    // that invariant — and the assert aborts the whole WASM module, taking every
    // other encoder and decoder in the process with it. So guard it here and
    // raise a normal JS error instead.
    if (this.#framesSinceSecondary !== 1) {
      const detail =
        this.#framesSinceSecondary === 0
          ? "no encode() call since the last one"
          : `${this.#framesSinceSecondary} encode() calls since the last one`;
      throw new Error(
        `encodeSecondary() must follow exactly one encode() — ${detail}. ` +
          "RED needs a secondary packet for every frame; it cannot be produced intermittently.",
      );
    }
    const maxPacketBytes = options.maxPacketBytes ?? DEFAULT_MAX_PACKET_BYTES;
    validatePositiveInteger(maxPacketBytes, "maxPacketBytes");
    const packetPtr = this.#ensurePacketBytes(maxPacketBytes);
    const encodedBytes = this.#module._oc_encode_secondary(this.#ptr, packetPtr, maxPacketBytes);
    this.#framesSinceSecondary = 0;
    if (encodedBytes < 0) {
      throw createOpusError(this.#module, encodedBytes, "encodeSecondary");
    }
    return this.#module.HEAPU8.slice(packetPtr, packetPtr + encodedBytes);
  }

  setSecondaryBitrate(bitrate: number): void {
    const resolved = normalizeBitrate(bitrate);
    if (resolved > 0 && this.#dtxEnabled) {
      throw new Error(
        "redundancy cannot be enabled while discontinuous transmission is: the " +
          "codec aborts when a silent frame reaches the secondary encoder. " +
          "Disable it first with setDtx(false).",
      );
    }
    this.encoderCtl(EncoderCtl.SetSecondaryBitrate, resolved);
    this.#secondaryEnabled = resolved > 0;
  }

  setSecondaryComplexity(complexity: number): void {
    validateIntegerRange(complexity, 0, 10, "complexity");
    this.encoderCtl(EncoderCtl.SetSecondaryComplexity, complexity);
  }

  encoderCtl(request: number, value: number): void {
    this.#assertLive();
    validateInteger(request, "request");
    validateInteger(value, "value");
    if (!ENCODER_INTEGER_CTL_REQUESTS.has(request)) {
      throw new RangeError("encoderCtl only supports integer setter requests");
    }
    if (request === EncoderCtl.SetUseSmpl && value !== 0) {
      ensureSmplGlobalsSync(this.#module);
    }
    this.#check(this.#module._oc_encoder_ctl(this.#ptr, request, value), "encoderCtl");
  }

  setBitrate(bitrate: Bitrate): void {
    this.encoderCtl(EncoderCtl.SetBitrate, normalizeBitrate(bitrate));
  }

  getBitrate(): number {
    this.#assertLive();
    const bitrate = this.#module._oc_encoder_ctl_get_bitrate(this.#ptr);
    if (bitrate < 0) {
      throw createOpusError(this.#module, bitrate, "getBitrate");
    }
    return bitrate;
  }

  getLookahead(): number {
    this.#assertLive();
    const lookahead = this.#module._oc_encoder_ctl_get_lookahead(this.#ptr);
    if (lookahead < 0) {
      throw createOpusError(this.#module, lookahead, "getLookahead");
    }
    return lookahead;
  }

  getInDtx(): boolean {
    this.#assertLive();
    const inDtx = this.#module._oc_encoder_ctl_get_in_dtx(this.#ptr);
    if (inDtx < 0) {
      throw createOpusError(this.#module, inDtx, "getInDtx");
    }
    return inDtx !== 0;
  }

  setComplexity(complexity: number): void {
    validateIntegerRange(complexity, 0, 10, "complexity");
    this.encoderCtl(EncoderCtl.SetComplexity, complexity);
  }

  setDtx(enabled: boolean): void {
    if (enabled && this.#secondaryEnabled) {
      throw new Error(
        "discontinuous transmission cannot be enabled while redundancy is: the " +
          "codec aborts when a silent frame reaches the secondary encoder. " +
          "Disable redundancy first with setSecondaryBitrate(0).",
      );
    }
    this.encoderCtl(EncoderCtl.SetDtx, enabled ? 1 : 0);
    this.#dtxEnabled = enabled;
  }

  setFec(enabled: boolean): void {
    this.encoderCtl(EncoderCtl.SetInBandFec, enabled ? 1 : 0);
  }

  setMaxBandwidth(bandwidth: Bandwidth): void {
    validateBandwidth(bandwidth, "maxBandwidth");
    this.encoderCtl(EncoderCtl.SetMaxBandwidth, bandwidth);
  }

  setPacketLossPercent(percentage: number): void {
    validateIntegerRange(percentage, 0, 100, "packetLossPercent");
    this.encoderCtl(EncoderCtl.SetPacketLossPercent, percentage);
  }

  setSignal(signal: Signal): void {
    if (!SIGNAL_VALUES.has(signal)) {
      throw new RangeError("signal must be Signal.Auto, Signal.Voice, or Signal.Music");
    }
    this.encoderCtl(EncoderCtl.SetSignal, signal);
  }

  setVbr(enabled: boolean): void {
    this.encoderCtl(EncoderCtl.SetVbr, enabled ? 1 : 0);
  }

  setVbrConstraint(enabled: boolean): void {
    this.encoderCtl(EncoderCtl.SetVbrConstraint, enabled ? 1 : 0);
  }

  free(): void {
    if (this.#freed) {
      return;
    }
    this.#freeScratch();
    this.#module._oc_destroy_encoder(this.#ptr);
    this.#freed = true;
  }

  [Symbol.dispose](): void {
    this.free();
  }

  #assertLive(): void {
    if (this.#freed) {
      throw new Error("OpusEncoder has been freed");
    }
  }

  #check(code: number, operation: string): void {
    if (code < 0) {
      throw createOpusError(this.#module, code, operation);
    }
  }

  #ensurePacketBytes(requiredBytes: number): number {
    if (this.#packetPtr !== 0 && this.#packetBytes >= requiredBytes) {
      return this.#packetPtr;
    }
    const nextPtr = checkedMalloc(this.#module, requiredBytes);
    if (this.#packetPtr !== 0) {
      this.#module._free(this.#packetPtr);
    }
    this.#packetPtr = nextPtr;
    this.#packetBytes = requiredBytes;
    return this.#packetPtr;
  }

  #ensurePcmBytes(requiredBytes: number): number {
    if (this.#pcmPtr !== 0 && this.#pcmBytes >= requiredBytes) {
      return this.#pcmPtr;
    }
    const nextPtr = checkedMalloc(this.#module, requiredBytes);
    if (this.#pcmPtr !== 0) {
      this.#module._free(this.#pcmPtr);
    }
    this.#pcmPtr = nextPtr;
    this.#pcmBytes = requiredBytes;
    return this.#pcmPtr;
  }

  #freeScratch(): void {
    if (this.#packetPtr !== 0) {
      this.#module._free(this.#packetPtr);
    }
    if (this.#pcmPtr !== 0) {
      this.#module._free(this.#pcmPtr);
    }
    this.#packetPtr = 0;
    this.#packetBytes = 0;
    this.#pcmPtr = 0;
    this.#pcmBytes = 0;
  }
}

class WasmOpusDecoder implements OpusDecoderHandle {
  readonly channels: ChannelCount;
  readonly maxFrameSize: number;
  readonly sampleRate: SampleRate;
  readonly useSmpl: boolean;
  #freed = false;
  #module: LibmlowModule;
  #packetBytes = 0;
  #packetPtr = 0;
  #pcmBytes = 0;
  #pcmPtr = 0;
  #ptr: number;

  constructor(module: LibmlowModule, options: NormalizedDecoderOptions) {
    this.#module = module;
    this.channels = options.channels;
    this.maxFrameSize = options.maxFrameSize;
    this.sampleRate = options.sampleRate;
    this.useSmpl = options.useSmpl;
    const errorPtr = checkedMalloc(module, 4);
    try {
      const ptr = module._oc_create_decoder(options.sampleRate, options.channels, errorPtr);
      const error = module.HEAP32[errorPtr >> 2] ?? 0;
      if (!ptr || error !== 0) {
        throw createOpusError(module, error, "createDecoder");
      }
      this.#ptr = ptr;
    } finally {
      module._free(errorPtr);
    }
    // From here the decoder owns WASM memory, so any failure below has to
    // release it rather than leaking the state.
    try {
      if (options.useLpcPostfilter !== undefined) {
        this.decoderCtl(DecoderCtl.SetUseLpcPostfilter, options.useLpcPostfilter ? 1 : 0);
      }
      if (options.useSmpl) {
        this.decoderCtl(DecoderCtl.SetUseSmpl, 1);
      }
      // Size for the float path up front so alternating decode/decodeFloat
      // never reallocates, and the hot path never calls malloc.
      this.#ensurePcmBytes(options.maxFrameSize * options.channels * 4);
    } catch (error) {
      this.#freeScratch();
      module._oc_destroy_decoder(this.#ptr);
      this.#freed = true;
      throw error;
    }
  }

  decode(packet: Uint8Array | null, options: DecodeOptions = {}): Int16Array {
    const samples = this.#decodeToScratch(packet, options);
    const start = this.#pcmPtr >> 1;
    return this.#module.HEAP16.slice(start, start + samples * this.channels);
  }

  decodeInto(target: Int16Array, packet: Uint8Array | null, options: DecodeOptions = {}): number {
    const samples = this.#decodeToScratch(packet, options);
    const sampleCount = samples * this.channels;
    if (target.length < sampleCount) {
      throw new RangeError(`target holds ${target.length} samples; the frame needs ${sampleCount}`);
    }
    const start = this.#pcmPtr >> 1;
    target.set(this.#module.HEAP16.subarray(start, start + sampleCount));
    return samples;
  }

  decodeFloat(packet: Uint8Array | null, options: DecodeOptions = {}): Float32Array {
    const samples = this.#decodeFloatToScratch(packet, options);
    const start = this.#pcmPtr >> 2;
    return this.#module.HEAPF32.slice(start, start + samples * this.channels);
  }

  decodeFloatInto(
    target: Float32Array,
    packet: Uint8Array | null,
    options: DecodeOptions = {},
  ): number {
    const samples = this.#decodeFloatToScratch(packet, options);
    const sampleCount = samples * this.channels;
    if (target.length < sampleCount) {
      throw new RangeError(`target holds ${target.length} samples; the frame needs ${sampleCount}`);
    }
    const start = this.#pcmPtr >> 2;
    target.set(this.#module.HEAPF32.subarray(start, start + sampleCount));
    return samples;
  }

  /** Decodes into the cached PCM scratch and returns samples per channel. */
  #decodeToScratch(packet: Uint8Array | null, options: DecodeOptions): number {
    this.#assertLive();
    const frameSize = this.#resolveDecodeFrameSize(packet, options);
    const pcmPtr = this.#ensurePcmBytes(frameSize * this.channels * 2);
    const packetLength = this.#copyPacket(packet, options.decodeFec);
    const decodedSamples = this.#module._oc_decode(
      this.#ptr,
      packet === null ? 0 : this.#packetPtr,
      packetLength,
      pcmPtr,
      frameSize,
      options.decodeFec ? 1 : 0,
    );
    if (decodedSamples < 0) {
      throw createOpusError(this.#module, decodedSamples, packet === null ? "decodePacketLoss" : "decode");
    }
    return decodedSamples;
  }

  #decodeFloatToScratch(packet: Uint8Array | null, options: DecodeOptions): number {
    this.#assertLive();
    const frameSize = this.#resolveDecodeFrameSize(packet, options);
    const pcmPtr = this.#ensurePcmBytes(frameSize * this.channels * 4);
    const packetLength = this.#copyPacket(packet, options.decodeFec);
    const decodedSamples = this.#module._oc_decode_float(
      this.#ptr,
      packet === null ? 0 : this.#packetPtr,
      packetLength,
      pcmPtr,
      frameSize,
      options.decodeFec ? 1 : 0,
    );
    if (decodedSamples < 0) {
      throw createOpusError(
        this.#module,
        decodedSamples,
        packet === null ? "decodePacketLossFloat" : "decodeFloat",
      );
    }
    return decodedSamples;
  }

  decodeFrames(packets: readonly (Uint8Array | null)[], options: DecodeOptions = {}): Int16Array[] {
    return packets.map((packet) => this.decode(packet, options));
  }

  decodeFloatFrames(packets: readonly (Uint8Array | null)[], options: DecodeOptions = {}): Float32Array[] {
    return packets.map((packet) => this.decodeFloat(packet, options));
  }

  decodePacketLoss(frameSize = samplesForDuration(this.sampleRate, DEFAULT_FRAME_DURATION_MS)): Int16Array {
    return this.decode(null, { frameSize });
  }

  decodePacketLossFloat(frameSize = samplesForDuration(this.sampleRate, DEFAULT_FRAME_DURATION_MS)): Float32Array {
    return this.decodeFloat(null, { frameSize });
  }

  decoderCtl(request: number, value: number): void {
    this.#assertLive();
    validateInteger(request, "request");
    validateInteger(value, "value");
    if (!DECODER_INTEGER_CTL_REQUESTS.has(request)) {
      throw new RangeError("decoderCtl only supports integer setter requests");
    }
    if (request === DecoderCtl.SetUseSmpl && value !== 0) {
      ensureSmplGlobalsSync(this.#module);
    }
    const code = this.#module._oc_decoder_ctl(this.#ptr, request, value);
    if (code < 0) {
      throw createOpusError(this.#module, code, "decoderCtl");
    }
  }

  free(): void {
    if (this.#freed) {
      return;
    }
    this.#freeScratch();
    this.#module._oc_destroy_decoder(this.#ptr);
    this.#freed = true;
  }

  [Symbol.dispose](): void {
    this.free();
  }

  #assertLive(): void {
    if (this.#freed) {
      throw new Error("OpusDecoder has been freed");
    }
  }

  /**
   * Stages the packet in the cached scratch and returns its length. A null
   * packet means PLC, which the codec signals with a null pointer — callers
   * pass 0 rather than {@link #packetPtr} in that case. Returns a plain number
   * so the decode path allocates nothing per frame.
   */
  #copyPacket(packet: Uint8Array | null, decodeFec: boolean | undefined): number {
    if (packet === null) {
      if (decodeFec) {
        throw new RangeError("decodeFec requires a packet");
      }
      return 0;
    }
    if (packet.byteLength === 0) {
      throw new RangeError("packet must not be empty; use null or decodePacketLoss() for PLC");
    }
    const packetPtr = this.#ensurePacketBytes(packet.byteLength);
    this.#module.HEAPU8.set(packet, packetPtr);
    if (this.useSmpl) {
      this.#module._oc_mlow_strip_padding_flag(packetPtr, packet.byteLength);
    }
    return packet.byteLength;
  }

  #ensurePacketBytes(requiredBytes: number): number {
    if (this.#packetPtr !== 0 && this.#packetBytes >= requiredBytes) {
      return this.#packetPtr;
    }
    const nextPtr = checkedMalloc(this.#module, requiredBytes);
    if (this.#packetPtr !== 0) {
      this.#module._free(this.#packetPtr);
    }
    this.#packetPtr = nextPtr;
    this.#packetBytes = requiredBytes;
    return this.#packetPtr;
  }

  #ensurePcmBytes(requiredBytes: number): number {
    if (this.#pcmPtr !== 0 && this.#pcmBytes >= requiredBytes) {
      return this.#pcmPtr;
    }
    const nextPtr = checkedMalloc(this.#module, requiredBytes);
    if (this.#pcmPtr !== 0) {
      this.#module._free(this.#pcmPtr);
    }
    this.#pcmPtr = nextPtr;
    this.#pcmBytes = requiredBytes;
    return this.#pcmPtr;
  }

  #freeScratch(): void {
    if (this.#packetPtr !== 0) {
      this.#module._free(this.#packetPtr);
    }
    if (this.#pcmPtr !== 0) {
      this.#module._free(this.#pcmPtr);
    }
    this.#packetPtr = 0;
    this.#packetBytes = 0;
    this.#pcmPtr = 0;
    this.#pcmBytes = 0;
  }

  #resolveDecodeFrameSize(packet: Uint8Array | null, options: DecodeOptions): number {
    const frameSize = packet === null || options.decodeFec
      ? (options.frameSize ?? options.maxFrameSize ?? samplesForDuration(this.sampleRate, DEFAULT_FRAME_DURATION_MS))
      : (options.maxFrameSize ?? this.maxFrameSize);
    if (packet === null || options.decodeFec) {
      validatePlcFrameSize(frameSize, this.sampleRate, "frameSize");
      return frameSize;
    }
    validateDecodeCapacity(frameSize, this.sampleRate, "maxFrameSize");
    return frameSize;
  }
}

export class OpusError extends Error {
  readonly code: number;
  readonly codeName: OpusErrorCodeName | undefined;
  readonly operation: string | undefined;

  constructor(code: number, message: string, operation?: string) {
    super(message);
    this.name = "OpusError";
    this.code = code;
    this.codeName = resolveOpusErrorCodeName(code);
    this.operation = operation;
  }
}

export const OpusErrorCode = {
  BadArg: -1,
  BufferTooSmall: -2,
  InternalError: -3,
  InvalidPacket: -4,
  Unimplemented: -5,
  InvalidState: -6,
  AllocFail: -7,
} as const;

export type OpusErrorCodeName = keyof typeof OpusErrorCode;

export function isOpusError(error: unknown): error is OpusError {
  if (error instanceof OpusError) {
    return true;
  }
  const candidate = error as {
    code?: unknown;
    codeName?: unknown;
    message?: unknown;
    name?: unknown;
    operation?: unknown;
  };
  return (
    Boolean(error) &&
    typeof error === "object" &&
    candidate.name === "OpusError" &&
    typeof candidate.message === "string" &&
    typeof candidate.code === "number" &&
    (typeof candidate.codeName === "string" || candidate.codeName === undefined) &&
    (typeof candidate.operation === "string" || candidate.operation === undefined)
  );
}

class WasmMlowRepacketizer implements MlowRepacketizerHandle {
  readonly useMlow: boolean;
  #accumBytes = 0;
  #accumOffset = 0;
  #accumPtr = 0;
  #defaultMaxPacketBytes: number;
  #framesBytes = 0;
  #framesPtr = 0;
  #freed = false;
  #lengthsBytes = 0;
  #lengthsPtr = 0;
  #module: LibmlowModule;
  #packetBytes = 0;
  #packetPtr = 0;
  #ptr: number;

  constructor(module: LibmlowModule, options: NormalizedRepacketizerOptions) {
    this.#module = module;
    this.useMlow = options.useMlow;
    this.#defaultMaxPacketBytes = options.maxPacketBytes;
    const ptr = module._oc_repacketizer_create();
    if (!ptr) {
      throw new Error("libmlow createRepacketizer failed: out of memory");
    }
    this.#ptr = ptr;
    module._oc_repacketizer_set_using_mlow(ptr, options.useMlow ? 1 : 0);
  }

  pack(frames: readonly Uint8Array[], options: PackOptions = {}): Uint8Array {
    this.#assertLive();
    if (frames.length === 0) {
      throw new RangeError("frames must not be empty");
    }
    if (frames.length > MAX_MLOW_FRAMES_PER_PACKET) {
      throw new RangeError(
        `frames must hold at most ${MAX_MLOW_FRAMES_PER_PACKET} frames; got ${frames.length}`,
      );
    }
    let totalBytes = 0;
    for (const frame of frames) {
      if (frame.byteLength === 0) {
        throw new RangeError("frames must not contain empty packets");
      }
      totalBytes += frame.byteLength;
    }
    const maxPacketBytes = options.maxPacketBytes ?? this.#defaultMaxPacketBytes;
    validatePositiveInteger(maxPacketBytes, "maxPacketBytes");

    const framesPtr = this.#ensureFramesBytes(totalBytes);
    const lengthsPtr = this.#ensureLengthsBytes(frames.length * 4);
    const packetPtr = this.#ensurePacketBytes(maxPacketBytes);
    const heap = this.#module.HEAPU8;
    const lengths = this.#module.HEAP32;
    let offset = framesPtr;
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i] as Uint8Array;
      heap.set(frame, offset);
      lengths[(lengthsPtr >> 2) + i] = frame.byteLength;
      offset += frame.byteLength;
    }

    const packedBytes = this.#module._oc_mlow_repacketize(
      this.#ptr,
      framesPtr,
      lengthsPtr,
      frames.length,
      this.useMlow ? 1 : 0,
      packetPtr,
      maxPacketBytes,
    );
    if (packedBytes < 0) {
      throw createOpusError(this.#module, packedBytes, "pack");
    }
    // oc_mlow_repacketize re-inits the state, so anything queued via add() is gone.
    this.#accumOffset = 0;
    return this.#module.HEAPU8.slice(packetPtr, packetPtr + packedBytes);
  }

  reset(): void {
    this.#assertLive();
    this.#module._oc_repacketizer_init(this.#ptr);
    this.#module._oc_repacketizer_set_using_mlow(this.#ptr, this.useMlow ? 1 : 0);
    this.#accumOffset = 0;
  }

  add(frame: Uint8Array): void {
    this.#assertLive();
    if (frame.byteLength === 0) {
      throw new RangeError("frame must not be empty");
    }
    // opus_repacketizer_cat() stores pointers INTO this buffer rather than
    // copying, so every queued frame must keep its own bytes alive and put
    // until out(). Hence a fixed accumulator that never moves between
    // reset() and out() — appending, never overwriting.
    const accumPtr = this.#ensureAccumulator();
    if (this.#accumOffset + frame.byteLength > this.#accumBytes) {
      throw new RangeError(
        `queued frames exceed the ${this.#accumBytes}-byte accumulator; call out() or raise maxPacketBytes`,
      );
    }
    const framePtr = accumPtr + this.#accumOffset;
    this.#module.HEAPU8.set(frame, framePtr);
    const code = this.#module._oc_repacketizer_cat(this.#ptr, framePtr, frame.byteLength);
    if (code < 0) {
      throw createOpusError(this.#module, code, "add");
    }
    this.#accumOffset += frame.byteLength;
  }

  getFrameCount(): number {
    this.#assertLive();
    return this.#module._oc_repacketizer_get_nb_frames(this.#ptr);
  }

  out(options: PackOptions = {}): Uint8Array {
    this.#assertLive();
    const maxPacketBytes = options.maxPacketBytes ?? this.#defaultMaxPacketBytes;
    validatePositiveInteger(maxPacketBytes, "maxPacketBytes");
    const packetPtr = this.#ensurePacketBytes(maxPacketBytes);
    const packedBytes = this.#module._oc_repacketizer_out(this.#ptr, packetPtr, maxPacketBytes);
    if (packedBytes < 0) {
      throw createOpusError(this.#module, packedBytes, "out");
    }
    return this.#module.HEAPU8.slice(packetPtr, packetPtr + packedBytes);
  }

  outRange(begin: number, end: number, options: PackOptions = {}): Uint8Array {
    this.#assertLive();
    validateInteger(begin, "begin");
    validateInteger(end, "end");
    if (begin < 0 || end < begin) {
      throw new RangeError("end must be greater than or equal to begin, and begin must not be negative");
    }
    const maxPacketBytes = options.maxPacketBytes ?? this.#defaultMaxPacketBytes;
    validatePositiveInteger(maxPacketBytes, "maxPacketBytes");
    const packetPtr = this.#ensurePacketBytes(maxPacketBytes);
    const packedBytes = this.#module._oc_repacketizer_out_range(
      this.#ptr,
      begin,
      end,
      packetPtr,
      maxPacketBytes,
    );
    if (packedBytes < 0) {
      throw createOpusError(this.#module, packedBytes, "outRange");
    }
    return this.#module.HEAPU8.slice(packetPtr, packetPtr + packedBytes);
  }

  free(): void {
    if (this.#freed) {
      return;
    }
    this.#freeScratch();
    this.#module._oc_repacketizer_destroy(this.#ptr);
    this.#freed = true;
  }

  [Symbol.dispose](): void {
    this.free();
  }

  #assertLive(): void {
    if (this.#freed) {
      throw new Error("MlowRepacketizer has been freed");
    }
  }

  #ensureFramesBytes(requiredBytes: number): number {
    if (this.#framesPtr !== 0 && this.#framesBytes >= requiredBytes) {
      return this.#framesPtr;
    }
    const nextPtr = checkedMalloc(this.#module, requiredBytes);
    if (this.#framesPtr !== 0) {
      this.#module._free(this.#framesPtr);
    }
    this.#framesPtr = nextPtr;
    this.#framesBytes = requiredBytes;
    return this.#framesPtr;
  }

  /**
   * Fixed-size staging area for {@link add}. Allocated once and never moved,
   * because the repacketizer holds raw pointers into it until out().
   */
  #ensureAccumulator(): number {
    if (this.#accumPtr !== 0) {
      return this.#accumPtr;
    }
    const bytes = MAX_MLOW_FRAMES_PER_PACKET * this.#defaultMaxPacketBytes;
    this.#accumPtr = checkedMalloc(this.#module, bytes);
    this.#accumBytes = bytes;
    return this.#accumPtr;
  }

  #ensureLengthsBytes(requiredBytes: number): number {
    if (this.#lengthsPtr !== 0 && this.#lengthsBytes >= requiredBytes) {
      return this.#lengthsPtr;
    }
    const nextPtr = checkedMalloc(this.#module, requiredBytes);
    if (this.#lengthsPtr !== 0) {
      this.#module._free(this.#lengthsPtr);
    }
    this.#lengthsPtr = nextPtr;
    this.#lengthsBytes = requiredBytes;
    return this.#lengthsPtr;
  }

  #ensurePacketBytes(requiredBytes: number): number {
    if (this.#packetPtr !== 0 && this.#packetBytes >= requiredBytes) {
      return this.#packetPtr;
    }
    const nextPtr = checkedMalloc(this.#module, requiredBytes);
    if (this.#packetPtr !== 0) {
      this.#module._free(this.#packetPtr);
    }
    this.#packetPtr = nextPtr;
    this.#packetBytes = requiredBytes;
    return this.#packetPtr;
  }

  #freeScratch(): void {
    if (this.#accumPtr !== 0) {
      this.#module._free(this.#accumPtr);
    }
    if (this.#framesPtr !== 0) {
      this.#module._free(this.#framesPtr);
    }
    if (this.#lengthsPtr !== 0) {
      this.#module._free(this.#lengthsPtr);
    }
    if (this.#packetPtr !== 0) {
      this.#module._free(this.#packetPtr);
    }
    this.#accumPtr = 0;
    this.#accumBytes = 0;
    this.#accumOffset = 0;
    this.#framesPtr = 0;
    this.#framesBytes = 0;
    this.#lengthsPtr = 0;
    this.#lengthsBytes = 0;
    this.#packetPtr = 0;
    this.#packetBytes = 0;
  }
}

async function getModule(): Promise<LibmlowModule> {
  modulePromise ??= createLibmlowModule();
  return await modulePromise;
}

function resolveOpusErrorCodeName(code: number): OpusErrorCodeName | undefined {
  for (const [name, value] of Object.entries(OpusErrorCode)) {
    if (value === code) {
      return name as OpusErrorCodeName;
    }
  }
  return undefined;
}

function createOpusError(module: LibmlowModule, code: number, operation: string): OpusError {
  const message = module.UTF8ToString(module._oc_strerror(code));
  return new OpusError(code, `libmlow ${operation} failed (${code}): ${message}`, operation);
}

function normalizeEncoderOptions(options: EncoderOptions): NormalizedEncoderOptions {
  const sampleRate = options.sampleRate ?? DEFAULT_SAMPLE_RATE;
  const channels = options.channels ?? DEFAULT_CHANNELS;
  validateCodecOptions({ channels, sampleRate });
  const frameSize = options.frameSize ?? samplesForDuration(sampleRate, DEFAULT_FRAME_DURATION_MS);
  validateEncodeFrameSize(frameSize, sampleRate, "frameSize", options.useSmpl === true);
  if (options.maxBandwidth !== undefined) {
    validateBandwidth(options.maxBandwidth, "maxBandwidth");
  }
  return {
    application: options.application ?? Application.Audio,
    bitrate: normalizeBitrate(options.bitrate ?? 64_000),
    channels,
    // Worth knowing when tuning: at 7 and above the encoder runs a 480-point
    // MDCT plus an MLP for tonality analysis on every frame, while SMPL's own
    // search tiers only step at 1/2/3/4/8. So 6 buys the same SMPL search as 8
    // while skipping that analysis entirely.
    complexity: options.complexity ?? 10,
    dtx: options.dtx ?? false,
    fec: options.fec ?? false,
    frameSize,
    maxBandwidth: options.maxBandwidth,
    packetLossPercent: options.packetLossPercent ?? 0,
    sampleRate,
    signal: options.signal ?? Signal.Auto,
    useSmpl: options.useSmpl === true,
    vbr: options.vbr,
    vbrConstraint: options.vbrConstraint,
  };
}

function normalizeRepacketizerOptions(options: RepacketizerOptions): NormalizedRepacketizerOptions {
  const maxPacketBytes = options.maxPacketBytes ?? DEFAULT_MAX_PACKET_BYTES;
  validatePositiveInteger(maxPacketBytes, "maxPacketBytes");
  return { maxPacketBytes, useMlow: options.useMlow !== false };
}

function normalizeDecoderOptions(options: DecoderOptions): NormalizedDecoderOptions {
  const sampleRate = options.sampleRate ?? DEFAULT_SAMPLE_RATE;
  const channels = options.channels ?? DEFAULT_CHANNELS;
  validateCodecOptions({ channels, sampleRate });
  const maxFrameSize = options.maxFrameSize ?? samplesForDuration(sampleRate, MAX_PACKET_DURATION_MS);
  validateDecodeCapacity(maxFrameSize, sampleRate, "maxFrameSize");
  return { channels, maxFrameSize, sampleRate, useLpcPostfilter: options.useLpcPostfilter, useSmpl: options.useSmpl === true };
}

function samplesForDuration(sampleRate: SampleRate, durationMs: number): number {
  return (sampleRate / 1000) * durationMs;
}

function validateCodecOptions(options: Required<CodecOptions>): void {
  if (!VALID_SAMPLE_RATES.includes(options.sampleRate)) {
    throw new RangeError("sampleRate must be 8000, 12000, 16000, 24000, or 48000");
  }
  if (options.channels !== 1 && options.channels !== 2) {
    throw new RangeError("channels must be 1 or 2");
  }
}

function normalizeBitrate(bitrate: Bitrate): number {
  if (bitrate === "auto") {
    return Bitrate.Auto;
  }
  if (bitrate === "max") {
    return Bitrate.Max;
  }
  if (bitrate === Bitrate.Auto || bitrate === Bitrate.Max) {
    return bitrate;
  }
  validatePositiveInteger(bitrate, "bitrate");
  return bitrate;
}

function validateBandwidth(bandwidth: Bandwidth, name: string): void {
  if (!BANDWIDTH_VALUES.has(bandwidth)) {
    throw new RangeError(
      `${name} must be Bandwidth.Narrowband, Bandwidth.Mediumband, Bandwidth.Wideband, Bandwidth.Superwideband, or Bandwidth.Fullband`,
    );
  }
}

function validateEncodeFrameSize(
  frameSize: number,
  sampleRate: SampleRate,
  name: string,
  useSmpl = false,
): void {
  validateFrameSizeForDurations(
    frameSize,
    sampleRate,
    name,
    useSmpl ? MLOW_FRAME_DURATIONS_MS : ENCODE_FRAME_DURATIONS_MS,
  );
}

function validateDecodeCapacity(frameSize: number, sampleRate: SampleRate, name: string): void {
  const maxFrameSize = samplesForDuration(sampleRate, MAX_PACKET_DURATION_MS);
  if (!Number.isInteger(frameSize) || frameSize <= 0 || frameSize > maxFrameSize) {
    throw new RangeError(`${name} must be an integer from 1 to ${maxFrameSize} samples at ${sampleRate} Hz`);
  }
}

function validatePlcFrameSize(frameSize: number, sampleRate: SampleRate, name: string): void {
  const minFrameSize = samplesForDuration(sampleRate, 2.5);
  const maxFrameSize = samplesForDuration(sampleRate, MAX_PACKET_DURATION_MS);
  if (
    !Number.isInteger(frameSize) ||
    frameSize < minFrameSize ||
    frameSize > maxFrameSize ||
    frameSize % minFrameSize !== 0
  ) {
    throw new RangeError(
      `${name} must be a multiple of ${minFrameSize} samples from ${minFrameSize} to ${maxFrameSize} at ${sampleRate} Hz`,
    );
  }
}

function validateFrameSizeForDurations(
  frameSize: number,
  sampleRate: SampleRate,
  name: string,
  durationsMs: readonly number[],
): void {
  const validFrameSizes = frameSizesFor(sampleRate, durationsMs);
  if (!Number.isInteger(frameSize) || !validFrameSizes.has(frameSize)) {
    throw new RangeError(
      `${name} must be one of ${[...validFrameSizes].join(", ")} samples at ${sampleRate} Hz`,
    );
  }
}

/**
 * Valid frame sizes per (sample rate, duration set). Cached because `encode()`
 * validates on every call, and rebuilding the list per frame allocates.
 */
const frameSizeCache = new Map<readonly number[], Map<SampleRate, ReadonlySet<number>>>();

function frameSizesFor(sampleRate: SampleRate, durationsMs: readonly number[]): ReadonlySet<number> {
  let perRate = frameSizeCache.get(durationsMs);
  if (perRate === undefined) {
    perRate = new Map();
    frameSizeCache.set(durationsMs, perRate);
  }
  let sizes = perRate.get(sampleRate);
  if (sizes === undefined) {
    sizes = new Set(durationsMs.map((durationMs) => samplesForDuration(sampleRate, durationMs)));
    perRate.set(sampleRate, sizes);
  }
  return sizes;
}

function validateInteger(value: number, name: string): void {
  if (!Number.isInteger(value)) {
    throw new RangeError(`${name} must be an integer`);
  }
}

function validatePositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

function validateIntegerRange(value: number, min: number, max: number, name: string): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer from ${min} to ${max}`);
  }
}

function checkedMalloc(module: LibmlowModule, bytes: number): number {
  const ptr = module._malloc(bytes);
  if (ptr === 0) {
    throw new Error(`WASM malloc failed for ${bytes} bytes`);
  }
  return ptr;
}
