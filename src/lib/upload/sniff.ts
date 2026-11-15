/**
 * What a stored file really is, from its own bytes (BRIEF section 10): never its name, its
 * extension or the type the browser declared. Pure and synchronous, so it is tested on
 * byte arrays; the server reads the head and the tail of the object from Storage and asks
 * these functions.
 *
 * Images: the type, and the pixel dimensions from the header alone (PNG IHDR, the JPEG
 * frame header, the WebP VP8/VP8L/VP8X header, the HEIF `ispe` property), so a file whose
 * header claims enormous dimensions is refused without decoding a pixel.
 * PDFs: the header and an end-of-file marker; a truncated or garbled PDF is refused.
 * Recordings: the container (WebM, Ogg, MP4), that it carries audio and no video, that
 * the codec is one MediaRecorder produces (Opus, AAC), and the length where the container
 * says it (WebM Duration or its last cluster, the last Ogg page, MP4 mvhd or the last
 * fragment).
 */

import {
  IMAGE_MAX_EDGE, IMAGE_MAX_PIXELS, MEDIA_CLASSES, type MediaClass, type StoredMime,
} from "@/lib/limits";

export type SniffFailure =
  | "empty" | "too_large" | "wrong_type" | "malformed" | "too_many_pixels"
  | "too_long" | "unsupported_codec" | "video_not_supported";

export type Inspection =
  | { ok: true; mime: StoredMime; bytes: number; durationMs: number | null; width: number | null; height: number | null }
  | { ok: false; reason: SniffFailure };

const ascii = (b: Uint8Array, at: number, n: number) =>
  at < 0 || at + n > b.length ? "" : String.fromCharCode(...b.subarray(at, at + n));
const u16be = (b: Uint8Array, at: number) => (b[at] << 8) | b[at + 1];
const u32be = (b: Uint8Array, at: number) => ((b[at] << 24) >>> 0) + (b[at + 1] << 16) + (b[at + 2] << 8) + b[at + 3];
const u24le = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8) | (b[at + 2] << 16);
const u32le = (b: Uint8Array, at: number) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16)) + ((b[at + 3] << 24) >>> 0);
const u64be = (b: Uint8Array, at: number) => u32be(b, at) * 2 ** 32 + u32be(b, at + 4);

const HEIF_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1"]);

/** The container its first bytes declare, or null for anything we do not store. */
export function sniffContainer(head: Uint8Array):
  | "image/jpeg" | "image/png" | "image/webp" | "image/heic" | "application/pdf"
  | "audio/webm" | "audio/ogg" | "audio/mp4" | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (head.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => head[i] === v)) return "image/png";
  if (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 4) === "WEBP") return "image/webp";
  if (ascii(head, 0, 5) === "%PDF-") return "application/pdf";
  if (ascii(head, 0, 4) === "OggS") return "audio/ogg";
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return "audio/webm";
  if (ascii(head, 4, 4) === "ftyp") {
    const brands = [ascii(head, 8, 4)];
    const end = Math.min(u32be(head, 0), head.length);
    for (let at = 16; at + 4 <= end; at += 4) brands.push(ascii(head, at, 4));
    return brands.some((brand) => HEIF_BRANDS.has(brand)) ? "image/heic" : "audio/mp4";
  }
  return null;
}

// == Images ===================================================================

