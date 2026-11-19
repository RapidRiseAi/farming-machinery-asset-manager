import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  addPoints, afterSend, backoffMs, BATCH_SIZE, emptyQueue, MAX_AGE_MS, MAX_POINTS, nextBatch, outcomeOf, prune, readQueue,
  type QueuedPoint,
} from "./position-queue";
import { inAppPath } from "./links";
import { assetLinks } from "./asset-links";

const NOW = Date.UTC(2026, 10, 19, 12, 0);
const point = (minutesAgo: number, lat = -25.7): QueuedPoint =>
  ({ lat, lng: 28.2, at: new Date(NOW - minutesAgo * 60_000).toISOString(), speed: 60, accuracy: 8 });

// == The queue ==============================================================================
test("a queue belongs to one person: another person's, or a broken one, is not read", () => {
  const q = addPoints(emptyQueue("u1", "s1"), [point(1)], NOW);
  const raw = JSON.stringify(q);
  assert.equal(readQueue(raw, "u1")?.points.length, 1);
  assert.equal(readQueue(raw, "u2"), null, "a different person signed in");
  assert.equal(readQueue(raw, null), null, "nobody signed in");
  assert.equal(readQueue("{not json", "u1"), null);
  assert.equal(readQueue(JSON.stringify({ owner: "u1", sessionId: "s1", points: "x" }), "u1"), null);
});

test("points older than a day are dropped (the server would refuse them); the newest are kept under the cap", () => {
  const q = addPoints(emptyQueue("u1", "s1"), [point(60 * 25), point(5), point(1)], NOW);
  assert.equal(q.points.length, 2);
  const many = Array.from({ length: MAX_POINTS + 10 }, (_, i) => point(0, -25 - i / 10000));
  const capped = addPoints(emptyQueue("u1", "s1"), many, NOW);
  assert.equal(capped.points.length, MAX_POINTS);
  assert.equal(capped.points.at(-1)!.lat, many.at(-1)!.lat, "the oldest go first");
  const aged = { ...q, points: [point(60 * 25), ...q.points] };
  assert.equal(prune(aged, NOW).points.length, 2);
  assert.ok(MAX_AGE_MS === 24 * 3_600_000);
});

test("batches are the front of the queue, at most 200, and wait out a backoff", () => {
  const q = addPoints(emptyQueue("u1", "s1"), Array.from({ length: 450 }, () => point(2)), NOW);
  assert.equal(nextBatch(q, NOW).length, BATCH_SIZE);
  const sent = afterSend(q, "sent", BATCH_SIZE, NOW);
  assert.equal(sent.points.length, 250);
  const failed = afterSend(sent, "retry", BATCH_SIZE, NOW);
  assert.equal(failed.points.length, 250, "nothing is lost on a failed send");
  assert.deepEqual(nextBatch(failed, NOW), [], "not before the backoff");
  assert.equal(nextBatch(failed, NOW + backoffMs(1)).length, BATCH_SIZE);
});

test("what each answer from /api/positions means", () => {
  assert.equal(outcomeOf(200), "sent");
  assert.equal(outcomeOf(0), "retry", "no network");
  assert.equal(outcomeOf(503), "retry");
  assert.equal(outcomeOf(401), "signed_out", "kept until the person signs in again");
  for (const s of [400, 402, 403, 404, 409]) assert.equal(outcomeOf(s), "stop", `status ${s}`);
  const q = addPoints(emptyQueue("u1", "s1"), [point(1), point(2)], NOW);
  assert.deepEqual(afterSend(q, "stop", 2, NOW).points, [], "a drive that ended is not retried forever");
  assert.equal(afterSend(q, "signed_out", 2, NOW).points.length, 2);
});

test("the backoff grows to at most five minutes", () => {
  assert.equal(backoffMs(1), 5_000);
  assert.equal(backoffMs(2), 10_000);
  assert.equal(backoffMs(20), 300_000);
});

