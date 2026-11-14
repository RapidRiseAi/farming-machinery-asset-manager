import assert from "node:assert/strict";
import test from "node:test";
import { inspect, sniffContainer, imageDimensions, audioFacts } from "./sniff";
import { executable, heic, jpeg, mp4Aac, oggOpus, oggTheora, pdf, png, webmOpus, webpExtended } from "./media-fixtures";
import { PDF_MAX_BYTES, PHOTO_MAX_BYTES, VOICE_NOTE_MAX_BYTES, VOICE_NOTE_MAX_MS } from "@/lib/limits";

const whole = (file: Uint8Array) => ({ head: file, tail: file });

test("each format is recognised by its own bytes", () => {
  assert.equal(sniffContainer(jpeg(10, 10)), "image/jpeg");
  assert.equal(sniffContainer(png(10, 10)), "image/png");
  assert.equal(sniffContainer(webpExtended(10, 10)), "image/webp");
  assert.equal(sniffContainer(heic(10, 10)), "image/heic");
  assert.equal(sniffContainer(pdf()), "application/pdf");
  assert.equal(sniffContainer(oggOpus(2)), "audio/ogg");
  assert.equal(sniffContainer(webmOpus(2)), "audio/webm");
  assert.equal(sniffContainer(mp4Aac(2)), "audio/mp4");
  assert.equal(sniffContainer(executable()), null);
  assert.equal(sniffContainer(new TextEncoder().encode("<html><script>")), null);
});

test("image dimensions come from the header alone, past a 64 kB EXIF block", () => {
  assert.deepEqual(imageDimensions(jpeg(4032, 3024, 65_000), "image/jpeg"), { width: 4032, height: 3024 });
  assert.deepEqual(imageDimensions(png(800, 600), "image/png"), { width: 800, height: 600 });
  assert.deepEqual(imageDimensions(webpExtended(1920, 1080), "image/webp"), { width: 1920, height: 1080 });
  assert.deepEqual(imageDimensions(heic(4284, 5712), "image/heic"), { width: 4284, height: 5712 });
});

test("scenario 21: photos just below, exactly at and above 20 MB", () => {
  const { head, tail } = whole(jpeg(4000, 3000));
  assert.equal(inspect(head, tail, PHOTO_MAX_BYTES - 1, "photo").ok, true);
  assert.equal(inspect(head, tail, PHOTO_MAX_BYTES, "photo").ok, true);
  assert.deepEqual(inspect(head, tail, PHOTO_MAX_BYTES + 1, "photo"), { ok: false, reason: "too_large" });
});

test("scenario 21: PDFs just below, exactly at and above 50 MB, and a malformed one", () => {
  const { head, tail } = whole(pdf());
  assert.equal(inspect(head, tail, PDF_MAX_BYTES - 1, "pdf").ok, true);
  assert.equal(inspect(head, tail, PDF_MAX_BYTES, "pdf").ok, true);
  assert.deepEqual(inspect(head, tail, PDF_MAX_BYTES + 1, "pdf"), { ok: false, reason: "too_large" });
  const cut = pdf(true);
  assert.deepEqual(inspect(cut, cut, cut.length, "pdf"), { ok: false, reason: "malformed" });
});

test("scenario 21: spoofed types are refused on their bytes", () => {
  const asPdf = pdf();
  // A PDF named photo.jpg and declared image/jpeg is still a PDF: not a photo.
  assert.deepEqual(inspect(asPdf, asPdf, asPdf.length, "photo"), { ok: false, reason: "wrong_type" });
  // An executable with an image content type is nothing we store.
  const exe = executable();
  assert.deepEqual(inspect(exe, exe, exe.length, "photo"), { ok: false, reason: "wrong_type" });
  assert.deepEqual(inspect(exe, exe, exe.length, "pdf"), { ok: false, reason: "wrong_type" });
  // A photo where a recording was reserved.
  const photo = jpeg(10, 10);
  assert.deepEqual(inspect(photo, photo, photo.length, "voice"), { ok: false, reason: "wrong_type" });
});

