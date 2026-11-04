/**
 * Test fixtures for WhatsApp media, shared by the media and worker tests. Not imported by
 * application code.
 */

/** One Ogg page: capture pattern, version 0, a granule position, one segment of `body`. */
export function oggPage(granule: bigint, headerType: number, body: Uint8Array): Uint8Array {
  const page = new Uint8Array(27 + 1 + body.length);
  page.set([0x4f, 0x67, 0x67, 0x53], 0);
  page[4] = 0;
  page[5] = headerType;
  new DataView(page.buffer).setBigInt64(6, granule, true);
  page[26] = 1;
  page[27] = body.length;
  page.set(body, 28);
  return page;
}

export function opusHead(preSkip: number): Uint8Array {
  const head = new Uint8Array(19);
  head.set(new TextEncoder().encode("OpusHead"), 0);
  head[8] = 1; head[9] = 1;
  head[10] = preSkip & 0xff; head[11] = preSkip >> 8;
  new DataView(head.buffer).setUint32(12, 48000, true);
  return head;
}

export function joinBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** A voice note `seconds` long, as WhatsApp records it: Opus at 48 kHz with a 312-sample pre-skip. */
export function voiceNote(seconds: number, trailingUnsetPage = false): Uint8Array {
  const pages = [
    oggPage(BigInt(0), 2, opusHead(312)),
    oggPage(BigInt(0), 0, new TextEncoder().encode("OpusTags")),
    oggPage(BigInt(312 + 48000 * seconds), trailingUnsetPage ? 0 : 4, new Uint8Array([1, 2, 3])),
  ];
  if (trailingUnsetPage) pages.push(oggPage(BigInt(-1), 4, new Uint8Array([4])));
  return joinBytes(...pages);
}

export const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
