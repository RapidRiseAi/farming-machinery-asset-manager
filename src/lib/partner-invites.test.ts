import { test } from "node:test";
import assert from "node:assert/strict";

import {
  INVITE_DAYS,
  INVITE_TOKEN,
  cleanInviteCode,
  hashInviteCode,
  hashInviteToken,
  inviteExpiry,
  inviteUrl,
  newInviteSecrets,
} from "./partner-invites";

test("a link is unguessable and matches the shape the page accepts", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i += 1) {
    const { token } = newInviteSecrets();
    assert.match(token, INVITE_TOKEN);
    seen.add(token);
  }
  assert.equal(seen.size, 200);
});

test("a code is always six digits, leading zeros kept", () => {
  for (let i = 0; i < 500; i += 1) {
    assert.match(newInviteSecrets().code, /^\d{6}$/);
  }
});

test("the stored hashes are the ones a person's typing produces", () => {
  const { token, code, tokenHash, codeHash } = newInviteSecrets();
  assert.equal(hashInviteToken(token), tokenHash);
  assert.equal(hashInviteCode(token, cleanInviteCode(` ${code.slice(0, 3)} ${code.slice(3)} `)), codeHash);
});

test("neither secret is stored in the clear", () => {
  const { token, code, tokenHash, codeHash } = newInviteSecrets();
  assert.notEqual(tokenHash, token);
  assert.ok(!codeHash.includes(code));
});

test("the same code on two links hashes differently", () => {
  assert.notEqual(hashInviteCode("link-one", "123456"), hashInviteCode("link-two", "123456"));
});

test("a code survives the ways people type one", () => {
  assert.equal(cleanInviteCode("123 456"), "123456");
  assert.equal(cleanInviteCode("123-456"), "123456");
  assert.equal(cleanInviteCode("code: 123456789"), "123456");
  assert.equal(cleanInviteCode("no digits"), "");
});

test("a link ends after seven days", () => {
  const start = new Date("2026-11-06T10:00:00.000Z");
  assert.equal(INVITE_DAYS, 7);
  assert.equal(inviteExpiry(start), "2026-11-13T10:00:00.000Z");
});

test("the link lands on the public page, however the origin is written", () => {
  assert.equal(inviteUrl("https://app.example.test", "abc"), "https://app.example.test/join/abc");
  assert.equal(inviteUrl("https://app.example.test/", "abc"), "https://app.example.test/join/abc");
});
