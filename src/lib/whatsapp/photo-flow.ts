import { t, type Lang } from "@/lib/i18n";

/**
 * What a WhatsApp photo is for, asked as a short conversation (20261104210000).
 *
 * A photo on its own says nothing about where it belongs, and filing it under the wrong
 * machine is worse than not filing it. So the worker stages it and asks: report a new
 * problem (the assistant prepares a fault for the person to confirm, and the photo is
 * attached once they do), add it to a problem already logged (chosen from a numbered
 * list), or discard it. Pure functions here; the worker does the reading and writing.
 *
 * The state rides in `whatsapp_links.conversation`, so it lapses with the conversation
 * (ten minutes for the worker, fifteen for the prune), and a lapsed photo is removed by
 * `expireStagedPhotos`.
 */

export type PhotoFault = { id: string; label: string };
export type PhotoState = {
  kind: "photo";
  mediaId: string;
  stage: "choose" | "describe" | "pick_fault";
  caption: string | null;
  faults?: PhotoFault[];
};

export type PhotoStep =
  | { do: "describe" }
  | { do: "report"; input: string }
  | { do: "list_faults" }
  | { do: "attach"; fault: PhotoFault }
  | { do: "discard" }
  | { do: "repeat" };

const DISCARD_WORDS = /^(discard|delete|cancel|no|weggooi|gooi weg|kanselleer|nee)$/i;

export function isPhotoState(value: unknown): value is PhotoState {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<PhotoState>;
  return v.kind === "photo" && typeof v.mediaId === "string"
    && (v.stage === "choose" || v.stage === "describe" || v.stage === "pick_fault");
}

/**
 * The text the assistant is given for a new problem. Named as a fault report so the model
 * reaches for `propose_fault_report` rather than answering a question about the machine.
 */
export function reportInput(description: string): string {
  return `Report a fault: ${description.trim().slice(0, 1800)}`;
}

/** What the person's reply means at this stage of the photo conversation. */
export function photoStep(state: PhotoState, input: string): PhotoStep {
  const s = input.trim();
  if (DISCARD_WORDS.test(s)) return { do: "discard" };
  switch (state.stage) {
    case "choose":
      if (s === "1") return state.caption ? { do: "report", input: reportInput(state.caption) } : { do: "describe" };
      if (s === "2") return { do: "list_faults" };
      if (s === "3") return { do: "discard" };
      // A description straight away ("JD 6120 leaking oil") is taken as a new problem.
      return describes(s) ? { do: "report", input: reportInput(s) } : { do: "repeat" };
    case "describe":
      return describes(s) ? { do: "report", input: reportInput(s) } : { do: "repeat" };
    case "pick_fault": {
      const n = /^\d{1,2}$/.test(s) ? Number(s) : 0;
      const fault = state.faults?.[n - 1];
      return fault ? { do: "attach", fault } : { do: "repeat" };
    }
  }
}

/** Words, not a stray number or a one-word "ok". */
function describes(s: string): boolean {
  return s.length >= 6 && /[a-z]/i.test(s) && !/^\d+$/.test(s);
}

export function photoPrompt(lang: Lang, caption: string | null): string {
  return [
    t("whatsapp.photoReceived", lang),
    caption ? t("whatsapp.photoCaption", lang).replace("{caption}", caption.slice(0, 200)) : null,
    t("whatsapp.photoChoices", lang),
  ].filter(Boolean).join("\n");
}

export function faultListPrompt(lang: Lang, faults: PhotoFault[]): string {
  return [
    t("whatsapp.photoPickFault", lang),
    ...faults.map((f, i) => `${i + 1}. ${f.label}`),
  ].join("\n");
}

/** One line per open fault: the machine and the first words of what is wrong. */
export function faultLabel(machine: string | null, description: string | null, lang: Lang): string {
  const what = (description ?? "").replace(/\s+/g, " ").trim();
  const short = what.length > 60 ? `${what.slice(0, 57)}...` : what;
  return [machine?.trim() || t("whatsapp.photoUnknownMachine", lang), short].filter(Boolean).join(": ");
}
