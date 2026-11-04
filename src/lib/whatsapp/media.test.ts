import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_IMAGE_BYTES, MediaError, downloadWhatsAppMedia, imageMimeFromBytes, oggOpusDurationMs, trustedMediaHost,
} from "./media";
import { joinBytes as join, oggPage, voiceNote } from "./media-fixtures";

test("an Ogg/Opus voice note's length comes from its own headers", () => {
  assert.equal(oggOpusDurationMs(voiceNote(5)), 5000);
  assert.equal(oggOpusDurationMs(voiceNote(181)), 181000);
  // A last page with no packet ending on it (granule -1) is skipped for the one before.
  assert.equal(oggOpusDurationMs(voiceNote(7, true)), 7000);
});

test("anything that is not Ogg/Opus has no length, so it is refused rather than guessed", () => {
  assert.equal(oggOpusDurationMs(new Uint8Array(100)), null);
  // MP3 (ID3) and M4A (ftyp) arrive when somebody forwards an audio file.
  assert.equal(oggOpusDurationMs(join(new TextEncoder().encode("ID3"), new Uint8Array(80))), null);
  assert.equal(oggOpusDurationMs(join(new Uint8Array([0, 0, 0, 0x20]), new TextEncoder().encode("ftypM4A "), new Uint8Array(80))), null);
  // Ogg, but Vorbis rather than Opus.
  const vorbis = oggPage(BigInt(0), 2, join(new Uint8Array([1]), new TextEncoder().encode("vorbis"), new Uint8Array(30)));
  assert.equal(oggOpusDurationMs(join(vorbis, oggPage(BigInt(48000), 4, new Uint8Array(3)))), null);
});

test("an image is what its first bytes say, never what it was labelled", () => {
  assert.equal(imageMimeFromBytes(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0])), "image/jpeg");
  assert.equal(imageMimeFromBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), "image/png");
  assert.equal(imageMimeFromBytes(join(new TextEncoder().encode("RIFF"), new Uint8Array(4), new TextEncoder().encode("WEBPVP8 "))), "image/webp");
  assert.equal(imageMimeFromBytes(new TextEncoder().encode("<svg xmlns=")), null);
  assert.equal(imageMimeFromBytes(new TextEncoder().encode("GIF89a......")), null);
  assert.equal(imageMimeFromBytes(new Uint8Array([0xff, 0xd8])), null);
});

test("Meta's token is sent only to Meta's own hosts", () => {
  assert.equal(trustedMediaHost("https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1"), true);
  assert.equal(trustedMediaHost("https://scontent.xx.fbcdn.net/v/t1"), true);
  for (const bad of [
    "http://lookaside.fbsbx.com/x", "https://fbsbx.com.evil.test/x", "https://evilfbsbx.com/x", "https://fbsbx.com/x",
    "https://user:pw@lookaside.fbsbx.com/x", "https://lookaside.fbsbx.com:8443/x", "not a url", "file:///etc/passwd",
  ]) assert.equal(trustedMediaHost(bad), false, bad);
});

const ENV = {
  WHATSAPP_GRAPH_VERSION: "v25.0", WHATSAPP_PHONE_NUMBER_ID: "100", WHATSAPP_BUSINESS_ACCOUNT_ID: "200",
  WHATSAPP_BUSINESS_PHONE: "27820000000", WHATSAPP_ACCESS_TOKEN: "test-access", WHATSAPP_APP_SECRET: "test-app",
  WHATSAPP_VERIFY_TOKEN: "test-verify",
};

async function withMeta(handler: (url: URL, init?: RequestInit) => Response | Promise<Response>, run: (calls: URL[]) => Promise<void>) {
  const saved = Object.fromEntries(Object.keys(ENV).map((k) => [k, process.env[k]]));
  const original = globalThis.fetch;
  const calls: URL[] = [];
  Object.assign(process.env, ENV);
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push(url);
    return handler(url, init);
  };
  try { await run(calls); } finally {
    globalThis.fetch = original;
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

test("a media id resolves to a Meta URL and the bytes come back, with the token on both calls", async () => {
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]);
  await withMeta((url, init) => {
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer test-access");
    if (url.hostname === "graph.facebook.com") {
      assert.equal(url.pathname, "/v25.0/media-123");
      return json({ url: "https://lookaside.fbsbx.com/m?mid=123", file_size: bytes.length });
    }
    assert.equal(url.hostname, "lookaside.fbsbx.com");
    return new Response(bytes);
  }, async (calls) => {
    const got = await downloadWhatsAppMedia("media-123", MAX_IMAGE_BYTES);
    assert.deepEqual([...got], [...bytes]);
    assert.equal(calls.length, 2);
  });
});

test("an untrusted URL, an oversized file and a failed lookup are refused before any download", async () => {
  for (const [scenario, expected] of [
    ["untrusted", "media_untrusted_host"], ["declared_large", "media_too_large"], ["lookup_404", "media_lookup_failed"],
    ["streamed_large", "media_too_large"], ["cdn_500", "media_download_failed"],
  ] as const) {
    await withMeta((url) => {
      if (url.hostname === "graph.facebook.com") {
        if (scenario === "lookup_404") return json({ error: "not found" }, 404);
        return json({
          url: scenario === "untrusted" ? "https://attacker.example.test/collect" : "https://lookaside.fbsbx.com/m",
          ...(scenario === "declared_large" ? { file_size: 50 } : {}),
        });
      }
      assert.notEqual(url.hostname, "attacker.example.test", "the token must never reach another host");
      if (scenario === "cdn_500") return new Response("no", { status: 500 });
      return new Response(new Uint8Array(scenario === "streamed_large" ? 64 : 4));
    }, async (calls) => {
      await assert.rejects(downloadWhatsAppMedia("media-1", 40), (error: unknown) =>
        error instanceof MediaError && error.code === expected, scenario);
      if (scenario !== "streamed_large" && scenario !== "cdn_500") assert.equal(calls.length, 1, `${scenario}: no download`);
    });
  }
  // A media id with characters Meta never issues is not even looked up.
  await withMeta(() => { throw new Error("no request expected"); }, async (calls) => {
    await assert.rejects(downloadWhatsAppMedia("../me?fields=x", 40), MediaError);
    assert.equal(calls.length, 0);
  });
});
