/**
 * The §5.8 media sniffer: which renderable media format an upload's bytes
 * are, for the `mime` guard in `provider/media-type.ts`.
 *
 * "Confirmed" means structurally checked, never a bare magic-number match:
 * each format's check parses its header far enough (sizes that must fit,
 * fields with fixed or bounded values, the next box, chunk, frame or packet
 * starting where the previous one says) that text — which has no zero bytes,
 * and none of the high bytes these headers need — cannot pass. A format that
 * offers too little structure to check without decoding (a bare JPEG XL
 * codestream, AMR) is not sniffed at all, so it is never confirmed.
 *
 * Pure JS, no decoding library; reads only the bytes it needs.
 */
import type { SniffedType, Sniffer } from "./common.ts";
import { IMAGE_SNIFFERS } from "./image.ts";
import { sniffIsoBmff } from "./iso-bmff.ts";
import { MPEG_SNIFFERS } from "./mpeg.ts";
import { CHUNKED_SNIFFERS } from "./riff-iff.ts";
import { STREAM_SNIFFERS } from "./streams.ts";

export type { SniffedType } from "./common.ts";

/** Every format check, in order; each is exact, so the order only affects speed. */
const SNIFFERS: readonly Sniffer[] = [
  ...IMAGE_SNIFFERS,
  sniffIsoBmff,
  ...CHUNKED_SNIFFERS,
  ...STREAM_SNIFFERS,
  ...MPEG_SNIFFERS,
];

/**
 * The renderable media format `bytes` structurally is, or `null` when it is
 * none this sniffer can confirm. Never throws.
 */
export function sniffMediaType(bytes: Uint8Array): SniffedType | null {
  for (const sniff of SNIFFERS) {
    const match = sniff(bytes);
    if (match !== null) return match;
  }
  return null;
}
