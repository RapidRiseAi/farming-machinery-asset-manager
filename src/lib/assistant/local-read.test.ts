import assert from "node:assert/strict";
import test from "node:test";
import {
  answerLocalRead,
  formatFaults,
  formatJobCards,
  formatServiceAttention,
  formatWorkRequests,
  parseLocalReadRequest,
} from "./local-read";
import { planAssistantRoute } from "./routing";
import { canReadFinancialDocuments } from "./read-data";
import type { AssistantMachine } from "./types";

test("routes common English, Afrikaans and mixed fleet reads locally", () => {
  assert.equal(parseLocalReadRequest("Show the open faults")?.kind, "faults");
  assert.equal(parseLocalReadRequest("Wys die oop werkkaarte")?.kind, "job_cards");
  assert.equal(parseLocalReadRequest("Wys open faults on die John Deere")?.kind, "faults");
  assert.equal(parseLocalReadRequest("Wat problems is oop op die Djon Deer?")?.kind, "faults");
  assert.equal(parseLocalReadRequest("Which machines need service?")?.kind, "service_attention");
  assert.equal(parseLocalReadRequest("Watter masjiene se dienste is agterstallig?")?.kind, "service_attention");
  assert.equal(parseLocalReadRequest("Show my quote requests")?.kind, "work_requests");
  assert.equal(parseLocalReadRequest("Wys onbetaalde fakture")?.kind, "financial_documents");
});

test("keeps supported writes deterministic and handles unsupported writes locally", () => {
  assert.equal(parseLocalReadRequest("I want to report a problem"), null);
  assert.equal(parseLocalReadRequest("Meld 'n fout op die Mercedes aan"), null);
  assert.equal(parseLocalReadRequest("Rapporteer 'n gebreekte venster op die Mercedes trok"), null);
  assert.equal(planAssistantRoute("Raporteer a gebreekde venster op die Mercedes trok", "af-ZA").kind, "deterministic");
  assert.deepEqual(parseLocalReadRequest("Close this job card"), { kind: "action_boundary", navigation: "jobcards" });
  assert.deepEqual(parseLocalReadRequest("Pay invoice INV-12"), { kind: "action_boundary", navigation: "documents" });
  assert.deepEqual(parseLocalReadRequest("Resolve the broken fault"), { kind: "action_boundary", navigation: "faults" });
  assert.deepEqual(parseLocalReadRequest("Delete reading 4323"), { kind: "action_boundary", navigation: "none" });
  assert.deepEqual(parseLocalReadRequest("Delete completed service"), { kind: "action_boundary", navigation: "none" });
  assert.equal(planAssistantRoute("Close this job card", "en-ZA").kind, "local");
  assert.equal(planAssistantRoute("Pay invoice INV-12", "en-ZA").kind, "local");
  assert.equal(planAssistantRoute("Resolve the broken fault", "en-ZA").kind, "local");
  assert.equal(planAssistantRoute("Delete reading 4323", "en-ZA").kind, "local");
  assert.equal(planAssistantRoute("Delete completed service", "en-ZA").kind, "local");
});

test("never turns explicit history questions into new write proposals", () => {
  assert.equal(planAssistantRoute("What fault did we report?", "en-ZA").kind, "local");
  assert.equal(planAssistantRoute("Watter fout het ons gerapporteer?", "af-ZA").kind, "local");
  assert.notEqual(planAssistantRoute("List the readings we log", "en-ZA").kind, "deterministic");
  const whoLogged = planAssistantRoute("Who logged 4323 hours on the John Deere", "en-ZA");
  assert.notEqual(whoLogged.draft.intent, "log_reading");
  assert.equal(planAssistantRoute("Has the service completed on the Mercedes", "en-ZA").kind, "local");
  assert.equal(planAssistantRoute("Was the service completed on the Mercedes", "en-ZA").kind, "local");
  assert.equal(planAssistantRoute("Is die diens voltooi op die Mercedes", "af-ZA").kind, "local");
  assert.equal(planAssistantRoute("Do we have a fault on the John Deere", "en-ZA").kind, "local");
});

