/**
 * The playing time of a RIFF/WAVE recording, read from its own header.
 *
 * The AI hearing is billed per second of audio, and the server receives the whole file,
 * so the duration it bills is measured here rather than trusted from the browser. Walks
 * the chunk list instead of assuming the canonical 44-byte layout, because a header may
 * carry extra chunks (LIST, fact) before the audio.
 */
export function wavDurationMs(bytes: Uint8Array): number | null {
  if (bytes.length < 12) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;

  let byteRate = 0;
  let dataBytes = -1;
  for (let offset = 12; offset + 8 <= bytes.length; ) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt " && size >= 16 && body + 16 <= bytes.length) byteRate = view.getUint32(body + 8, true);
    if (id === "data") {
      // A streamed recording may say 0 or 0xFFFFFFFF; then the audio runs to the end.
      dataBytes = size === 0 || size === 0xffffffff || body + size > bytes.length ? bytes.length - body : size;
      break;
    }
    offset = body + size + (size % 2);
  }
  if (byteRate <= 0 || dataBytes < 0) return null;
  return Math.round((dataBytes * 1000) / byteRate);
}

/** The only format the app's recorder writes (offline-voice.ts encodePcmWav at 16 kHz). */
const PCM_FORMAT = { audioFormat: 1, channels: 1, sampleRate: 16_000, byteRate: 32_000, blockAlign: 2, bits: 16 } as const;

/**
 * The duration of a recording in exactly the recorder's format (PCM, 16 kHz, mono,
 * 16-bit), or null for anything else.
 *
 * What the AI hearing is held and billed for must not come from a header the client wrote
 * however it liked: a byteRate of four billion would make a two-megabyte clip "0 ms", and
 * μ-law or MP3 in a RIFF wrapper is minutes of real audio the provider would decode and
 * charge for. So every format field must match, and the data must really be there.
 */
export function strictPcmDurationMs(bytes: Uint8Array): number | null {
  if (bytes.length < 44) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;
  let format = false;
  for (let offset = 12; offset + 8 <= bytes.length; ) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (body + size > bytes.length && id !== "data") return null;
    if (id === "fmt ") {
      if (size < 16) return null;
      format =
        view.getUint16(body, true) === PCM_FORMAT.audioFormat &&
        view.getUint16(body + 2, true) === PCM_FORMAT.channels &&
        view.getUint32(body + 4, true) === PCM_FORMAT.sampleRate &&
        view.getUint32(body + 8, true) === PCM_FORMAT.byteRate &&
        view.getUint16(body + 12, true) === PCM_FORMAT.blockAlign &&
        view.getUint16(body + 14, true) === PCM_FORMAT.bits;
      if (!format) return null;
    }
    if (id === "data") {
      if (!format || size === 0 || body + size > bytes.length || size % PCM_FORMAT.blockAlign !== 0) return null;
      return Math.round((size * 1000) / PCM_FORMAT.byteRate);
    }
    offset = body + size + (size % 2);
  }
  return null;
}
