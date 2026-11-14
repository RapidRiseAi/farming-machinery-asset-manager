/**
 * Structurally real media files built in memory, for tests of the upload pipeline: the
 * headers are exactly what the formats specify, the payloads are filler. Kept out of the
 * repository as binaries (the repo is public and a real recording or photo is someone's).
 */

const bytes = (...parts: Array<number[] | Uint8Array | string>): Uint8Array => {
  const chunks = parts.map((p) => (typeof p === "string" ? new TextEncoder().encode(p) : p instanceof Uint8Array ? p : Uint8Array.from(p)));
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
};
const be16 = (v: number) => [(v >> 8) & 0xff, v & 0xff];
const be32 = (v: number) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
const le32 = (v: number) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];

/** A JPEG whose frame header says width x height, with an EXIF block of `exifBytes` first. */
export function jpeg(width: number, height: number, exifBytes = 0, fill = 0): Uint8Array {
  const exif = exifBytes > 0 ? bytes([0xff, 0xe1], be16(exifBytes + 2), new Uint8Array(exifBytes)) : new Uint8Array(0);
  return bytes([0xff, 0xd8], [0xff, 0xe0], be16(16), "JFIF\0", [1, 1, 0, 0, 1, 0, 1, 0, 0], exif,
    [0xff, 0xc0], be16(17), [8], be16(height), be16(width), [3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1],
    new Uint8Array(fill), [0xff, 0xd9]);
}

export function png(width: number, height: number): Uint8Array {
  return bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], be32(13), "IHDR", be32(width), be32(height), [8, 2, 0, 0, 0], be32(0));
}

export function webpExtended(width: number, height: number): Uint8Array {
  const w = width - 1;
  const h = height - 1;
  return bytes("RIFF", le32(30), "WEBP", "VP8X", le32(10), [0, 0, 0, 0],
    [w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff], [h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff]);
}

export function heic(width: number, height: number): Uint8Array {
  return bytes(be32(24), "ftyp", "heic", be32(0), "mif1", "heic",
    be32(20), "ispe", be32(0), be32(width), be32(height));
}

/** A small but whole PDF; `truncate` cuts off its end, as an interrupted download would. */
export function pdf(truncate = false, padTo = 0): Uint8Array {
  const body = "%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n";
  const pad = padTo > body.length ? " ".repeat(padTo - body.length - 40) : "";
  const end = "xref\n0 1\ntrailer << >>\nstartxref\n9\n%%EOF\n";
  const whole = new TextEncoder().encode(body + pad + end);
  return truncate ? whole.subarray(0, whole.length - 24) : whole;
}

/** An executable (Windows PE) that a browser might be told is "image/jpeg". */
export function executable(): Uint8Array {
  return bytes("MZ", new Uint8Array(62), "PE\0\0");
}

function oggPage(granule: bigint, serial: number, sequence: number, packet: Uint8Array, first = false): Uint8Array {
  const segments: number[] = [];
  let left = packet.length;
  while (left >= 255) { segments.push(255); left -= 255; }
  segments.push(left);
  const header = new Uint8Array(27);
  header.set(new TextEncoder().encode("OggS"), 0);
  header[5] = first ? 2 : 0;
  new DataView(header.buffer).setBigInt64(6, granule, true);
  new DataView(header.buffer).setUint32(14, serial, true);
  new DataView(header.buffer).setUint32(18, sequence, true);
  header[26] = segments.length;
  return bytes(header, segments, packet);
}

/**
 * An Ogg/Opus recording of `seconds`, about `bitsPerSecond` in size: the OpusHead page,
 * then one page a second whose granule position advances 48,000 samples.
 */
export function oggOpus(seconds: number, bitsPerSecond = 48_000, preSkip = 312): Uint8Array {
  const head = oggPage(BigInt(0), 7, 0, bytes("OpusHead", [1, 1], [preSkip & 0xff, preSkip >> 8], le32(48000), [0, 0, 0]), true);
  const pages = [head];
  const perSecond = Math.max(1, Math.round(bitsPerSecond / 8) - 40);
  for (let s = 1; s <= seconds; s++) {
    pages.push(oggPage(BigInt(s * 48_000 + preSkip), 7, s, new Uint8Array(Math.min(perSecond, 254 * 255))));
  }
  return bytes(...pages);
}