// == App Links ==============================================================================
test("only the app's own https links open inside the app, with their sign-in codes", () => {
  const app = "https://app.fleet-wise.co.za";
  assert.equal(inAppPath("https://app.fleet-wise.co.za/auth/callback?code=abc#x", app), "/auth/callback?code=abc#x");
  assert.equal(inAppPath("http://app.fleet-wise.co.za/login", app), null, "not plain http");
  assert.equal(inAppPath("https://evil.example/login", app), null);
  assert.equal(inAppPath("https://app.fleet-wise.co.za.evil.example/login", app), null);
  assert.equal(inAppPath("za.co.fleetwise.app://login", app), null);
  assert.equal(inAppPath("not a url", app), null);
});

test("assetlinks.json names the app and its signing keys only once they are configured, and correctly", () => {
  const fp = Array.from({ length: 32 }, () => "AB").join(":");
  assert.deepEqual(assetLinks({}), []);
  assert.deepEqual(assetLinks({ ANDROID_CERT_SHA256: "not-a-fingerprint" }), []);
  const statement = assetLinks({ ANDROID_CERT_SHA256: `${fp.toLowerCase()}, ${fp}` });
  assert.equal(statement.length, 1);
  assert.deepEqual(statement[0].relation, ["delegate_permission/common.handle_all_urls"]);
  assert.equal(statement[0].target.package_name, "za.co.fleetwise.app");
  assert.deepEqual(statement[0].target.sha256_cert_fingerprints, [fp], "upper-cased, once");
  assert.deepEqual(assetLinks({ ANDROID_CERT_SHA256: fp, ANDROID_APP_ID: "Not A Package" }), []);
});

// == The Android project's promises (docs/ANDROID.md) =========================================
test("the manifest keeps the promises the store declarations and POPIA rely on", () => {
  const manifest = readFileSync("android/app/src/main/AndroidManifest.xml", "utf8");
  assert.match(manifest, /android:allowBackup="false"/);
  assert.match(manifest, /android:dataExtractionRules="@xml\/data_extraction_rules"/);
  assert.match(manifest, /android:usesCleartextTraffic="false"/);
  assert.match(manifest, /<intent-filter android:autoVerify="true">[^]*android:scheme="https" android:host="\$\{appLinkHost\}"/);
  assert.match(manifest, /BackgroundGeolocationService"\s+android:exported="false"\s+android:foregroundServiceType="location"/);
  assert.match(manifest, /ACCESS_BACKGROUND_LOCATION" tools:node="remove"/, "no background-location permission");
  assert.doesNotMatch(manifest, /<uses-permission android:name="android.permission.CAMERA"/, "the camera is used through the system's own picker");
  const plugin = readFileSync("node_modules/@capacitor-community/background-geolocation/android/src/main/AndroidManifest.xml", "utf8");
  assert.match(plugin, /FOREGROUND_SERVICE_LOCATION/);
  assert.doesNotMatch(plugin, /ACCESS_BACKGROUND_LOCATION/, "the plugin version in use asks for no background location either");
});

test("the app opens the hosted address, keeps its content security policy, and leaves page requests to the WebView", () => {
  const config = readFileSync("capacitor.config.ts", "utf8");
  assert.match(config, /"https:\/\/app\.fleet-wise\.co\.za"/);
  assert.match(config, /minWebViewVersion: 100/);
  assert.match(config, /errorPath: "offline\.html"/);
  assert.match(config, /CapacitorHttp: \{ enabled: false \}/, "fetch and XHR are not patched app-wide");
  assert.doesNotMatch(config, /cleartext: true|allowMixedContent: true|webContentsDebuggingEnabled: true/);
  const gitignore = readFileSync("android/.gitignore", "utf8");
  assert.match(gitignore, /^keystore\.properties$/m);
  assert.match(gitignore, /^\*\.jks$/m);
});