test("routes lifecycle actions and completion statements to a safe boundary", () => {
  assert.equal(planAssistantRoute("Cancel the fault report", "en-ZA").kind, "local");
  assert.equal(planAssistantRoute("Archive the fault report", "en-ZA").kind, "local");
  assert.equal(planAssistantRoute("Ek het die fout opgelos", "af-ZA").kind, "local");
  assert.equal(parseLocalReadRequest("Ek het die fout opgelos")?.kind, "action_boundary");
});

test("handles quote creation locally as a safe workflow boundary", () => {
  assert.equal(parseLocalReadRequest("Create a quote for the Mercedes")?.kind, "quote_boundary");
  assert.equal(parseLocalReadRequest("Skep 'n kwotasie vir die Mercedes")?.kind, "quote_boundary");
  assert.equal(parseLocalReadRequest("What is the status of my quote request?")?.kind, "work_requests");
  assert.equal(parseLocalReadRequest("Send me the quote")?.kind, "financial_documents");
});

test("preserves requested history and status filters", () => {
  assert.deepEqual(parseLocalReadRequest("Show resolved faults"), {
    kind: "faults",
    machineQuery: "Show resolved faults",
    view: "resolved",
  });
  assert.equal(parseLocalReadRequest("Show completed job cards")?.kind, "job_cards");
  assert.equal(parseLocalReadRequest("What service was completed on the Mercedes?")?.kind, "job_cards");
  assert.equal(parseLocalReadRequest("Show completed work requests")?.kind, "work_requests");
  assert.equal(parseLocalReadRequest("Wys gekanselleerde fakture")?.kind, "financial_documents");
  const cancelled = parseLocalReadRequest("Wys gekanselleerde fakture");
  assert.equal(cancelled?.kind === "financial_documents" ? cancelled.status : null, "cancelled");
  const paid = parseLocalReadRequest("Wys fakture wat betaal is");
  assert.equal(paid?.kind === "financial_documents" ? paid.status : null, "paid");
  const accepted = parseLocalReadRequest("Wys kwotasies wat aanvaar is");
  assert.equal(accepted?.kind === "financial_documents" ? accepted.status : null, "accepted");
});

test("routes more ordinary read wording locally", () => {
  assert.equal(parseLocalReadRequest("I want to see my machines")?.kind, "fleet_overview");
  assert.equal(parseLocalReadRequest("Ek wil my masjiene sien")?.kind, "fleet_overview");
  assert.equal(parseLocalReadRequest("my work requests")?.kind, "work_requests");
  assert.equal(parseLocalReadRequest("quotes")?.kind, "financial_documents");
});

test("explicitly selects the no-provider route for local questions", () => {
  assert.equal(planAssistantRoute("Show open faults", "en-ZA").kind, "local");
  assert.equal(planAssistantRoute("Wys my kwotasieversoeke", "af-ZA").kind, "local");
  assert.equal(planAssistantRoute("Report a broken window on the Mercedes", "en-ZA").kind, "deterministic");
  assert.equal(planAssistantRoute("Show the current reading on the Actros 2645", "en-ZA").kind, "deterministic");
  assert.equal(planAssistantRoute("What service was completed on the Mercedes?", "en-ZA").kind, "local");
  const currentReading = planAssistantRoute("Current reading for the John Deere", "en-ZA");
  assert.equal(currentReading.kind, "deterministic");
  assert.equal(currentReading.draft.intent, "query_asset_status");
  assert.equal(planAssistantRoute("Tell me a joke", "en-ZA").kind, "optional_ai");
});

test("formats bounded bilingual local answers without IDs", () => {
  const faults = Array.from({ length: 6 }, (_, index) => ({
    machine: `Machine ${index + 1}`,
    description: "Broken window",
    category: null,
    urgency: "can_work",
    status: "open",
    reportedAt: "2026-08-29",
  }));
  const english = formatFaults(faults, "en-ZA");
  const afrikaans = formatFaults(faults, "af-ZA");
  assert.match(english, /At least 6 open faults/);
  assert.match(english, /More results are available/);
  assert.doesNotMatch(english, /Machine 6/);
  assert.match(afrikaans, /6 oop foute/);
});