/** An Ogg stream whose first packet is Theora video. */
export function oggTheora(): Uint8Array {
  return oggPage(BigInt(0), 9, 0, bytes([0x80], "theora", new Uint8Array(40)), true);
}

const ebml = (id: number[], payload: Uint8Array | number[]): Uint8Array => {
  const data = payload instanceof Uint8Array ? payload : Uint8Array.from(payload);
  return bytes(id, [0x08], be32(data.length), data);
};
const unknownSize = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];

/**
 * A MediaRecorder-style WebM: no Duration in Info (it is written while recording),
 * unknown-size Segment and Clusters, one Opus track (or a video track too), a cluster every
 * 10 seconds with blocks every second, filler to about `bitsPerSecond`.
 */
export function webmOpus(seconds: number, options: { codec?: string; video?: boolean; bitsPerSecond?: number } = {}): Uint8Array {
  const codec = new TextEncoder().encode(options.codec ?? "A_OPUS");
  const header = ebml([0x1a, 0x45, 0xdf, 0xa3], bytes(ebml([0x42, 0x82], new TextEncoder().encode("webm"))));
  const info = ebml([0x15, 0x49, 0xa9, 0x66], ebml([0x2a, 0xd7, 0xb1], be32(1_000_000)));
  const audioTrack = ebml([0xae], bytes(ebml([0xd7], [1]), ebml([0x83], [2]), ebml([0x86], codec)));
  const videoTrack = options.video ? ebml([0xae], bytes(ebml([0xd7], [2]), ebml([0x83], [1]), ebml([0x86], new TextEncoder().encode("V_VP8")))) : new Uint8Array(0);
  const tracks = ebml([0x16, 0x54, 0xae, 0x6b], bytes(audioTrack, videoTrack));
  const perBlock = Math.max(4, Math.round((options.bitsPerSecond ?? 48_000) / 8) - 20);
  const clusters: Uint8Array[] = [];
  for (let start = 0; start < seconds; start += 10) {
    const blocks: Uint8Array[] = [];
    for (let s = 0; s < Math.min(10, seconds - start); s++) {
      const offset = s * 1000;
      blocks.push(ebml([0xa3], bytes([0x81], be16(offset), [0x80], new Uint8Array(perBlock))));
    }
    clusters.push(bytes([0x1f, 0x43, 0xb6, 0x75], unknownSize, ebml([0xe7], be32(start * 1000)), ...blocks));
  }
  return bytes(header, [0x18, 0x53, 0x80, 0x67], unknownSize, info, tracks, ...clusters);
}

const box = (type: string, ...payload: Array<Uint8Array | number[] | string>) => {
  const data = bytes(...payload);
  return bytes(be32(data.length + 8), type, data);
};

/** An MP4/AAC recording with its length in mvhd (or 0 there, and fragments, as Safari writes). */
export function mp4Aac(seconds: number, options: { fragmented?: boolean; codec?: string; video?: boolean } = {}): Uint8Array {
  const scale = 1000;
  const mvhd = box("mvhd", [0, 0, 0, 0], be32(0), be32(0), be32(scale), be32(options.fragmented ? 0 : seconds * scale), new Uint8Array(80));
  const mdhd = box("mdhd", [0, 0, 0, 0], be32(0), be32(0), be32(48_000), be32(0), new Uint8Array(4));
  const hdlr = (kind: string) => box("hdlr", [0, 0, 0, 0], be32(0), kind, new Uint8Array(12), "x\0");
  const stsd = box("stsd", [0, 0, 0, 0], be32(1), be32(36), options.codec ?? "mp4a", new Uint8Array(28));
  const sound = box("trak", box("mdia", mdhd, hdlr("soun"), box("minf", box("stbl", stsd))));
  const picture = options.video ? box("trak", box("mdia", hdlr("vide"))) : new Uint8Array(0);
  const moov = box("moov", mvhd, sound, picture);
  const fragments: Uint8Array[] = [];
  if (options.fragmented) {
    for (let s = 0; s < seconds; s += 5) {
      fragments.push(box("moof", box("traf", box("tfdt", [0, 0, 0, 0], be32(s * 48_000)))), box("mdat", new Uint8Array(1000)));
    }
  }
  return bytes(box("ftyp", "M4A ", be32(0), "isom", "M4A "), moov, ...fragments);
}
