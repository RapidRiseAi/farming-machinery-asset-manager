import assert from "node:assert/strict";
import test from "node:test";
import { draftFromProposal, farmAgentSystemPrompt, farmAgentTools, plainAnswer } from "./agent";
import { fleetSnapshot, monthsIn, monthStart, normalisePeriod, rand, type FarmDataScope } from "./farm-data";
import { planAssistantRoute, routeWantsAgent } from "./routing";
import { detectFarmTopics, questionNeedsAgent, questionPeriod } from "./topics";
import type { AssistantMachine } from "./types";

const tractor: AssistantMachine = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Red tractor",
  type: "tractor",
  make: "John Deere",
  model: "6155R",
  aliases: [],
  status: "active",
  meterType: "hours",
  currentReading: 3450,
  currentReadingDate: "2026-10-01",
  serviceStatus: "overdue",
  nextDueDate: null,
  nextDueReading: 3400,
};

const TODAY = "2026-10-08";

test("questions the local reads cannot answer go to the agent", () => {
  for (const question of [
    "How much diesel did we use last month?",
    "What are the fuel costs per vehicle?",
    "Which tractor uses the most fuel?",
    "How much did we pay for repairs this year?",
    "Wat het die rooi trekker se diesel gekos?",
    "Hoeveel liter brandstof het ons in September gebruik?",
    "What did we spend on the bakkie?",
    "and the other one?",
    "Why is the red tractor in the workshop?",
    "Show me the monthly fuel costs",
  ]) {
    assert.equal(questionNeedsAgent(question), true, question);
  }
});

test("questions the local reads answer well stay local and free", () => {
  for (const question of [
    "Show open faults",
    "Wys oop foute",
    "Which machines need a service?",
    "What can you do?",
    "Show active job cards",
    "Open the faults page",
  ]) {
    assert.equal(questionNeedsAgent(question), false, question);
  }
});

test("routing: help, navigation and plain lists never cost an AI call", () => {
  for (const question of ["What can you do?", "Open faults", "Show open faults", "Which machines need a service?"]) {
    assert.equal(routeWantsAgent(planAssistantRoute(question, "en-ZA"), question), false, question);
  }
});

test("routing: a money word that used to read as an action now reaches the agent", () => {
  // "pay" made this an "action not available" answer before the agent existed.
  const question = "How much did we pay for diesel last month?";
  const plan = planAssistantRoute(question, "en-ZA");
  assert.equal(routeWantsAgent(plan, question), true);
});

test("routing: writes the parser understood keep their confirmation path", () => {
  const question = "Log 3450 hours on the red tractor this month";
  const plan = planAssistantRoute(question, "en-ZA");
  if (plan.kind === "deterministic") assert.equal(routeWantsAgent(plan, question), false);
});

test("routing: anything nothing local understood goes to the agent", () => {
  const question = "Is it worth fixing the old Massey or should we sell it?";
  assert.equal(routeWantsAgent(planAssistantRoute(question, "en-ZA"), question), true);
});

test("topics: fuel and money are recognised in both languages, and rand amounts count", () => {
  assert.deepEqual(detectFarmTopics("How much diesel is in the tank?"), ["fuel"]);
  assert.ok(detectFarmTopics("Wat het die herstelwerk gekos?").includes("costs"));
  assert.ok(detectFarmTopics("Was it more than R2500?").includes("costs"));
  assert.ok(detectFarmTopics("Which machines are overdue for a service?").includes("service"));
});

test("a proposal becomes exactly the draft the database accepts", () => {
  const draft = draftFromProposal("propose_fault_report", { machine: "red tractor", problem: "Oil leak at the pump", urgency: "limping" }, TODAY);
  assert.ok(draft);
  // apply_assistant_proposal accepts exactly these eleven keys and no others.
  assert.deepEqual(Object.keys(draft).sort(), [
    "category", "confidence", "description", "intent", "machineId", "machineQuery",
    "reading", "readingDate", "serviceDate", "urgency", "workPerformed",
  ]);
  assert.equal(draft.intent, "report_fault");
  assert.equal(draft.machineId, null);
  assert.equal(draft.description, "Oil leak at the pump");
  assert.equal(draft.urgency, "limping");
});

test("a proposal never carries a future or malformed date, or a negative reading", () => {
  const future = draftFromProposal("propose_meter_reading", { machine: "red tractor", reading: 3500, date: "2026-12-01" }, TODAY);
  assert.equal(future?.readingDate, null);
  const malformed = draftFromProposal("propose_completed_service", { machine: "red tractor", reading: 3500, date: "yesterday" }, TODAY);
  assert.equal(malformed?.serviceDate, null);
  const negative = draftFromProposal("propose_meter_reading", { machine: "red tractor", reading: -5, date: null }, TODAY);
  assert.equal(negative?.reading, null);
  assert.equal(draftFromProposal("propose_meter_reading", { machine: "x", reading: 10, date: "2026-10-07" }, TODAY)?.readingDate, "2026-10-07");
  assert.equal(draftFromProposal("delete_everything", { machine: "x" }, TODAY), null);
  assert.equal(draftFromProposal("propose_fault_report", { machine: "x", problem: "y", urgency: "whenever" }, TODAY)?.urgency, null);
});