test("scenario 21: an image whose header claims enormous dimensions is refused undecoded", () => {
  const bomb = png(65_535, 65_535);
  assert.deepEqual(inspect(bomb, bomb, bomb.length, "photo"), { ok: false, reason: "too_many_pixels" });
  const wide = jpeg(40_000, 10);
  assert.deepEqual(inspect(wide, wide, wide.length, "photo"), { ok: false, reason: "too_many_pixels" });
  // A 200-megapixel phone photo passes.
  const big = jpeg(16_320, 12_240);
  assert.equal(inspect(big, big, 30_000, "photo").ok, true);
  const broken = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  assert.deepEqual(inspect(broken, broken, broken.length, "photo"), { ok: false, reason: "malformed" });
});

test("recording lengths are read from Ogg, WebM and MP4 containers", () => {
  const ogg = oggOpus(90);
  assert.equal(audioFacts(ogg, ogg, "audio/ogg").durationMs, 90_000);
  const webm = webmOpus(45);
  assert.equal(audioFacts(webm, webm, "audio/webm").durationMs, 44_000, "the last block starts at 44 s");
  const mp4 = mp4Aac(30);
  assert.equal(audioFacts(mp4, mp4, "audio/mp4").durationMs, 30_000);
  const fragmented = mp4Aac(30, { fragmented: true });
  assert.equal(audioFacts(fragmented, fragmented, "audio/mp4").durationMs, 25_000, "the last fragment starts at 25 s");
});

test("scenario 21: voice notes just below, exactly at and above ten minutes and 20 MB", () => {
  const ten = oggOpus(600);
  const tenAndOne = oggOpus(601);
  const nine = oggOpus(599);
  assert.equal(inspect(nine, nine, nine.length, "voice").ok, true);
  const at = inspect(ten, ten, ten.length, "voice");
  assert.equal(at.ok && at.durationMs, VOICE_NOTE_MAX_MS);
  assert.deepEqual(inspect(tenAndOne, tenAndOne, tenAndOne.length, "voice"), { ok: false, reason: "too_long" });
  assert.equal(inspect(ten, ten, VOICE_NOTE_MAX_BYTES, "voice").ok, true);
  assert.deepEqual(inspect(ten, ten, VOICE_NOTE_MAX_BYTES + 1, "voice"), { ok: false, reason: "too_large" });
  // The head and tail are what the server reads from a large file: only its ends.
  const head = ten.subarray(0, 16_384);
  const tail = ten.subarray(ten.length - 16_384);
  const ends = inspect(head, tail, ten.length, "voice");
  assert.equal(ends.ok && ends.durationMs, VOICE_NOTE_MAX_MS);
});

test("a ten-minute recording at the recorder's bitrate fits 20 MB with room to spare", () => {
  const ten = oggOpus(600, 48_000);
  assert.ok(ten.length < VOICE_NOTE_MAX_BYTES / 4, `ten minutes at 48 kbps is ${ten.length} bytes`);
  // Even a browser that ignores the bitrate hint (128 kbps) stays under 20 MB.
  assert.ok((600 * 128_000) / 8 < VOICE_NOTE_MAX_BYTES);
});

test("scenario 21: unsupported codecs and video are refused", () => {
  const vorbisWebm = webmOpus(5, { codec: "A_VORBIS" });
  assert.deepEqual(inspect(vorbisWebm, vorbisWebm, vorbisWebm.length, "voice"), { ok: false, reason: "unsupported_codec" });
  const withVideo = webmOpus(5, { video: true });
  assert.deepEqual(inspect(withVideo, withVideo, withVideo.length, "voice"), { ok: false, reason: "video_not_supported" });
  const ac3 = mp4Aac(5, { codec: "ac-3" });
  assert.deepEqual(inspect(ac3, ac3, ac3.length, "voice"), { ok: false, reason: "unsupported_codec" });
  const mp4Video = mp4Aac(5, { video: true });
  assert.deepEqual(inspect(mp4Video, mp4Video, mp4Video.length, "voice"), { ok: false, reason: "video_not_supported" });
  const theora = oggTheora();
  assert.deepEqual(inspect(theora, theora, theora.length, "voice"), { ok: false, reason: "video_not_supported" });
  const webm = webmOpus(5);
  assert.equal(inspect(webm, webm, webm.length, "command_audio").ok, true);
});

test("an empty object is refused", () => {
  assert.deepEqual(inspect(new Uint8Array(0), new Uint8Array(0), 0, "photo"), { ok: false, reason: "empty" });
});
