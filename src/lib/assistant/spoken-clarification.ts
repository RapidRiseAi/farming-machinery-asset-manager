import { normalizeAssistantText } from "./normalize";
import { replaceNumberWords } from "./numbers";
import { todayInSouthAfrica } from "./date";
import type { AssistantClarification, AssistantField } from "./types";

function spokenNumber(answer: string): number | null {
  // "Three thousand four hundred and fifty" / "drie duisend vier honderd en vyftig":
  // the reading said in words rather than digits.
  const value = /\d/.test(answer) ? answer : replaceNumberWords(normalizeAssistantText(answer));
  const matches = [...value.matchAll(/\b(\d{1,3}(?:[ ,.']\d{3})+|\d+(?:[.,]\d+)?)\b/g)];
  const raw = matches.at(-1)?.[1];
  if (!raw) return null;
  const parsed = Number(raw.replace(/[ ,'](?=\d{3}(?:\D|$))/g, "").replace(",", "."));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function clarificationFromSpeech(
  interactionId: string,
  field: AssistantField,
  answer: string,
): AssistantClarification | null {
  const value = answer.trim();
  if (!value) return null;
  const clarification: AssistantClarification = { interactionId };

  if (field.name === "machineId") clarification.machineQuery = value;
  else if (field.name === "description") clarification.description = value;
  else if (field.name === "workPerformed") clarification.workPerformed = value;
  else if (field.name === "reading") {
    const reading = spokenNumber(value);
    if (reading == null) return null;
    clarification.reading = reading;
  } else if (field.name === "urgency") {
    const normalized = normalizeAssistantText(value);
    // The question is "can the machine still operate safely?", so a bare "no" / "nee"
    // means it has stopped, and "dit staan" (it is standing) says the same.
    if (/\b(stopped|cannot work|cant work|can't work|out of service|standing|dead|no|nope|gestop|staan stil|staan|kan nie werk|nee)\b/.test(normalized)) {
      clarification.urgency = "stopped";
    } else if (/\b(limited|limping|reduced|sukkel|beperk)\b/.test(normalized)) {
      clarification.urgency = "limping";
    } else if (/\b(yes|yeah|yep|can still work|still works|safe|ja|jip|jep|kan nog werk|werk nog)\b/.test(normalized)) {
      clarification.urgency = "can_work";
    } else {
      return null;
    }
  } else if (field.name === "readingDate" || field.name === "serviceDate") {
    const normalized = normalizeAssistantText(value);
    const date = /\b(today|vandag)\b/.test(normalized)
      ? todayInSouthAfrica()
      : value.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0];
    if (!date) return null;
    clarification[field.name] = date;
  }

  return clarification;
}
