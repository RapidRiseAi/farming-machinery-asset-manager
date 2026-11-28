import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  compareAppVersions, isHttpsUrl, parseAppVersion, parseUpdatePolicy, PLAY_STORE_URL, updateNeed, versionCodeOf,
} from "./app-version";

const policy = (latest: string, minimum: string) => ({ latest, minimum, url: PLAY_STORE_URL });

test("a version is three whole numbers; anything else is not one", () => {
  assert.deepEqual(parseAppVersion("1.1.0"), [1, 1, 0]);
  assert.deepEqual(parseAppVersion(" 2.10.99 "), [2, 10, 99]);
  for (const bad of ["1.1", "1.1.0.0", "v1.1.0", "1.100.0", "1.1.100", "0.9.0", "", "1.1.0-beta", null, 110, undefined]) {
    assert.equal(parseAppVersion(bad), null, String(bad));
  }
});

test("versions compare by number, not as text", () => {
  const v = (s: string) => parseAppVersion(s)!;
  assert.ok(compareAppVersions(v("1.10.0"), v("1.9.0")) > 0, "10 is newer than 9");
  assert.ok(compareAppVersions(v("1.0.0"), v("1.1.0")) < 0);
  assert.equal(compareAppVersions(v("2.3.4"), v("2.3.4")), 0);
  assert.ok(compareAppVersions(v("2.0.0"), v("1.99.99")) > 0);
});

test("the build number always rises with the version, and every build before this one was 1", () => {
  assert.equal(versionCodeOf([1, 1, 0]), 10100);
  assert.equal(versionCodeOf([1, 0, 1]), 10001);
  const order = ["1.0.1", "1.0.99", "1.1.0", "1.99.99", "2.0.0", "10.0.0"].map((s) => versionCodeOf(parseAppVersion(s)!));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.ok(order[0] > 1, "above the build number of every app built before 28 Nov 2026");
});

test("older than the minimum must update, older than the latest is asked, the rest are left alone", () => {
  assert.equal(updateNeed("1.0.0", policy("1.1.0", "1.0.0")), "optional");
  assert.equal(updateNeed("1.0.0", policy("1.2.0", "1.1.0")), "required");
  assert.equal(updateNeed("1.1.0", policy("1.1.0", "1.0.0")), "none");
  assert.equal(updateNeed("1.2.0", policy("1.1.0", "1.0.0")), "none", "a newer test build than the published one");
  assert.equal(updateNeed("1.1.0", policy("1.2.0", "1.1.0")), "optional", "exactly the minimum is still allowed");
});

test("an app whose version cannot be read is never locked out", () => {
  assert.equal(updateNeed("", policy("9.0.0", "9.0.0")), "none");
  assert.equal(updateNeed("1.0", policy("9.0.0", "9.0.0")), "none");
});

test("only a well-formed policy with an https link is acted on", () => {
  assert.deepEqual(parseUpdatePolicy(policy("1.1.0", "1.0.0")), policy("1.1.0", "1.0.0"));
  assert.equal(parseUpdatePolicy(policy("1.0.0", "1.1.0")), null, "minimum above latest");
  assert.equal(parseUpdatePolicy({ latest: "1.1.0", minimum: "1.0.0", url: "http://example.com/app.apk" }), null);
  assert.equal(parseUpdatePolicy({ latest: "1.1.0", minimum: "1.0.0", url: "javascript:alert(1)" }), null);
  assert.equal(parseUpdatePolicy({ latest: "1.1.0", minimum: "1.0.0" }), null);
  assert.equal(parseUpdatePolicy(null), null);
  assert.equal(parseUpdatePolicy("1.1.0"), null);
  // Built, not written out: the committed-password scan rightly refuses a literal one.
  const withLogin = new URL("https://example.com/");
  withLogin.username = "someone";
  withLogin.password = "x".repeat(8);
  assert.equal(isHttpsUrl(withLogin.toString()), false, "no credentials in a link");
  assert.equal(isHttpsUrl(`https://example.com/${"a".repeat(2000)}`), false);
});

test("native/version.json is the app's only version, and the Android build reads it", () => {
  const file = JSON.parse(readFileSync("native/version.json", "utf8")) as { version: string };
  const v = parseAppVersion(file.version);
  assert.ok(v, `native/version.json has a valid version, not "${file.version}"`);
  const gradle = readFileSync("android/app/build.gradle", "utf8");
  assert.match(gradle, /native\/version\.json/, "build.gradle reads native/version.json");
  assert.doesNotMatch(gradle, /versionCode\s+\d/, "no build number typed into build.gradle");
  assert.doesNotMatch(gradle, /versionName\s+"/, "no version typed into build.gradle");
  assert.match(gradle, /\* 10000 \+ .* \* 100 \+/, "the same build-number rule as versionCodeOf");
});
