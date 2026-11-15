import assert from "node:assert/strict";
import test from "node:test";
import { preparePhoto, reducedSize, type PhotoCodec } from "./compress";
import { PHOTO_JPEG_QUALITY, PHOTO_JPEG_QUALITY_MIN, PHOTO_LONG_EDGE } from "@/lib/limits";
import { pdf } from "./media-fixtures";

/** A stand-in codec: records what the reducer asked for, returns a blob of a chosen size. */
function codec(width: number, height: number, outBytes: number | "fail" | "decode-fails") {
  const asked: Array<{ width: number; height: number; quality: number }> = [];
  let closed = 0;
  const c: PhotoCodec = {
    async decode() {
      if (outBytes === "decode-fails") throw new Error("cannot decode HEIC here");
      return { width, height, close: () => { closed++; } };
    },
    async encode(_image, w, h, quality) {
      asked.push({ width: w, height: h, quality });
      if (outBytes === "fail") throw new Error("canvas lost");
      return new Blob([new Uint8Array(outBytes as number)], { type: "image/jpeg" });
    },
  };
  return { c, asked, closed: () => closed };
}

const photo = (bytes: number, type = "image/jpeg") => new Blob([new Uint8Array(bytes)], { type });

test("scenario 27: a phone photo is reduced to the long edge at a quality that keeps fine print", async () => {
  const { c, asked, closed } = codec(4032, 3024, 900_000);
  const out = await preparePhoto(photo(4_500_000), false, c);
  assert.equal(out.reduced, true);
  assert.deepEqual(asked, [{ width: PHOTO_LONG_EDGE, height: 1920, quality: PHOTO_JPEG_QUALITY }]);
  assert.ok(asked[0].quality >= PHOTO_JPEG_QUALITY_MIN, "never below the minimum quality");
  assert.ok(Math.max(out.stored.width ?? 0, out.stored.height ?? 0) === PHOTO_LONG_EDGE);
  assert.deepEqual(out.original, { width: 4032, height: 3024, bytes: 4_500_000 });
  assert.equal(out.mime, "image/jpeg");
  assert.equal(closed(), 1, "the decoded image is released");
});

test("scenario 27: a portrait photo keeps its long edge upright, and a small photo is never enlarged", () => {
  assert.deepEqual(reducedSize(3024, 4032), { width: 1920, height: PHOTO_LONG_EDGE });
  assert.deepEqual(reducedSize(1200, 900), { width: 1200, height: 900 });
});

test("scenario 27: keep original is honoured: the same file, untouched, nothing decoded", async () => {
  const { c, asked } = codec(4032, 3024, 900_000);
  const original = photo(4_500_000);
  const out = await preparePhoto(original, true, c);
  assert.equal(out.file, original);
  assert.equal(out.reduced, false);
  assert.equal(out.kept, "asked");
  assert.deepEqual(asked, []);
});

test("scenario 27: PDFs are never altered", async () => {
  const { c, asked } = codec(1, 1, 1);
  const document = new Blob([pdf() as BlobPart], { type: "application/pdf" });
  const out = await preparePhoto(document, false, c);
  assert.equal(out.file, document);
  assert.equal(out.kept, "not_a_photo");
  assert.deepEqual(asked, []);
});

test("when reducing fails or would not help, the original is kept and says why", async () => {
  const bigger = await preparePhoto(photo(300_000), false, codec(2000, 1500, 400_000).c);
  assert.equal(bigger.reduced, false);
  assert.equal(bigger.kept, "not_smaller");
  const broken = await preparePhoto(photo(300_000), false, codec(2000, 1500, "fail").c);
  assert.equal(broken.kept, "encode_failed");
  const heic = await preparePhoto(photo(3_000_000, "image/heic"), false, codec(0, 0, "decode-fails").c);
  assert.equal(heic.kept, "cannot_decode");
  assert.equal(heic.mime, "image/heic", "a photo the browser cannot read goes as it is");
});
