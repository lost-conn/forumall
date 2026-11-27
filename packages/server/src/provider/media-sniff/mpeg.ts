/**
 * MPEG audio and video streams: MP3 (MPEG-1/2/2.5 audio frames, optionally
 * behind an ID3v2 tag), AAC in ADTS frames, MPEG program streams and MPEG
 * transport streams.
 *
 * None of these has a container header, so a stream is confirmed by walking
 * its frames or packets: each frame header must be valid and the next frame
 * must start exactly where its length says (or the stream must end there).
 * A lone sync pattern or tag prefix is never enough.
 */
import { type SniffedType, hasAscii, hasBytes, sniffed } from "./common.ts";

/** Bitrates (kbit/s) by index, per [MPEG version 1 or 2/2.5][layer I, II, III]. */
const BITRATES: readonly (readonly (readonly number[])[])[] = [
  [
    [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  ],
  [
    [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  ],
];
/** Sample rates (Hz) by index, per MPEG version bits (`00` 2.5, `10` 2, `11` 1). */
const SAMPLE_RATES: Readonly<Record<number, readonly number[]>> = {
  0: [11025, 12000, 8000],
  2: [22050, 24000, 16000],
  3: [44100, 48000, 32000],
};
/** ADTS sampling-frequency indexes 0–12 are defined (ISO/IEC 14496-3 §1.6.3.4). */
const ADTS_MAX_FREQUENCY_INDEX = 12;

/** A parsed audio frame header: the frame's length and what must match in the next. */
interface AudioFrame {
  readonly length: number;
  /** The stream parameters every frame of one stream repeats. */
  readonly signature: number;
  readonly adts: boolean;
}

/**
 * The MP3 or ADTS frame whose header starts at `offset`, or `null` when there
 * is no valid header there: free-format and invalid bitrates, reserved
 * versions, layers and sample rates are all refused.
 */
function audioFrameAt(bytes: Uint8Array, offset: number): AudioFrame | null {
  const [b0, b1, b2, b3, b4, b5] = bytes.subarray(offset, offset + 6);
  if (b0 !== 0xff || b1 === undefined || b2 === undefined || (b1 & 0xe0) !== 0xe0) return null;
  if ((b1 & 0xf6) === 0xf0) {
    // ADTS: 12-bit sync, ID, layer `00`; the 13-bit frame length spans bytes 3–5.
    if (b3 === undefined || b4 === undefined || b5 === undefined) return null;
    if (((b2 >> 2) & 0x0f) > ADTS_MAX_FREQUENCY_INDEX) return null;
    const length = ((b3 & 0x03) << 11) | (b4 << 3) | (b5 >> 5);
    const headerLength = b1 & 0x01 ? 7 : 9; // protection_absent
    if (length < headerLength) return null;
    return { length, signature: (b1 << 8) | (b2 & 0xfc), adts: true };
  }
  const version = (b1 >> 3) & 0b11; // 01 is reserved
  const layerBits = (b1 >> 1) & 0b11; // 00 is reserved; 11 = I, 10 = II, 01 = III
  const bitrateIndex = b2 >> 4; // 0000 is free format, 1111 is invalid
  const rateIndex = (b2 >> 2) & 0b11; // 11 is reserved
  const sampleRate = SAMPLE_RATES[version]?.[rateIndex];
  if (layerBits === 0 || bitrateIndex === 0 || bitrateIndex === 0xf || sampleRate === undefined) {
    return null;
  }
  const layer = 4 - layerBits; // 1, 2 or 3
  const kbps = BITRATES[version === 0b11 ? 0 : 1]?.[layer - 1]?.[bitrateIndex] ?? 0;
  const padding = (b2 >> 1) & 1;
  const bitrate = kbps * 1000;
  let length: number;
  if (layer === 1) length = (Math.floor((12 * bitrate) / sampleRate) + padding) * 4;
  else if (layer === 3 && version !== 0b11)
    length = Math.floor((72 * bitrate) / sampleRate) + padding;
  else length = Math.floor((144 * bitrate) / sampleRate) + padding;
  return { length, signature: (b1 << 8) | (b2 & 0x0c), adts: false };
}

/** How many consecutive frames confirm a stream that does not end sooner. */
const FRAMES_TO_CONFIRM = 3;

/**
 * Whether an audio stream of consistent frames starts at `offset`: frames
 * follow one another exactly until {@link FRAMES_TO_CONFIRM} are seen, or the
 * last one ends the file (optionally before a 128-byte ID3v1 `TAG`).
 */
function audioStreamAt(bytes: Uint8Array, offset: number): AudioFrame | null {
  const first = audioFrameAt(bytes, offset);
  if (first === null) return null;
  let frame = first;
  let at = offset;
  for (let seen = 1; ; seen++) {
    at += frame.length;
    if (at === bytes.length || (at + 128 === bytes.length && hasAscii(bytes, at, "TAG"))) {
      return first;
    }
    if (seen === FRAMES_TO_CONFIRM) return first;
    const next = audioFrameAt(bytes, at);
    if (next === null || next.signature !== first.signature) return null;
    frame = next;
  }
}

const MP3 = sniffed("audio/mpeg", "audio/mp3", "audio/mpeg3");
const AAC = sniffed("audio/aac", "audio/x-aac", "audio/aacp");

/** An MP3 or ADTS stream starting at the first byte. */
function sniffAudioFrames(bytes: Uint8Array): SniffedType | null {
  const stream = audioStreamAt(bytes, 0);
  if (stream === null) return null;
  return stream.adts ? AAC : MP3;
}

/**
 * An ID3v2 tag (id3.org ID3v2.3/2.4 §3.1: version 2–4, no undefined flags, a
 * syncsafe size) followed — after any zero padding — by an MP3 or ADTS stream.
 */
function sniffId3(bytes: Uint8Array): SniffedType | null {
  if (!hasAscii(bytes, 0, "ID3")) return null;
  const [major, revision, flags, ...size] = bytes.subarray(3, 10);
  if (major === undefined || major < 2 || major > 4 || revision === 0xff) return null;
  const undefinedFlags = major === 2 ? 0x3f : major === 3 ? 0x1f : 0x0f;
  if (flags === undefined || (flags & undefinedFlags) !== 0) return null;
  if (size.length !== 4 || size.some((b) => b >= 0x80)) return null;
  const tagSize = size.reduce((acc, b) => acc * 0x80 + b, 0);
  const footer = major === 4 && flags & 0x10 ? 10 : 0;
  let at = 10 + tagSize + footer;
  while (bytes[at] === 0) at++;
  const stream = audioStreamAt(bytes, at);
  if (stream === null) return null;
  return stream.adts ? AAC : MP3;
}

/**
 * An MPEG-1 or MPEG-2 program stream pack header (ISO/IEC 11172-1 §2.4.3.2,
 * 13818-1 §2.5.3.3) with its marker bits set, followed by the next start code.
 */
function sniffProgramStream(bytes: Uint8Array): SniffedType | null {
  if (!hasBytes(bytes, 0, [0x00, 0x00, 0x01, 0xba])) return null;
  const b = (i: number) => bytes[i] ?? 0;
  let next: number;
  if ((b(4) & 0xc4) === 0x44) {
    // MPEG-2: '01', SCR with markers, mux rate, markers, reserved, stuffing length.
    const markers = b(6) & 0x04 && b(8) & 0x04 && b(9) & 0x01 && (b(12) & 0x03) === 0x03;
    if (!markers) return null;
    next = 14 + (b(13) & 0x07);
  } else if ((b(4) & 0xf1) === 0x21) {
    // MPEG-1: '0010', SCR with markers, mux rate between markers.
    if (!(b(6) & 0x01 && b(8) & 0x01 && b(9) & 0x80 && b(11) & 0x01)) return null;
    next = 12;
  } else {
    return null;
  }
  return hasBytes(bytes, next, [0x00, 0x00, 0x01]) ? sniffed("video/mpeg") : null;
}

/**
 * An MPEG video elementary stream starting with a sequence header (ISO/IEC
 * 11172-2 §2.4.2.3): non-zero dimensions, a defined aspect ratio and frame
 * rate, and the marker bit.
 */
function sniffVideoSequence(bytes: Uint8Array): SniffedType | null {
  if (!hasBytes(bytes, 0, [0x00, 0x00, 0x01, 0xb3]) || bytes.length < 12) return null;
  const b = (i: number) => bytes[i] ?? 0;
  const width = (b(4) << 4) | (b(5) >> 4);
  const height = ((b(5) & 0x0f) << 8) | b(6);
  const aspect = b(7) >> 4;
  const frameRate = b(7) & 0x0f;
  if (width === 0 || height === 0 || aspect === 0 || aspect === 0xf) return null;
  if (frameRate === 0 || frameRate > 8 || !(b(10) & 0x20)) return null;
  return sniffed("video/mpeg");
}

const TS_PACKET = 188;

/**
 * An MPEG transport stream (ISO/IEC 13818-1 §2.4.3): a whole number of
 * 188-byte packets, every one starting with the `0x47` sync byte, free of the
 * transport-error flag and with a defined adaptation-field control, and among
 * them a program association table (PID 0, table id 0).
 */
function sniffTransportStream(bytes: Uint8Array): SniffedType | null {
  if (bytes.length < 2 * TS_PACKET || bytes.length % TS_PACKET !== 0) return null;
  let sawPat = false;
  for (let at = 0; at < bytes.length; at += TS_PACKET) {
    const [sync, b1 = 0, b2 = 0, b3 = 0] = bytes.subarray(at, at + 4);
    if (sync !== 0x47 || b1 & 0x80 || (b3 & 0x30) === 0) return null;
    const pid = ((b1 & 0x1f) << 8) | b2;
    if (pid === 0 && b1 & 0x40 && !sawPat) {
      // payload_unit_start: the payload opens with a pointer field, then the table id.
      const payload = at + 4 + (b3 & 0x20 ? 1 + (bytes[at + 4] ?? 0) : 0);
      const pointer = bytes[payload] ?? TS_PACKET;
      sawPat = payload + 1 + pointer < at + TS_PACKET && bytes[payload + 1 + pointer] === 0x00;
    }
  }
  return sawPat ? sniffed("video/mp2t") : null;
}

/** The MPEG stream checks, in the order the sniffer tries them. */
export const MPEG_SNIFFERS = [
  sniffId3,
  sniffAudioFrames,
  sniffProgramStream,
  sniffVideoSequence,
  sniffTransportStream,
] as const;
