/**
 * A ZIP file, written as it goes. Photos and PDFs are already compressed, so entries are
 * stored as they are: there is nothing to gain, and it keeps this small enough not to need a
 * library. One file is held in memory at a time, however many there are.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

type Written = { name: Uint8Array; crc: number; size: number; offset: number };

const UTF8_NAMES = 0x0800;

function localHeader(name: Uint8Array, crc: number, size: number): Uint8Array {
  const head = new DataView(new ArrayBuffer(30));
  head.setUint32(0, 0x04034b50, true);
  head.setUint16(4, 20, true);
  head.setUint16(6, UTF8_NAMES, true);
  head.setUint32(14, crc, true);
  head.setUint32(18, size, true);
  head.setUint32(22, size, true);
  head.setUint16(26, name.length, true);
  const out = new Uint8Array(30 + name.length);
  out.set(new Uint8Array(head.buffer), 0);
  out.set(name, 30);
  return out;
}

function centralEntry(e: Written): Uint8Array {
  const head = new DataView(new ArrayBuffer(46));
  head.setUint32(0, 0x02014b50, true);
  head.setUint16(4, 20, true);
  head.setUint16(6, 20, true);
  head.setUint16(8, UTF8_NAMES, true);
  head.setUint32(16, e.crc, true);
  head.setUint32(20, e.size, true);
  head.setUint32(24, e.size, true);
  head.setUint16(28, e.name.length, true);
  head.setUint32(42, e.offset, true);
  const out = new Uint8Array(46 + e.name.length);
  out.set(new Uint8Array(head.buffer), 0);
  out.set(e.name, 46);
  return out;
}

function endRecord(count: number, size: number, offset: number): Uint8Array {
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, count, true);
  end.setUint16(10, count, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  return new Uint8Array(end.buffer);
}

/**
 * Streams the entries as one ZIP. A file that cannot be read fails the whole download, on
 * purpose: somebody about to delete their account must never be handed half their files in a
 * download that looks finished.
 */
export function zipStream(entries: AsyncIterable<{ name: string; bytes: Uint8Array }>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const written: Written[] = [];
      let offset = 0;
      const put = (bytes: Uint8Array) => {
        controller.enqueue(bytes);
        offset += bytes.length;
      };
      try {
        for await (const entry of entries) {
          const name = encoder.encode(entry.name);
          const crc = crc32(entry.bytes);
          written.push({ name, crc, size: entry.bytes.length, offset });
          put(localHeader(name, crc, entry.bytes.length));
          put(entry.bytes);
        }
        const directoryStart = offset;
        for (const e of written) put(centralEntry(e));
        put(endRecord(written.length, offset - directoryStart, directoryStart));
        controller.close();
      } catch (failure) {
        controller.error(failure);
      }
    },
  });
}