test("omits operational amounts when read rows have been role-redacted", () => {
  const job = formatJobCards([{
    machine: "Mercedes trok",
    type: "repair",
    status: "open",
    dateIn: null,
    dateOut: null,
    problem: "Venster gebreek",
    diagnosis: null,
    workPerformed: null,
    totalCents: null,
  }], "en-ZA");
  const work = formatWorkRequests([{
    machine: "Mercedes trok",
    kind: "quote",
    status: "requested",
    priority: "normal",
    title: "Window quote",
    description: null,
    quoteAmountCents: null,
    invoiceAmountCents: null,
    updatedAt: null,
  }], "en-ZA");
  assert.doesNotMatch(job, /R\s?\d/);
  assert.doesNotMatch(work, /R\s?\d/);
});

test("labels completed service history correctly and includes its useful details", () => {
  assert.match(formatJobCards([], "en-ZA", "completed"), /no matching completed job cards/i);
  const history = formatJobCards([{
    machine: "Mercedes-Benz Actros 2645",
    type: "scheduled_service",
    status: "completed",
    dateIn: "2026-08-20",
    dateOut: "2026-08-21",
    problem: "Scheduled service",
    diagnosis: null,
    workPerformed: "Oil and filters replaced",
    totalCents: null,
  }], "en-ZA", "completed");
  assert.match(history, /2026-08-21/);
  assert.match(history, /Oil and filters replaced/);
});

test("keeps financial documents unavailable to operators", () => {
  assert.equal(canReadFinancialDocuments("operator"), false);
  assert.equal(canReadFinancialDocuments("owner"), true);
  assert.equal(canReadFinancialDocuments("manager"), true);
  assert.equal(canReadFinancialDocuments("mechanic"), true);
});

test("formats service attention directly from already visible machines", () => {
  const machine: AssistantMachine = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "John Deere 6155R",
    make: "John Deere",
    model: "6155R",
    aliases: [],
    status: "active",
    meterType: "hours",
    currentReading: 4400,
    currentReadingDate: "2026-08-29",
    serviceStatus: "due_soon",
    nextDueDate: null,
    nextDueReading: 4500,
  };
  assert.match(formatServiceAttention([machine], "en-ZA"), /John Deere 6155R: due soon \(4500 hours\)/);
  assert.match(formatServiceAttention([machine], "af-ZA"), /John Deere 6155R: binnekort verskuldig \(4500 ure\)/);
});

test("unknown machine filters fail closed and ambiguity produces a real machine choice", async () => {
  const base: AssistantMachine = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "John Deere 6155R",
    make: "John Deere",
    model: "6155R",
    aliases: ["Big tractor"],
    status: "active",
    meterType: "hours",
    currentReading: 4400,
    currentReadingDate: "2026-08-29",
    serviceStatus: "due_soon",
    nextDueDate: null,
    nextDueReading: 4500,
  };
  const second: AssistantMachine = {
    ...base,
    id: "22222222-2222-4222-8222-222222222222",
    name: "John Deere 6120M",
    model: "6120M",
  };
  const neverQuery = new Proxy({}, {
    get() {
      throw new Error("database query should not run for an unresolved machine");
    },
  });
  const scope = {
    supabase: neverQuery,
    farmId: "farm",
    role: "owner" as const,
    machines: [base, second],
  };
  const missing = await answerLocalRead(
    { kind: "faults", machineQuery: "Show faults for Unlisted ZXQ9", view: "open" },
    scope as never,
    "en-ZA",
  );
  assert.match(missing.message, /could not find that machine/i);

  const leadingMissing = await answerLocalRead(
    { kind: "faults", machineQuery: "Show Unlisted ZXQ9 faults", view: "open" },
    scope as never,
    "en-ZA",
  );
  assert.match(leadingMissing.message, /could not find that machine/i);

  const afrikaansMissing = await answerLocalRead(
    { kind: "faults", machineQuery: "Wys Unlisted ZXQ9 se foute", view: "open" },
    scope as never,
    "af-ZA",
  );
  assert.match(afrikaansMissing.message, /kon nie daardie masjien/i);

  const ambiguous = await answerLocalRead(
    { kind: "faults", machineQuery: "Show faults for Big tractor", view: "open" },
    scope as never,
    "en-ZA",
  );
  assert.equal(ambiguous.machineOptions?.length, 2);
  assert.match(ambiguous.message, /Which machine/i);
});
