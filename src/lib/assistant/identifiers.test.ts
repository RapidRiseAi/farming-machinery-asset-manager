import assert from "node:assert/strict";
import test from "node:test";
import { isPostgresUuid, isSafeAssistantMachineHref } from "./identifiers";

test("accepts RFC and deterministic PostgreSQL UUID values", () => {
  assert.equal(isPostgresUuid("11111111-1111-4111-8111-111111111111"), true);
  assert.equal(isPostgresUuid("20000000-0000-0000-0000-000000000001"), true);
});

test("accepts a deterministic machine record href", () => {
  assert.equal(
    isSafeAssistantMachineHref("/machines/20000000-0000-0000-0000-000000000001"),
    true,
  );
});

test("rejects malformed or extended machine record hrefs", () => {
  assert.equal(isSafeAssistantMachineHref("/machines/not-a-machine-id"), false);
  assert.equal(
    isSafeAssistantMachineHref("/machines/20000000-0000-0000-0000-000000000001/extra"),
    false,
  );
  assert.equal(
    isSafeAssistantMachineHref("/machines/20000000-0000-0000-0000-000000000001?next=https://example.com"),
    false,
  );
});
