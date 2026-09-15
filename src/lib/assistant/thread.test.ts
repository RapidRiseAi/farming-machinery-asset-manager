import assert from "node:assert/strict";
import test from "node:test";
import { parseDraft, threadHref, threadStatus, toThreadEntry, type ThreadRow } from "./thread";
import type { AssistantMachine } from "./types";

const NOW = new Date("2026-09-15T10:00:00.000Z");
const LATER = "2026-09-15T10:10:00.000Z";
const EARLIER = "2026-09-15T09:50:00.000Z";
const ROW_ID = "11111111-1111-4111-8111-111111111111";
const MACHINE_ID = "22222222-2222-4222-8222-222222222222";

const machine = {
  id: MACHINE_ID,
  name: "Groen John Deere",
  make: "John Deere",
  model: "6120M",
  aliases: [],
  status: "active",
  meterType: "hours",
  currentReading: 4820,
  currentReadingDate: "2026-07-29",
  serviceStatus: "ok",
  nextDueDate: null,
  nextDueReading: null,
} as AssistantMachine;

const faultDraft = {
  intent: "report_fault",
  machineQuery: "john deere",
  machineId: MACHINE_ID,
  description: "Hydraulic leak",
  category: null,
  urgency: "limping",
  reading: null,
  readingDate: null,
  serviceDate: null,
  workPerformed: null,
  confidence: 0.9,
};

function row(overrides: Partial<ThreadRow>): ThreadRow {
  return {
    id: ROW_ID,
    created_at: "2026-09-15T09:45:00.000Z",
    channel: "typed",
    locale: "en-ZA",
    input_text: "Report a hydraulic leak on the John Deere",
    response_text: null,
    confirmation_status: "not_required",
    result_status: "answered",
    error_code: null,
    proposal_expires_at: null,
    linked_record_type: null,
    linked_record_id: null,
    tool_args: faultDraft,
    ...overrides,
  };
}

test("each stored outcome maps to the status its subject should see", () => {
  const cases: Array<[Partial<ThreadRow>, string]> = [
    [{ result_status: "answered" }, "answered"],
    [{ result_status: "applied", confirmation_status: "confirmed" }, "applied"],
    [{ result_status: "rejected", confirmation_status: "rejected" }, "rejected"],
    [{ result_status: "proposed", confirmation_status: "pending", proposal_expires_at: LATER }, "pending"],
    [{ result_status: "failed", error_code: "superseded" }, "superseded"],
    [{ result_status: "failed", error_code: "proposal_expired" }, "expired"],
    [{ result_status: "failed", error_code: "turn_failed" }, "failed"],
    [{ result_status: "proposed", confirmation_status: "not_required" }, "unfinished"],
    [{ result_status: "proposed", confirmation_status: "processing" }, "unfinished"],
    [{ result_status: "something_new" }, "failed"],
  ];
  for (const [overrides, expected] of cases) {
    assert.equal(threadStatus(row(overrides), NOW), expected, JSON.stringify(overrides));
  }
});

test("a proposal that aged out without an attempt is expired, not pending", () => {
  // The RPC only marks a proposal failed when somebody tries to confirm it late,
  // so an untouched one is still proposed/pending in the table.
  const aged = row({ result_status: "proposed", confirmation_status: "pending", proposal_expires_at: EARLIER });
  assert.equal(threadStatus(aged, NOW), "expired");
});

test("a pending proposal with no readable expiry can never be confirmed", () => {
  for (const proposal_expires_at of [null, "not a date"]) {
    const r = row({ result_status: "proposed", confirmation_status: "pending", proposal_expires_at });
    assert.equal(threadStatus(r, NOW), "expired");
  }
});

