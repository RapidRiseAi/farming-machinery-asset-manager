import assert from "node:assert/strict";
import test from "node:test";
import {
  answerLocalRead,
  formatFaults,
  formatJobCards,
  formatServiceAttention,
  formatWorkRequests,
  parseLocalReadRequest,
  scopeForChosenMachine,
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

test("a machine chosen in a clarification is answered, not asked about again", async () => {
  const machine = (id: string, name: string, model: string): AssistantMachine => ({
    id,
    name,
    make: "John Deere",
    model,
    aliases: [],
    status: "active",
    meterType: "hours",
    currentReading: 4820,
    currentReadingDate: "2026-07-29",
    serviceStatus: "due_soon",
    nextDueDate: null,
    nextDueReading: 5000,
  });
  const groen = machine("11111111-1111-4111-8111-111111111111", "Groen John Deere", "6120M");
  const stroper = machine("22222222-2222-4222-8222-222222222222", "John Deere Stroper", "S660");
  const planter = machine("33333333-3333-4333-8333-333333333333", "Planter 8-ry", "1755");
  const neverQuery = new Proxy({}, {
    get() {
      throw new Error("service attention must not query the database");
    },
  });
  const scope = { supabase: neverQuery, farmId: "farm", role: "owner" as const, machines: [groen, stroper, planter] } as never;
  const request = { kind: "service_attention", machineQuery: "Groen John Deere" } as const;

  // The premise of the bug: the chosen machine's own name is still ambiguous
  // across the fleet, because the other two machines share its make.
  const whole = await answerLocalRead(request, scope, "en-ZA");
  assert.ok((whole.machineOptions?.length ?? 0) >= 2, "the name alone is ambiguous across the fleet");

  const chosen = scopeForChosenMachine(scope, groen.id);
  assert.ok(chosen);
  const answered = await answerLocalRead(request, chosen, "en-ZA");
  assert.equal(answered.machineOptions, undefined);
  assert.doesNotMatch(answered.message, /Which machine/i);
  assert.match(answered.message, /Groen John Deere/);
  assert.equal(answered.machineId, groen.id);
});

test("a chosen machine outside the visible fleet yields no scope", () => {
  const scope = { supabase: {}, farmId: "farm", role: "operator" as const, machines: [] } as never;
  assert.equal(scopeForChosenMachine(scope, "11111111-1111-4111-8111-111111111111"), null);
});

test("a service question about one machine is answered about that machine, not the fleet", async () => {
  const mk = (id: string, name: string, serviceStatus: "ok" | "due_soon"): AssistantMachine => ({
    id,
    name,
    make: name.split(" ")[0],
    model: "X",
    aliases: [],
    status: "active",
    meterType: "hours",
    currentReading: 4820,
    currentReadingDate: "2026-07-29",
    serviceStatus,
    nextDueDate: "2027-06-04",
    nextDueReading: 5000,
  });
  const groen = mk("11111111-1111-4111-8111-111111111111", "Groen John Deere", "ok");
  const massey = mk("22222222-2222-4222-8222-222222222222", "Rooi Massey", "due_soon");
  const neverQuery = new Proxy({}, {
    get() {
      throw new Error("service attention must not query the database");
    },
  });
  const scope = { supabase: neverQuery, farmId: "farm", role: "owner" as const, machines: [groen, massey] } as never;

  const one = await answerLocalRead(
    { kind: "service_attention", machineQuery: "When is the Groen John Deere due for service?" },
    scope,
    "en-ZA",
  );
  assert.match(one.message, /Groen John Deere's service is up to date/);
  assert.doesNotMatch(one.message, /No visible machines/);
  assert.equal(one.machineId, groen.id);

  // The fleet question keeps the fleet answer.
  const fleet = await answerLocalRead(
    { kind: "service_attention", machineQuery: "Which machines need service?" },
    scope,
    "en-ZA",
  );
  assert.match(fleet.message, /Rooi Massey: due soon/);
  assert.equal(fleet.machineId, undefined);
});

/**
 * Two copies of the "service timing" vocabulary had drifted in OPPOSITE
 * directions: the local reader knew verskuldig but not volgende, the parser knew
 * soon but not binnekort. "When is the X due for service?" was answered by the
 * local reader while "Wanneer is die X se volgende diens?" fell through to the
 * deterministic intent, and nothing failed while the two grew further apart.
 * Both now share SERVICE_DUE_CUE.
 *
 * Routes are compared AND so are outcomes: a shared route that answers about a
 * machine in one language and offers a picker in the other is still a split.
 */
const SERVICE_QUESTION_PAIRS: Array<[string, string]> = [
  ["When is the Groen John Deere due for service?", "Wanneer is die Groen John Deere se volgende diens?"],
  ["What is the next service for the Groen John Deere?", "Wat is die volgende diens vir die Groen John Deere?"],
  ["Which machines need service?", "Watter masjiene se dienste is agterstallig?"],
  ["Which machines are due soon for service?", "Watter masjiene is binnekort verskuldig vir diens?"],
  ["Is the Groen John Deere due for service?", "Is die Groen John Deere verskuldig vir diens?"],
  ["When is the next service?", "Wanneer is die volgende diens?"],
];

function serviceMachine(
  id: string,
  name: string,
  make: string,
  model: string,
  serviceStatus: "ok" | "due_soon",
): AssistantMachine {
  return {
    id,
    name,
    make,
    model,
    aliases: [],
    status: "active",
    meterType: "hours",
    currentReading: 4820,
    currentReadingDate: "2026-07-29",
    serviceStatus,
    nextDueDate: "2027-06-04",
    nextDueReading: 5000,
  };
}

const GROEN = serviceMachine("11111111-1111-4111-8111-111111111111", "Groen John Deere", "John Deere", "6120M", "ok");
const MASSEY = serviceMachine("22222222-2222-4222-8222-222222222222", "Rooi Massey", "Massey Ferguson", "MF-4708", "due_soon");

function serviceScope() {
  const neverQuery = new Proxy({}, {
    get() {
      throw new Error("service attention must not query the database");
    },
  });
  return { supabase: neverQuery, farmId: "farm", role: "owner" as const, machines: [GROEN, MASSEY] } as never;
}

/** What a question actually produced, in a form comparable across languages. */
async function serviceOutcome(phrase: string, locale: "en-ZA" | "af-ZA"): Promise<string> {
  const plan = planAssistantRoute(phrase, locale);
  if (plan.kind !== "local") return "route:" + plan.kind;
  const answer = await answerLocalRead(plan.request, serviceScope(), locale);
  if (answer.machineOptions) return "picker:" + answer.machineOptions.map((o) => o.name).sort().join(",");
  if (answer.machineId) return "machine:" + answer.machineId;
  return "fleet";
}

test("the same service question routes the same way in English and Afrikaans", () => {
  for (const [english, afrikaans] of SERVICE_QUESTION_PAIRS) {
    const label = english + "  /  " + afrikaans;
    assert.equal(planAssistantRoute(english, "en-ZA").kind, planAssistantRoute(afrikaans, "af-ZA").kind, label);
    assert.equal(parseLocalReadRequest(english)?.kind, parseLocalReadRequest(afrikaans)?.kind, label);
  }
});

test("the same service question reaches the same answer in English and Afrikaans", async () => {
  for (const [english, afrikaans] of SERVICE_QUESTION_PAIRS) {
    assert.equal(
      await serviceOutcome(english, "en-ZA"),
      await serviceOutcome(afrikaans, "af-ZA"),
      english + "  /  " + afrikaans,
    );
  }
});

test("a service question is answered about the machine it names, in both languages", async () => {
  const english = await answerLocalRead(
    { kind: "service_attention", machineQuery: "What is the next service for the Groen John Deere?" },
    serviceScope(),
    "en-ZA",
  );
  assert.ok(english.message.includes("Groen John Deere's service is up to date"), english.message);
  assert.equal(english.machineId, GROEN.id);

  const afrikaans = await answerLocalRead(
    { kind: "service_attention", machineQuery: "Wat is die volgende diens vir die Groen John Deere?" },
    serviceScope(),
    "af-ZA",
  );
  assert.ok(afrikaans.message.includes("Groen John Deere se diens is op datum"), afrikaans.message);
  assert.equal(afrikaans.machineId, GROEN.id);

  // Naming no machine, the fleet answer is the right one, never a dead end.
  const fleet = await answerLocalRead(
    { kind: "service_attention", machineQuery: "When is the next service?" },
    serviceScope(),
    "en-ZA",
  );
  assert.ok(fleet.message.includes("Rooi Massey"), fleet.message);
  assert.equal(fleet.machineId, undefined);
});