/** Width and height from the header, or null when the header cannot be read. */
export function imageDimensions(head: Uint8Array, mime: string): { width: number; height: number } | null {
  if (mime === "image/png") {
    if (ascii(head, 12, 4) !== "IHDR") return null;
    return { width: u32be(head, 16), height: u32be(head, 20) };
  }
  if (mime === "image/jpeg") return jpegDimensions(head);
  if (mime === "image/webp") {
    const chunk = ascii(head, 12, 4);
    if (chunk === "VP8 " && head.length >= 30 && head[23] === 0x9d && head[24] === 0x01 && head[25] === 0x2a) {
      return { width: (head[26] | (head[27] << 8)) & 0x3fff, height: (head[28] | (head[29] << 8)) & 0x3fff };
    }
    if (chunk === "VP8L" && head.length >= 25 && head[20] === 0x2f) {
      const bits = u32le(head, 21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8X" && head.length >= 30) return { width: u24le(head, 24) + 1, height: u24le(head, 27) + 1 };
    return null;
  }
  if (mime === "image/heic") {
    // The largest `ispe` (image spatial extents) property is the primary image's size.
    let best: { width: number; height: number } | null = null;
    for (let at = 4; at + 16 <= head.length; at++) {
      if (head[at] !== 0x69 || ascii(head, at, 4) !== "ispe") continue;
      const width = u32be(head, at + 8);
      const height = u32be(head, at + 12);
      if (!best || width * height > best.width * best.height) best = { width, height };
    }
    return best;
  }
  return null;
}

function jpegDimensions(b: Uint8Array): { width: number; height: number } | null {
  let at = 2;
  while (at + 9 < b.length) {
    if (b[at] !== 0xff) return null;
    const marker = b[at + 1];
    if (marker === 0xff) { at += 1; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) return null; // end, or scan data before any frame header
    const length = u16be(b, at + 2);
    if (length < 2) return null;
    // Start-of-frame markers C0 to CF, except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: u16be(b, at + 5), width: u16be(b, at + 7) };
    }
    at += 2 + length;
  }
  return null;
}

// == PDF ======================================================================

/** A PDF starts with its version and ends (give or take trailing whitespace) with %%EOF. */
export function pdfLooksWhole(head: Uint8Array, tail: Uint8Array): boolean {
  if (!/^%PDF-[12]\.\d/.test(ascii(head, 0, 8))) return false;
  const end = new TextDecoder("latin1").decode(tail.subarray(Math.max(0, tail.length - 2048)));
  return end.includes("%%EOF") && end.includes("startxref");
}

// == Recordings ===============================================================

type AudioFacts = { durationMs: number | null; hasVideo: boolean; codecOk: boolean; readable: boolean };

export function audioFacts(head: Uint8Array, tail: Uint8Array, mime: string): AudioFacts {
  if (mime === "audio/ogg") return oggFacts(head, tail);
  if (mime === "audio/webm") return webmFacts(head, tail);
  if (mime === "audio/mp4") return mp4Facts(head, tail);
  return { durationMs: null, hasVideo: false, codecOk: false, readable: false };
}

function oggFacts(head: Uint8Array, tail: Uint8Array): AudioFacts {
  if (head.length < 47 || ascii(head, 0, 4) !== "OggS") return { durationMs: null, hasVideo: false, codecOk: false, readable: false };
  const packet = 27 + head[26];
  const firstPacket = ascii(head, packet, 8);
  if (ascii(head, packet + 1, 6) === "theora") return { durationMs: null, hasVideo: true, codecOk: false, readable: true };
  if (firstPacket !== "OpusHead") return { durationMs: null, hasVideo: false, codecOk: false, readable: true };
  const preSkip = head[packet + 10] | (head[packet + 11] << 8);
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  for (let i = tail.length - 27; i >= 0; i--) {
    if (tail[i] !== 0x4f || ascii(tail, i, 4) !== "OggS" || tail[i + 4] !== 0) continue;
    const granule = view.getBigInt64(i + 6, true);
    if (granule < BigInt(0)) continue;
    const samples = Number(granule) - preSkip;
    return { durationMs: samples > 0 ? Math.round(samples / 48) : 0, hasVideo: false, codecOk: true, readable: true };
  }
  return { durationMs: null, hasVideo: false, codecOk: true, readable: true };
}

// -- WebM (EBML) ---------------------------------------------------------------

/** An EBML variable-length integer at `at`: its value and width, or null. */
function vint(b: Uint8Array, at: number, keepMarker = false): { value: number; width: number } | null {
  const first = b[at];
  if (first === undefined || first === 0) return null;
  let width = 1;
  while (!(first & (0x80 >> (width - 1)))) width++;
  if (at + width > b.length) return null;
  let value = keepMarker ? first : first & (0xff >> width);
  let allOnes = value === (0xff >> width);
  for (let i = 1; i < width; i++) {
    value = value * 256 + b[at + i];
    if (b[at + i] !== 0xff) allOnes = false;
  }
  // All ones means "size unknown" (a live recording's Segment and Clusters).
  return { value: !keepMarker && allOnes ? -1 : value, width };
}

type Element = { id: number; dataAt: number; size: number; next: number };
function element(b: Uint8Array, at: number): Element | null {
  const id = vint(b, at, true);
  if (!id) return null;
  const size = vint(b, at + id.width);
  if (!size) return null;
  const dataAt = at + id.width + size.width;
  return { id: id.value, dataAt, size: size.value, next: size.value < 0 ? -1 : dataAt + size.value };
}

const EBML = { segment: 0x18538067, info: 0x1549a966, tracks: 0x1654ae6b, cluster: 0x1f43b675,
  trackEntry: 0xae, trackType: 0x83, codecId: 0x86, duration: 0x4489, timecodeScale: 0x2ad7b1,
  timecode: 0xe7, simpleBlock: 0xa3, blockGroup: 0xa0, block: 0xa1 };

function readFloat(b: Uint8Array, at: number, size: number): number | null {
  const view = new DataView(b.buffer, b.byteOffset + at, size);
  return size === 4 ? view.getFloat32(0) : size === 8 ? view.getFloat64(0) : null;
}
function readUint(b: Uint8Array, at: number, size: number): number {
  let v = 0;
  for (let i = 0; i < size; i++) v = v * 256 + b[at + i];
  return v;
}

function webmFacts(head: Uint8Array, tail: Uint8Array): AudioFacts {
  const header = element(head, 0);
  if (!header || header.id !== 0x1a45dfa3) return { durationMs: null, hasVideo: false, codecOk: false, readable: false };
  const docType = /webm|matroska/.exec(ascii(head, header.dataAt, Math.max(0, Math.min(header.size, 64))));
  if (!docType) return { durationMs: null, hasVideo: false, codecOk: false, readable: false };
  const segment = element(head, header.next);
  if (!segment || segment.id !== EBML.segment) return { durationMs: null, hasVideo: false, codecOk: false, readable: false };

  let scale = 1_000_000;
  let declared: number | null = null;
  let hasVideo = false;
  let audioCodecs: string[] = [];
  let at = segment.dataAt;
  while (at < head.length) {
    const child = element(head, at);
    if (!child || child.id === EBML.cluster || child.next < 0) break;
    if (child.id === EBML.info) {
      for (let i = child.dataAt; i < Math.min(child.next, head.length);) {
        const e = element(head, i);
        if (!e || e.next < 0) break;
        if (e.id === EBML.timecodeScale) scale = readUint(head, e.dataAt, e.size);
        if (e.id === EBML.duration) declared = readFloat(head, e.dataAt, e.size);
        i = e.next;
      }
    }
    if (child.id === EBML.tracks) {
      for (let i = child.dataAt; i < Math.min(child.next, head.length);) {
        const entry = element(head, i);
        if (!entry || entry.next < 0) break;
        if (entry.id === EBML.trackEntry) {
          let type = 0;
          let codec = "";
          for (let j = entry.dataAt; j < Math.min(entry.next, head.length);) {
            const e = element(head, j);
            if (!e || e.next < 0) break;
            if (e.id === EBML.trackType) type = readUint(head, e.dataAt, e.size);
            if (e.id === EBML.codecId) codec = ascii(head, e.dataAt, e.size).replace(/\0+$/, "");
            j = e.next;
          }
          if (type === 1) hasVideo = true;
          if (type === 2) audioCodecs = [...audioCodecs, codec];
        }
        i = entry.next;
      }
    }
    at = child.next;
  }
  const codecOk = audioCodecs.length > 0 && audioCodecs.every((codec) => codec === "A_OPUS");
  if (declared !== null && Number.isFinite(declared) && declared > 0) {
    return { durationMs: Math.round((declared * scale) / 1_000_000), hasVideo, codecOk, readable: true };
  }
  return { durationMs: lastWebmTimestampMs(tail, scale), hasVideo, codecOk, readable: true };
}

/**
 * MediaRecorder's WebM has no Duration (it is written while recording), so the length is the
 * last cluster's timecode plus its last block's offset, found from the end of the file.
 */
function lastWebmTimestampMs(tail: Uint8Array, scale: number): number | null {
  for (let i = tail.length - 8; i >= 0; i--) {
    if (tail[i] !== 0x1f || tail[i + 1] !== 0x43 || tail[i + 2] !== 0xb6 || tail[i + 3] !== 0x75) continue;
    const cluster = element(tail, i);
    if (!cluster) continue;
    const first = element(tail, cluster.dataAt);
    if (!first || first.id !== EBML.timecode || first.size < 1 || first.size > 8) continue;
    const base = readUint(tail, first.dataAt, first.size);
    let last = 0;
    let j = first.next;
    while (j > 0 && j < tail.length) {
      const e = element(tail, j);
      if (!e || e.next < 0 || e.next > tail.length) break;
      const blockAt = e.id === EBML.simpleBlock ? e.dataAt : e.id === EBML.blockGroup ? element(tail, e.dataAt)?.dataAt ?? -1 : -1;
      if (blockAt >= 0) {
        const track = vint(tail, blockAt);
        if (track) {
          const offset = (tail[blockAt + track.width] << 8) | tail[blockAt + track.width + 1];
          last = Math.max(last, offset >= 0x8000 ? offset - 0x10000 : offset);
        }
      }
      j = e.next;
    }
    return Math.round(((base + last) * scale) / 1_000_000);
  }
  return null;
}

// -- MP4 -----------------------------------------------------------------------

function findBox(b: Uint8Array, type: string, from = 0, to = b.length): number {
  for (let at = from; at + 8 <= to; at++) {
    if (b[at + 4] === type.charCodeAt(0) && ascii(b, at + 4, 4) === type) return at;
  }
  return -1;
}

function mp4Facts(head: Uint8Array, tail: Uint8Array): AudioFacts {
  const moov = findBox(head, "moov");
  if (moov < 0) return { durationMs: null, hasVideo: false, codecOk: false, readable: false };
  // Handlers: 'soun' is sound, 'vide' a picture track.
  let hasVideo = false;
  let hasSound = false;
  for (let at = findBox(head, "hdlr", moov); at >= 0; at = findBox(head, "hdlr", at + 8)) {
    const handler = ascii(head, at + 16, 4);
    if (handler === "vide") hasVideo = true;
    if (handler === "soun") hasSound = true;
  }
  const stsd = findBox(head, "stsd", moov);
  const sample = stsd >= 0 ? ascii(head, stsd + 20, 4) : "";
  const codecOk = hasSound && (sample === "mp4a" || sample === "Opus");

  let timescale = 0;
  let duration = 0;
  const mvhd = findBox(head, "mvhd", moov);
  if (mvhd >= 0) {
    const version = head[mvhd + 8];
    timescale = version === 1 ? u32be(head, mvhd + 28) : u32be(head, mvhd + 20);
    duration = version === 1 ? u64be(head, mvhd + 32) : u32be(head, mvhd + 24);
  }
  if (timescale > 0 && duration > 0) {
    return { durationMs: Math.round((duration / timescale) * 1000), hasVideo, codecOk, readable: true };
  }
  // A fragmented recording (Safari) says its length per fragment: the last fragment's
  // decode time, in the sound track's own timescale (mdhd), is within a fragment of the end.
  const mdhd = findBox(head, "mdhd", moov);
  const trackScale = mdhd >= 0 ? (head[mdhd + 8] === 1 ? u32be(head, mdhd + 28) : u32be(head, mdhd + 20)) : 0;
  let lastTfdt = -1;
  for (let at = findBox(tail, "tfdt"); at >= 0; at = findBox(tail, "tfdt", at + 8)) lastTfdt = at;
  if (trackScale > 0 && lastTfdt >= 0) {
    const decode = tail[lastTfdt + 8] === 1 ? u64be(tail, lastTfdt + 12) : u32be(tail, lastTfdt + 12);
    return { durationMs: Math.round((decode / trackScale) * 1000), hasVideo, codecOk, readable: true };
  }
  return { durationMs: null, hasVideo, codecOk, readable: true };
}

// == The whole judgement ======================================================

/**
 * Judge a stored object of `bytes` bytes, given its first and last bytes, against the class
 * the upload was reserved for. `declared` is what the browser said; the answer's `mime` is
 * what the bytes say, and the caller refuses a mismatch through the database.
 */
export function inspect(head: Uint8Array, tail: Uint8Array, bytes: number, mediaClass: MediaClass): Inspection {
  if (bytes <= 0 || head.length === 0) return { ok: false, reason: "empty" };
  const spec = MEDIA_CLASSES[mediaClass];
  if (bytes > spec.maxBytes) return { ok: false, reason: "too_large" };
  const container = sniffContainer(head);
  if (!container || !(spec.mimes as readonly string[]).includes(container)) return { ok: false, reason: "wrong_type" };

  if (container.startsWith("image/")) {
    const size = imageDimensions(head, container);
    if (!size || size.width <= 0 || size.height <= 0) return { ok: false, reason: "malformed" };
    if (size.width > IMAGE_MAX_EDGE || size.height > IMAGE_MAX_EDGE || size.width * size.height > IMAGE_MAX_PIXELS) {
      return { ok: false, reason: "too_many_pixels" };
    }
    return { ok: true, mime: container, bytes, durationMs: null, width: size.width, height: size.height };
  }
  if (container === "application/pdf") {
    return pdfLooksWhole(head, tail)
      ? { ok: true, mime: container, bytes, durationMs: null, width: null, height: null }
      : { ok: false, reason: "malformed" };
  }
  const facts = audioFacts(head, tail, container);
  if (!facts.readable) return { ok: false, reason: "malformed" };
  if (facts.hasVideo) return { ok: false, reason: "video_not_supported" };
  if (!facts.codecOk) return { ok: false, reason: "unsupported_codec" };
  if (spec.maxMs !== null && facts.durationMs !== null && facts.durationMs > spec.maxMs) return { ok: false, reason: "too_long" };
  return { ok: true, mime: container, bytes, durationMs: facts.durationMs, width: null, height: null };
}
