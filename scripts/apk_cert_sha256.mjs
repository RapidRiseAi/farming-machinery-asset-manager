#!/usr/bin/env node
// The SHA-256 of the signing certificate in an APK's v2 signature (APK Signature Scheme v2,
// block id 0x7109871a), printed as colon-separated hex: the form Play Console, keytool and
// ANDROID_CERT_SHA256 (App Links, docs/ANDROID.md) use. No Android SDK needed; keytool cannot
// read an APK signed with v2 only, which is what a build with minSdk 24 makes.
//
// usage: node scripts/apk_cert_sha256.mjs <app.apk> [expected sha256]
//        exits 1 when an expected fingerprint is given and the APK's is different.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const [apkPath, expected] = process.argv.slice(2);
if (!apkPath) {
  console.error("usage: node scripts/apk_cert_sha256.mjs <app.apk> [expected sha256]");
  process.exit(2);
}
const b = readFileSync(apkPath);
// The End of Central Directory record names where the central directory starts; the APK
// Signing Block ends immediately before it, with its size and the magic in its last 24 bytes.
const eocd = b.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
if (eocd < 0) throw new Error("not a zip file");
const cdOffset = b.readUInt32LE(eocd + 16);
if (b.toString("latin1", cdOffset - 16, cdOffset) !== "APK Sig Block 42") throw new Error("no APK Signing Block: not signed with v2");
const blockSize = Number(b.readBigUInt64LE(cdOffset - 24));
let p = cdOffset - blockSize - 8 + 8;
const end = cdOffset - 24;
let cert = null;
while (p < end) {
  const len = Number(b.readBigUInt64LE(p));
  if (b.readUInt32LE(p + 8) === 0x7109871a) {
    // value: signers (length-prefixed) > first signer (length-prefixed) > signed data
    // (length-prefixed) > digests (length-prefixed, skipped) > certificates (length-prefixed)
    // > first certificate (length-prefixed DER).
    let q = p + 12 + 4 + 4 + 4;
    q += 4 + b.readUInt32LE(q);
    q += 4;
    const certLen = b.readUInt32LE(q);
    cert = b.subarray(q + 4, q + 4 + certLen);
    break;
  }
  p += 8 + len;
}
if (!cert || cert[0] !== 0x30) throw new Error("no v2 signer certificate found");
const sha = createHash("sha256").update(cert).digest("hex").toUpperCase().match(/../g).join(":");
console.log(sha);
if (expected && expected.trim().toUpperCase() !== sha) {
  console.error(`FAILED: signed with ${sha}, expected ${expected.trim().toUpperCase()}`);
  process.exit(1);
}
