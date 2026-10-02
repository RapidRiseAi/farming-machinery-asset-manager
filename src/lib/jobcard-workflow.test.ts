import test from "node:test";
import assert from "node:assert/strict";
import { canEditJobWork, canReviewJob, canReturnJob, canChangeJobStatus, jobCardPatch, needsJobMeter, parseJobLine } from "./jobcard-workflow";

const internal = { work_mode: "internal", workshop_id: null, status: "open", locked: false };
const external = { ...internal, work_mode: "external", workshop_id: "provider-a" };
const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
};

test("internal crew, assigned contractor, and receiving farm have different powers", () => {
  assert.equal(canEditJobWork(internal, "mechanic", null), true);
  assert.equal(canEditJobWork(internal, "workshop", "provider-a"), false);
  assert.equal(canEditJobWork(external, "owner", null), false);
  assert.equal(canEditJobWork(external, "workshop", "provider-a"), true);
  assert.equal(canEditJobWork(external, "workshop", "provider-b"), false);
  assert.equal(canReviewJob("workshop"), false);
  assert.equal(canReviewJob("owner"), true);
  assert.equal(canEditJobWork({ ...external, workshop_id: null }, "owner", null), true);
  assert.equal(canEditJobWork({ ...external, workshop_id: null }, "mechanic", null), false);
});

test("completed and approved work is read-only until explicitly returned", () => {
  for (const status of ["completed", "approved"]) {
    for (const role of ["owner", "mechanic", "rr_admin"]) assert.equal(canEditJobWork({ ...internal, status }, role, null), false);
  }
  assert.equal(canChangeJobStatus("open", "completed"), false);
  assert.equal(canChangeJobStatus("completed", "in_progress"), false);
  assert.equal(canChangeJobStatus("in_progress", "waiting_parts"), true);
  assert.equal(canChangeJobStatus("waiting_parts", "in_progress"), true);
});

test("saving one section preserves other sections and cannot approve or complete a job", () => {
  assert.deepEqual(jobCardPatch(form({ diagnosis: " Filter blocked ", status: "approved" })), { diagnosis: "Filter blocked" });
  assert.deepEqual(jobCardPatch(form({ recommendations: "" })), { recommendations: null });
  assert.throws(() => jobCardPatch(form({ meter_reading: "-1" })), /job-invalid-meter/);
  assert.throws(() => jobCardPatch(form({ date_in: "2026-02-30" })), /job-invalid-date/);
  assert.throws(() => jobCardPatch(form({ date_in: "" })), /job-invalid-date/);
});

test("meter requirement depends on work type and whether the asset has a meter", () => {
  assert.equal(needsJobMeter("scheduled_service", "hours"), true);
  assert.equal(needsJobMeter("scheduled_service", "none"), false);
  assert.equal(needsJobMeter("repair", "hours"), false);
});

test("line entries reject empty work, invalid quantities and prices before any write", () => {
  assert.throws(() => parseJobLine(form({ kind: "part", qty: "1" })), /job-line-description/);
  assert.throws(() => parseJobLine(form({ kind: "part", description: "Filter", qty: "" })), /job-line-quantity/);
  assert.throws(() => parseJobLine(form({ kind: "part", description: "Filter", qty: "0.001" })), /job-line-quantity/);
  assert.throws(() => parseJobLine(form({ kind: "labour", description: "Fit filter", hours: "-1" })), /job-line-quantity/);
  assert.throws(() => parseJobLine(form({ kind: "other", description: "Callout", unit_cost: "-5" })), /job-line-price/);
  const part = parseJobLine(form({ kind: "part", part_no: "F123", qty: "2", unit_cost: "125.50" }));
  assert.equal(part.qty, 2);
  assert.equal(part.unit_cost_cents, 12550);
  const unpriced = parseJobLine(form({ kind: "labour", description: "Internal mechanic", hours: "1.5" }));
  assert.equal(unpriced.rate_cents, null);
});

test("review actions exclude billed jobs and remain available to platform support", () => {
  const done = { status: "completed", locked: false, completion_effects_recorded: true };
  assert.equal(canReturnJob(done, "completed", false), true);
  assert.equal(canReturnJob(done, "invoiced", false), false);
  assert.equal(canReturnJob(done, null, true), false);
  assert.equal(canReturnJob({ ...done, locked: true }, null, false), false);
  assert.equal(canReturnJob({ ...done, completion_effects_recorded: false }, null, false), false);
  assert.equal(canReviewJob("rr_admin"), true);
});
