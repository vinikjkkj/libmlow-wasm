# API reference

Everything exported from `libmlow-wasm`. For the Discord-compatible adapter, see
[discord.js compatibility](discordjs.md).

```ts
import {
  loadLibopus,
  createEncoder,
  createDecoder,
  createRepacketizer,
  getPacketInfo,
  getMlowPacketInfo,
  opusGlobalCreate,
  opusGlobalFree,
  Application,
  Signal,
  Bitrate,
  Bandwidth,
  MlowMode,
  EncoderCtl,
  DecoderCtl,
  OpusError,
  OpusErrorCode,
  isOpusError,
} from "libmlow-wasm";
```

## Top-level functions

| Function | Returns | Description |
| --- | --- | --- |
| `loadLibopus()` | `Promise<{ version: string }>` | Loads the module and returns the bundled libopus version string. |
| `createEncoder(options?)` | `Promise<OpusEncoderHandle>` | Creates a raw-packet encoder. See [EncoderOptions](#encoderoptions). |
| `createDecoder(options?)` | `Promise<OpusDecoderHandle>` | Creates a raw-packet decoder. See [DecoderOptions](#decoderoptions). |
| `createRepacketizer(options?)` | `Promise<MlowRepacketizerHandle>` | Creates a repacketizer that packs MLow frames into one multiframe packet. See [Repacketizer](repacketizer.md). |
| `getPacketInfo(packet, options?)` | `Promise<OpusPacketInfo>` | Inspects a raw packet (duration, frames, channels, bandwidth) validating it by decoding and discarding the PCM. See [Packet inspection](packet-info.md). |
| `getMlowPacketInfo(packet, options?)` | `Promise<MlowPacketInfo>` | MLow-aware inspection: the same fields plus `hasVadFlag`, `hasFecContent`, and `toc`. See [MLow packets](packet-info.md#mlow-packets). |
| `opusGlobalCreate()` | `Promise<void>` | Initializes the SMPL global tables. Called automatically for `useSmpl` / `useMlow`. |
| `opusGlobalFree()` | `Promise<void>` | Releases the SMPL global tables. |

Both factories share one lazily-loaded WASM module, so the first call pays the
load cost and later calls are cheap.

## Encoder

`OpusEncoderHandle`, returned by `createEncoder`.

### Properties

| Property | Type | Description |
| --- | --- | --- |
| `application` | `Application` | Resolved encoding mode (read-only). |
| `channels` | `1 \| 2` | Channel count (read-only). |
| `frameSize` | `number` | Default frame size in samples/channel (read-only). |
| `sampleRate` | `SampleRate` | Sample rate in Hz (read-only). |

### Methods

| Method | Returns | Description |
| --- | --- | --- |
| `encode(pcm, options?)` | `Uint8Array` | Encode one Int16 PCM frame (`Int16Array \| Uint8Array`) to a packet. |
| `encodeFloat(pcm, options?)` | `Uint8Array` | Encode one `Float32Array` frame (`[-1, 1]`) to a packet. |
| `encodeFrames(frames, options?)` | `Uint8Array[]` | Encode several Int16 frames. |
| `encodeFloatFrames(frames, options?)` | `Uint8Array[]` | Encode several Float32 frames. |
| `encodeInto(pcm, target, options?)` | `number` | Encode into a caller-owned `Uint8Array`; returns bytes written. See [Writing into your own buffer](encoding.md#writing-into-your-own-buffer). |
| `encodeFloatInto(pcm, target, options?)` | `number` | Float32 variant of `encodeInto`. |
| `encodeSecondary(options?)` | `Uint8Array` | RED payload: a low-rate copy of the frame just encoded, sent with the next packet. See [RED (secondary encoder)](packet-loss.md#red-secondary-encoder). |
| `setSecondaryBitrate(bitrate)` | `void` | Bitrate for the RED secondary encoder. |
| `setSecondaryComplexity(n)` | `void` | Complexity `0`-`10` for the RED secondary encoder. |
| `setBitrate(bitrate)` | `void` | Set bitrate (`number \| "auto" \| "max"`). |
| `getBitrate()` | `number` | Read the resolved bitrate. |
| `setComplexity(n)` | `void` | Set complexity `0`–`10`. |
| `setSignal(signal)` | `void` | Set the [`Signal`](#signal) hint. |
| `setMaxBandwidth(bw)` | `void` | Cap coded [`Bandwidth`](#bandwidth). |
| `setVbr(enabled)` | `void` | Toggle variable bitrate. |
| `setVbrConstraint(enabled)` | `void` | Toggle constrained VBR. |
| `setFec(enabled)` | `void` | Toggle in-band FEC. |
| `setPacketLossPercent(n)` | `void` | Set expected loss `0`–`100`. |
| `setDtx(enabled)` | `void` | Toggle discontinuous transmission. |
| `getLookahead()` | `number` | Encoder algorithmic delay in samples. |
| `getInDtx()` | `boolean` | Whether the encoder is currently in a DTX period. |
| `encoderCtl(request, value)` | `void` | Integer-setter [CTL passthrough](ctl.md). |
| `free()` | `void` | Release the underlying encoder. Idempotent. |
| `[Symbol.dispose]()` | `void` | Calls `free()`; enables `using` declarations. |

`encode` accepts an `Int16Array` or a `Uint8Array` view of the same little-endian
bytes. The frame must contain exactly `frameSize * channels` samples.

## Decoder

`OpusDecoderHandle`, returned by `createDecoder`.

### Properties

| Property | Type | Description |
| --- | --- | --- |
| `channels` | `1 \| 2` | Channel count (read-only). |
| `maxFrameSize` | `number` | Output capacity in samples/channel (read-only). |
| `sampleRate` | `SampleRate` | Sample rate in Hz (read-only). |

### Methods

| Method | Returns | Description |
| --- | --- | --- |
| `decode(packet, options?)` | `Int16Array` | Decode one packet (or `null` for PLC) to Int16 PCM. |
| `decodeFloat(packet, options?)` | `Float32Array` | Decode one packet (or `null`) to Float32 PCM. |
| `decodeInto(target, packet, options?)` | `number` | Decode into a caller-owned `Int16Array`; returns samples per channel. See [Decoding into your own buffer](decoding.md#decoding-into-your-own-buffer). |
| `decodeFloatInto(target, packet, options?)` | `number` | Float32 variant of `decodeInto`. |
| `decodeFrames(packets, options?)` | `Int16Array[]` | Decode several packets; `null` entries are concealed. |
| `decodeFloatFrames(packets, options?)` | `Float32Array[]` | Float32 batch variant. |
| `decodePacketLoss(frameSize?)` | `Int16Array` | Synthesize one PLC frame (defaults to 20 ms). |
| `decodePacketLossFloat(frameSize?)` | `Float32Array` | Float32 PLC variant. |
| `decoderCtl(request, value)` | `void` | Integer-setter [CTL passthrough](ctl.md). |
| `free()` | `void` | Release the underlying decoder. Idempotent. |
| `[Symbol.dispose]()` | `void` | Calls `free()`; enables `using` declarations. |

`decode(null, { frameSize })` is equivalent to `decodePacketLoss(frameSize)`.

## Repacketizer

`MlowRepacketizerHandle`, returned by `createRepacketizer`. Full walkthrough in
[Repacketizer](repacketizer.md).

| Member | Returns | Description |
| --- | --- | --- |
| `useMlow` | `boolean` | Whether this instance emits the MLow multiframe layout (read-only). |
| `pack(frames, options?)` | `Uint8Array` | Pack up to 18 frames into one multiframe packet. Resets queued state. |
| `reset()` | `void` | Clear the queued frames. |
| `add(frame)` | `void` | Queue one frame for the next `out()`. |
| `getFrameCount()` | `number` | Frames queued so far. |
| `out(options?)` | `Uint8Array` | Emit every queued frame as one packet. |
| `outRange(begin, end, options?)` | `Uint8Array` | Emit `[begin, end)` of the queued frames. |
| `free()` | `void` | Release the underlying repacketizer. Idempotent. |
| `[Symbol.dispose]()` | `void` | Calls `free()`; enables `using` declarations. |

## Options

### EncoderOptions

Passed to `createEncoder`. All fields are optional.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `sampleRate` | `SampleRate` | `48000` | One of `8000`, `12000`, `16000`, `24000`, `48000`. |
| `channels` | `1 \| 2` | `2` | Mono or stereo. |
| `application` | `Application` | `Audio` | Encoding mode. |
| `bitrate` | `number \| "auto" \| "max"` | `64000` | Target bits per second. |
| `complexity` | `number` | `10` | `0`–`10`. |
| `signal` | `Signal` | `Auto` | Content hint. |
| `maxBandwidth` | `Bandwidth` | unset | Coded-bandwidth ceiling. |
| `vbr` | `boolean` | unset | Variable bitrate. |
| `vbrConstraint` | `boolean` | unset | Constrained VBR. |
| `fec` | `boolean` | `false` | In-band FEC. |
| `packetLossPercent` | `number` | `0` | `0`–`100`. |
| `dtx` | `boolean` | `false` | Discontinuous transmission. |
| `frameSize` | `number` | 20 ms | Default samples/channel per frame. |
| `useSmpl` | `boolean` | `false` | Use the SMPL/MLow coding path. Initializes the SMPL global tables. |

### DecoderOptions

Passed to `createDecoder`. All fields are optional.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `sampleRate` | `SampleRate` | `48000` | Must match the encoder. |
| `channels` | `1 \| 2` | `2` | Must match the encoder. |
| `maxFrameSize` | `number` | 120 ms | Output capacity in samples/channel. |
| `useSmpl` | `boolean` | `false` | Decode the SMPL/MLow path. |
| `useLpcPostfilter` | `boolean` | unset | Toggle the LPC postfilter. |

### RepacketizerOptions

Passed to `createRepacketizer`. All fields are optional.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `maxPacketBytes` | `number` | `4000` | Packed-packet ceiling; also sizes the `add()` staging area. |
| `useMlow` | `boolean` | `true` | Emit the MLow multiframe layout. |

### EncodeOptions

Passed per `encode` / `encodeFloat` call.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `frameSize` | `number` | encoder default | Samples/channel for this frame. |
| `maxPacketBytes` | `number` | `4000` | Output buffer ceiling. |

`encodeSecondary` accepts the same object but only reads `maxPacketBytes`.

### PackOptions

Passed per `pack` / `out` / `outRange` call.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `maxPacketBytes` | `number` | repacketizer default | Output buffer ceiling. |

### DecodeOptions

Passed per `decode` / `decodeFloat` call.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `decodeFec` | `boolean` | `false` | Recover a lost frame from this packet's FEC data. |
| `frameSize` | `number` | 20 ms | Frame size for PLC / FEC recovery. |
| `maxFrameSize` | `number` | decoder default | Output capacity for this call. |

## Enums and constants

### Application

| Member | Value |
| --- | --- |
| `Voip` | `2048` |
| `Audio` | `2049` |
| `RestrictedLowDelay` | `2051` |

### Signal

| Member | Value |
| --- | --- |
| `Auto` | `-1000` |
| `Voice` | `3001` |
| `Music` | `3002` |

### Bitrate

| Member | Value |
| --- | --- |
| `Auto` | `-1000` |
| `Max` | `-1` |

The string forms `"auto"` and `"max"` are accepted anywhere a `Bitrate` is.

### Bandwidth

| Member | Value |
| --- | --- |
| `Narrowband` | `1101` |
| `Mediumband` | `1102` |
| `Wideband` | `1103` |
| `Superwideband` | `1104` |
| `Fullband` | `1105` |

### MlowMode

Which coding mode a packet's TOC selects, reported as `toc.mode` by
[`getMlowPacketInfo`](packet-info.md#mlow-packets).

| Member | Value | Meaning |
| --- | --- | --- |
| `Celt` | `3` | CELT fallback (TOC bits 7-6 are `0b11`). |
| `Smpl` | `4` | Native SMPL/MLow layout. |

### EncoderCtl / DecoderCtl

Integer request codes for the CTL passthrough. See the
[CTL reference](ctl.md) for the full list and usage.

## Errors

`OpusError extends Error` is thrown when libopus itself returns an error code:

| Member | Type | Description |
| --- | --- | --- |
| `code` | `number` | The libopus error code. |
| `codeName` | `string \| undefined` | Named libopus error code, such as `"InvalidPacket"`, when known. |
| `operation` | `string \| undefined` | The call that failed (e.g. `"decode"`). |
| `message` | `string` | Human-readable libopus error text. |

Use `OpusErrorCode` for named libopus error codes and `isOpusError(error)` for
realm-safe checks.

Argument validation (wrong frame size, out-of-range option, empty packet,
non-allow-listed CTL) throws a plain `RangeError` _before_ reaching WASM. Using a
handle after `free()` throws a plain `Error`. See [Errors & validation](errors.md)
for the full breakdown.

## Limits

| Constraint | Allowed values |
| --- | --- |
| Sample rate | `8000`, `12000`, `16000`, `24000`, `48000` Hz |
| Channels | `1` (mono), `2` (stereo) |
| Encode frame duration | `2.5`, `5`, `10`, `20`, `40`, `60` ms |
| Decode output capacity | up to `120` ms |
| PLC / FEC frame size | multiples of `2.5` ms, from `2.5` to `120` ms |

## Types

These TypeScript types are exported for annotating your own code:

```ts
import type {
  OpusEncoderHandle,
  OpusDecoderHandle,
  MlowRepacketizerHandle,
  EncoderOptions,
  DecoderOptions,
  RepacketizerOptions,
  EncodeOptions,
  DecodeOptions,
  PackOptions,
  PacketInfoOptions,
  OpusPacketInfo,
  MlowPacketInfo,
  MlowPacketToc,
  SampleRate,
  ChannelCount,
} from "libmlow-wasm";
```
