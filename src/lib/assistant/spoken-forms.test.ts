import assert from "node:assert/strict";
import test from "node:test";
import { matchMachine, normalizeAssistantText } from "./normalize";
import { crossLanguageVariants, shortSpokenForms, soundKey } from "./spoken-forms";
import { speechVocabulary } from "./speech-plan";
import type { AssistantMachine } from "./types";

function machine(id: string, name: string, extra: Partial<AssistantMachine> = {}): AssistantMachine {
  return {
    id,
    name,
    make: null,
    model: null,
    aliases: [],
    status: "active",
    meterType: "hours",
    currentReading: null,
    currentReadingDate: null,
    serviceStatus: null,
    nextDueDate: null,
    nextDueReading: null,
    ...extra,
  };
}

const fleet: AssistantMachine[] = [
  machine("aaaaaaaa-0000-4000-8000-000000000001", "Rooi Toyota Bakkie", { make: "Toyota", model: "Hilux", meterType: "km" }),
  machine("aaaaaaaa-0000-4000-8000-000000000002", "Wit Isuzu Bakkie", { make: "Isuzu", model: "D-Max", meterType: "km" }),
  machine("aaaaaaaa-0000-4000-8000-000000000003", "John Deere 6155R", { make: "John Deere", model: "6155R", aliases: ["Big John"] }),
  machine("aaaaaaaa-0000-4000-8000-000000000004", "Groen Trekker", { make: "Massey Ferguson", model: "7618" }),
];

test("the same machine said in Afrikaans and heard in English folds to one sound", () => {
  assert.equal(soundKey("rooi bakkie"), soundKey("roy backie"));
  assert.equal(soundKey("rooi bakkie"), soundKey("roy bucky"));
  assert.equal(soundKey("wit bakkie"), soundKey("vit backie"));
  assert.equal(soundKey("bakkie's"), soundKey("bakkie"));
});

test("colour and type words translate both ways", () => {
  assert.ok(crossLanguageVariants("wit isuzu bakkie").includes("white isuzu bakkie"));
  assert.ok(crossLanguageVariants("groen trekker").includes("green tractor"));
  assert.ok(crossLanguageVariants("red tractor").includes("rooi trekker"));
  assert.deepEqual(crossLanguageVariants("john deere 6155r"), []);
});

test("a name with a colour and a type gives the short way people say it", () => {
  assert.ok(shortSpokenForms("Rooi Toyota Bakkie").includes("rooi bakkie"));
  assert.ok(shortSpokenForms("Rooi Toyota Bakkie").includes("red bakkie"));
  assert.deepEqual(shortSpokenForms("John Deere 6155R"), []);
});

test("a mixed sentence finds the machine: the status of the rooi bakkie's repairs", () => {
  const exact = matchMachine("what is the status of the rooi bakkie's repairs", fleet);
  assert.equal(exact.machine?.name, "Rooi Toyota Bakkie");
  // The English model heard the Afrikaans words as English ones.
  const misheard = matchMachine("what is the status of the roy backie's repairs", fleet);
  assert.equal(misheard.machine?.name, "Rooi Toyota Bakkie");
});

test("the other language's words find the machine", () => {
  assert.equal(matchMachine("is the white bakkie booked for a service", fleet).machine?.name, "Wit Isuzu Bakkie");
  assert.equal(matchMachine("log 4300 hours on the green tractor", fleet).machine?.name, "Groen Trekker");
  assert.equal(matchMachine("die rooi pickup se diens", fleet).machine?.name, "Rooi Toyota Bakkie");
});

test("a colour said in Afrikaans finds a machine named in English", () => {
  const english = [...fleet, machine("aaaaaaaa-0000-4000-8000-000000000006", "Red Massey", { make: "Massey Ferguson", model: "5713" })];
  assert.equal(matchMachine("wat kort die rooi massey", english).machine?.name, "Red Massey");
});

test("two machines that both fit stay ambiguous, so the assistant asks", () => {
  const twoRed = [
    ...fleet,
    machine("aaaaaaaa-0000-4000-8000-000000000005", "Rooi Ford Bakkie", { make: "Ford", model: "Ranger", meterType: "km" }),
  ];
  const result = matchMachine("what is wrong with the rooi bakkie", twoRed);
  assert.equal(result.machine, null);
  assert.equal(result.ambiguous, true);
  assert.equal(result.alternatives.length >= 2, true);
});

test("ordinary matches are unchanged", () => {
  assert.equal(matchMachine("service the John Deere", fleet).machine?.name, "John Deere 6155R");
  assert.equal(matchMachine("big john needs a filter", fleet).machine?.name, "John Deere 6155R");
  // Nothing in the sentence names a machine: no forced guess.
  assert.equal(matchMachine("how much diesel did we use this month", fleet).machine, null);
});

