import assert from "node:assert/strict";
import { test } from "node:test";
import { canConvertWorkRequest, canRecordWorkAmount, workTransitions, type WorkActor } from "./work-lifecycle";

test("the supplier cannot approve their own work or quote", () => {
  for (const status of ["requested", "viewed", "quoted", "completed", "invoiced"]) {
    assert.equal(workTransitions(status, "workshop", true).includes("accepted"), false);
    assert.equal(workTransitions(status, "workshop", true).includes("closed"), false);
  }
});

test("farm approval supports a quote and work authorized without a quote", () => {
  for (const actor of ["owner", "manager"] as const) {
    for (const status of ["requested", "viewed", "quoted"]) {
      assert.deepEqual(workTransitions(status, actor, true), ["accepted"]);
    }
    assert.deepEqual(workTransitions("in_progress", actor, true), []);
    assert.deepEqual(workTransitions("completed", actor, true), []);
    assert.deepEqual(workTransitions("invoiced", actor, true), ["closed"]);
  }
});

test("only the supplier records amounts and the invoice follows completion", () => {
  for (const actor of ["owner", "manager", "mechanic", "operator", "rr_admin", null] as WorkActor[]) {
    assert.equal(canRecordWorkAmount("quote", "requested", actor, true), false);
    assert.equal(canRecordWorkAmount("invoice", "completed", actor, true), false);
  }
  assert.equal(canRecordWorkAmount("quote", "requested", "workshop", true), true);
  assert.equal(canRecordWorkAmount("quote", "accepted", "workshop", true), false);
  assert.equal(canRecordWorkAmount("invoice", "in_progress", "workshop", true), false);
  assert.equal(canRecordWorkAmount("invoice", "completed", "workshop", true), true);
  assert.equal(canRecordWorkAmount("invoice", "closed", "workshop", true), false);
});

test("unassigned requests cannot be approved, invoiced or converted", () => {
  for (const actor of ["owner", "manager", "workshop"] as const) {
    assert.deepEqual(workTransitions("requested", actor, false), []);
    assert.equal(canRecordWorkAmount("invoice", "completed", actor, false), false);
    assert.equal(canConvertWorkRequest("accepted", actor, false), false);
  }
  assert.equal(canConvertWorkRequest("requested", "owner", true), false);
  assert.equal(canConvertWorkRequest("accepted", "mechanic", true), false);
  assert.equal(canConvertWorkRequest("accepted", "workshop", true), true);
  for (const status of ["completed", "invoiced", "closed"]) {
    assert.equal(canConvertWorkRequest(status, "owner", true), false);
  }
});