test("answers are plain text: no markdown reaches the screen or the voice", () => {
  assert.equal(plainAnswer("**Red tractor** used `120` litres.\n\n\n\n## Totals\n* one\n* two"), "Red tractor used 120 litres.\n\nTotals\n- one\n- two");
});

test("tools: an operator gets reads and a fault report, not readings or services", () => {
  const scope = { supabase: {} as FarmDataScope["supabase"], farmId: "f", role: "operator", machines: [tractor], costsVisible: false } as FarmDataScope;
  const names = Object.keys(farmAgentTools(scope, TODAY)).sort();
  assert.ok(names.includes("fuel_summary") && names.includes("propose_fault_report"));
  assert.ok(!names.includes("propose_meter_reading") && !names.includes("propose_completed_service"));
  assert.ok(!names.includes("list_quotes_and_invoices"));
  const owner = Object.keys(farmAgentTools({ ...scope, role: "owner", costsVisible: true }, TODAY));
  assert.ok(owner.includes("propose_meter_reading") && owner.includes("list_quotes_and_invoices"));
});

test("the prompt tells a role without money not to give amounts, and keeps voice short", () => {
  const base = { farmName: "Weltevrede", role: "operator", today: TODAY, locale: "en-ZA" as const, snapshot: fleetSnapshot([tractor]), digest: null };
  const noMoney = farmAgentSystemPrompt({ ...base, channel: "voice", costsVisible: false });
  assert.match(noMoney, /may not see money/);
  assert.match(noMoney, /spoken aloud/);
  assert.match(noMoney, /Red tractor \(tractor, John Deere 6155R\): active; 3450 h on 2026-10-01; service overdue \(next 3400 h\)/);
  const owner = farmAgentSystemPrompt({ ...base, role: "owner", channel: "typed", costsVisible: true });
  assert.match(owner, /rand, ex VAT/);
  assert.doesNotMatch(owner, /spoken aloud/);
  assert.match(farmAgentSystemPrompt({ ...base, locale: "af-ZA", channel: "typed", costsVisible: true }), /natural Afrikaans/);
});

test("periods: sensible defaults, turned round, never in the future, never past three years", () => {
  assert.deepEqual(normalisePeriod(null, null, TODAY, 6), { from: "2026-05-01", to: TODAY });
  assert.deepEqual(normalisePeriod("2026-09-30", "2026-09-01", TODAY), { from: "2026-09-01", to: "2026-09-30" });
  assert.equal(normalisePeriod("2026-09-01", "2027-01-01", TODAY).to, TODAY);
  const long = normalisePeriod("2015-01-01", TODAY, TODAY);
  assert.ok(long.from > "2023-10-01" && long.to === TODAY);
  assert.equal(monthStart("2026-01-15", 1), "2025-12-01");
  assert.equal(rand(123456), 1234.56);
  assert.equal(rand(null), null);
});

test("the period a question names is worked out before the model sees it", () => {
  const p = (q: string) => questionPeriod(q, TODAY);
  assert.deepEqual(p("fuel cost per vehicle this month"), { from: "2026-10-01", to: TODAY, label: "this month" });
  assert.deepEqual(p("How much diesel did we use last month?"), { from: "2026-09-01", to: "2026-09-30", label: "last month" });
  assert.deepEqual(p("Hoeveel diesel het die bakkie in Augustus gebruik?"), { from: "2026-08-01", to: "2026-08-31", label: "2026-08" });
  assert.equal(p("What did we spend in November?")?.from, "2025-11-01");
  assert.equal(p("costs vanjaar")?.from, "2026-01-01");
  assert.deepEqual(p("last year"), { from: "2025-01-01", to: "2025-12-31", label: "last year" });
  assert.equal(p("the last 3 months")?.from, "2026-08-01");
  assert.deepEqual(p("last week"), { from: "2026-09-28", to: "2026-10-04", label: "last week" });
  assert.equal(p("since August")?.to, TODAY);
  assert.equal(p("You may use the tractor"), null);
  assert.equal(p("Which tractor uses the most fuel?"), null);
  assert.deepEqual(p("Last month in January", )?.label, "last month");
  assert.equal(questionPeriod("last month", "2026-01-15")?.from, "2025-12-01");
});

test("summaries list every month of the period, empty ones too", () => {
  assert.deepEqual(monthsIn({ from: "2026-05-01", to: "2026-10-08" }), ["2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"]);
  assert.deepEqual(monthsIn({ from: "2025-11-15", to: "2026-02-01" }), ["2025-11", "2025-12", "2026-01", "2026-02"]);
  assert.deepEqual(monthsIn({ from: "2026-10-08", to: "2026-10-08" }), ["2026-10"]);
});

test("local reads: 'overdue for a service' asks about the fleet, not a machine called 'a service'", async () => {
  const { answerLocalRead, parseLocalReadRequest } = await import("./local-read");
  for (const question of ["Which machines are overdue for a service?", "Watter masjiene is agterstallig vir 'n diens?"]) {
    const request = parseLocalReadRequest(question);
    assert.ok(request, question);
    const answer = await answerLocalRead(request!, { supabase: {} as FarmDataScope["supabase"], farmId: "f", role: "owner", machines: [tractor] }, question.startsWith("W") && question.includes("diens") ? "af-ZA" : "en-ZA");
    assert.match(answer.message, /Red tractor/, question);
  }
});