// A fleet with Afrikaans-coined names, two John Deeres and two tractors: the shapes that
// broke on real Azure transcripts (quoted as recorded) and in the failure probes.
const farm: AssistantMachine[] = [
  machine("bbbbbbbb-0000-4000-8000-000000000001", "Ou Blou", { make: "John Deere", model: "6120M" }),
  machine("bbbbbbbb-0000-4000-8000-000000000002", "Rooi Bakkie", { make: "Toyota", model: "Hilux", meterType: "km" }),
  machine("bbbbbbbb-0000-4000-8000-000000000003", "Groot Trekker", { make: "Case IH", model: "Magnum 340" }),
  machine("bbbbbbbb-0000-4000-8000-000000000004", "Die Ou Massey", { make: "Massey Ferguson", model: "290" }),
  machine("bbbbbbbb-0000-4000-8000-000000000005", "Witkop", { make: "New Holland", model: "T7.210" }),
  machine("bbbbbbbb-0000-4000-8000-000000000006", "Oom Piet se Trok", { make: "Mercedes-Benz", model: "Atego 1518", meterType: "km" }),
  machine("bbbbbbbb-0000-4000-8000-000000000007", "John Deere 6155R", { make: "John Deere", model: "6155R" }),
  machine("bbbbbbbb-0000-4000-8000-000000000008", "Big Red", { make: "Case IH", model: "Puma 185" }),
  machine("bbbbbbbb-0000-4000-8000-000000000009", "Klein Trekker", { make: "Kubota", model: "M7060" }),
];
const named = (text: string) => matchMachine(text, farm).machine?.name ?? null;

test("a type word alone names nothing: 'the tractor' asks rather than picking one", () => {
  const result = matchMachine("Report a fault on the tractor, it is leaking oil.", farm);
  assert.equal(result.machine, null);
  assert.equal(named("Report a fault on the big tractor."), "Groot Trekker");
  // A mishearing ("great" for "groot") is left to the transcriber, and must not pull
  // "Big Red" into a tie by way of a made-up "great red".
  assert.notEqual(named("The great tracker has a hydraulic leak."), "Big Red");
});

test("a contradicting colour vetoes a match", () => {
  assert.equal(named("What's the status of the white bakkie?"), null);
  const toyotas = [machine("cccccccc-0000-4000-8000-000000000001", "Rooi Toyota Bakkie", { make: "Toyota", model: "Hilux", meterType: "km" })];
  assert.equal(matchMachine("the white toyota bakkie needs tyres", toyotas).machine, null);
  assert.equal(matchMachine("the white Toyota needs tyres", toyotas).machine, null);
  assert.equal(matchMachine("the red toyota bakkie needs tyres", toyotas).machine?.name, "Rooi Toyota Bakkie");
  // A colour that describes a symptom is not the machine's colour.
  assert.equal(named("There is white smoke coming from Ou Blou."), "Ou Blou");
  assert.equal(named("Die rooi waarskuwingslig brand op die Witkop."), "Witkop");
});

test("a make two machines share cannot outvote one machine's own name", () => {
  assert.equal(named("Wat is die status van die john deere? 6155."), "John Deere 6155R");
  const both = matchMachine("Service the John Deere.", farm);
  assert.equal(both.machine, null, "the make alone stays ambiguous");
  assert.equal(both.ambiguous, true);
});

test("a derived spelling ranks below another machine's real name", () => {
  assert.equal(named("Die bik rêd se enjin lek olie."), "Big Red");
});

test("Azure's Afrikaans full stops do not split or glue names", () => {
  assert.equal(named("Lok want toe 5 zero kilometers vir oompiet.se trok."), "Oom Piet se Trok");
  assert.equal(named("Vit cop."), "Witkop");
  assert.equal(normalizeAssistantText("Model T7.210, reading 4300.5."), "model t7.210 reading 4300.5");
});

test("articles, descriptors and possessives translate: the old Massey, Uncle Piet's truck", () => {
  assert.equal(named("Log 3,450 hours on the old Massey."), "Die Ou Massey");
  assert.equal(named("What's the status of Uncle Piet's truck?"), "Oom Piet se Trok");
  assert.ok(crossLanguageVariants("oom piet se trok").includes("uncle piet's truck"));
});

test("the recogniser is told the short spoken forms too", () => {
  const vocabulary = speechVocabulary(fleet);
  assert.ok(vocabulary.includes("rooi bakkie"));
  assert.ok(vocabulary.includes("wit bakkie"));
  assert.ok(vocabulary.includes("bakkie"));
  assert.ok(vocabulary.length <= 500);
});