test("parseDraft accepts a stored draft and refuses anything malformed", () => {
  const parsed = parseDraft(faultDraft);
  assert.ok(parsed);
  assert.equal(parsed.intent, "report_fault");
  assert.equal(parsed.machineId, MACHINE_ID);

  assert.equal(parseDraft(null), null);
  assert.equal(parseDraft("draft"), null);
  assert.equal(parseDraft([faultDraft]), null);
  assert.equal(parseDraft({ ...faultDraft, intent: "delete_everything" }), null);
  assert.equal(parseDraft({ ...faultDraft, reading: Number.POSITIVE_INFINITY }), null);
  assert.equal(parseDraft({ ...faultDraft, reading: "4000" }), null);
  assert.equal(parseDraft({ ...faultDraft, urgency: "on_fire" }), null);
});

test("a pending proposal is rebuilt with every fact, so it is never confirmed blind", () => {
  const entry = toThreadEntry(
    row({ result_status: "proposed", confirmation_status: "pending", proposal_expires_at: LATER }),
    [machine],
    NOW,
  );
  assert.equal(entry.status, "pending");
  assert.ok(entry.proposal);
  assert.equal(entry.proposal.proposalId, ROW_ID);
  const values = entry.proposal.facts.map((f) => f.value);
  assert.ok(values.includes("Groen John Deere"));
  assert.ok(values.includes("Hydraulic leak"));
});

test("a pending proposal on a machine the person can no longer see is not offered", () => {
  const entry = toThreadEntry(
    row({ result_status: "proposed", confirmation_status: "pending", proposal_expires_at: LATER }),
    [],
    NOW,
  );
  assert.equal(entry.status, "unfinished");
  assert.equal(entry.proposal, null);
});

test("stored failure diagnostics are never shown; answers and outcomes are", () => {
  const failed = toThreadEntry(
    row({ result_status: "failed", response_text: "The selected-farm role cannot perform this intent." }),
    [machine],
    NOW,
  );
  assert.equal(failed.response, null);

  const answered = toThreadEntry(row({ result_status: "answered", response_text: "Due in 180 hours." }), [machine], NOW);
  assert.equal(answered.response, "Due in 180 hours.");
});

test("links follow the confirm route's rules and refuse anything unsafe", () => {
  const draft = parseDraft(faultDraft);
  const jobId = "33333333-3333-4333-8333-333333333333";
  assert.equal(threadHref({ linked_record_type: "fault", linked_record_id: jobId }, draft), "/faults");
  assert.equal(threadHref({ linked_record_type: "job_card", linked_record_id: jobId }, draft), `/jobcards/${jobId}`);
  assert.equal(threadHref({ linked_record_type: "job_card", linked_record_id: "../admin" }, draft), null);
  assert.equal(threadHref({ linked_record_type: "meter_reading", linked_record_id: jobId }, draft), `/machines/${MACHINE_ID}`);
  const unsafe = parseDraft({ ...faultDraft, machineId: "../../admin" });
  assert.equal(threadHref({ linked_record_type: "meter_reading", linked_record_id: jobId }, unsafe), null);
  assert.equal(threadHref({ linked_record_type: "none", linked_record_id: null }, draft), null);
});

test("only an applied change carries a link", () => {
  const rejected = toThreadEntry(
    row({ result_status: "rejected", confirmation_status: "rejected", linked_record_type: "fault" }),
    [machine],
    NOW,
  );
  assert.equal(rejected.href, null);
  const applied = toThreadEntry(
    row({ result_status: "applied", confirmation_status: "confirmed", linked_record_type: "fault" }),
    [machine],
    NOW,
  );
  assert.equal(applied.href, "/faults");
});

test("an entry never carries the stored draft or model metadata to the browser", () => {
  const entry = toThreadEntry(row({ result_status: "answered", response_text: "ok" }), [machine], NOW);
  assert.deepEqual(Object.keys(entry).sort(), ["channel", "createdAt", "href", "id", "input", "proposal", "response", "status"]);
});

test("unknown channels read as typed rather than leaking a raw value", () => {
  assert.equal(toThreadEntry(row({ channel: "sms" }), [machine], NOW).channel, "typed");
  assert.equal(toThreadEntry(row({ channel: "voice" }), [machine], NOW).channel, "voice");
});
