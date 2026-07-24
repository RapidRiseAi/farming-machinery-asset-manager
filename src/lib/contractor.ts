/**
 * Contractor per-kind view-router (F12c, spec §5).
 *
 * A contractor/supplier is a `workshop` classified by `contractor_kind` (0300). The
 * aggregated contractor dashboard (`/contractor`) shares ONE set of components but tailors
 * the DEFAULT filter, focus and copy to the contractor's kind: a mechanic lands on
 * repairs/inspections, a parts supplier on parts/quote requests (+ a catalogue shortcut),
 * an auto-electrician on electrical repairs, and so on. This keeps the surface identical
 * across kinds while making each contractor's first screen fit their trade.
 *
 * The `contractor_kind` labels reuse the existing `partnerKind.*` i18n keys (0300/F12a) —
 * no new label keys. The work-request kinds themselves live in `src/lib/work.ts`.
 */
import { t, type Locale } from "@/lib/i18n";
import type { WorkKind } from "@/lib/work";

export const CONTRACTOR_KINDS = [
  "mechanic",
  "auto_electrician",
  "parts_supplier",
  "panel_beater",
  "tyre",
  "towing",
  "other",
] as const;

export type ContractorKind = (typeof CONTRACTOR_KINDS)[number];

export function isContractorKind(v: string): v is ContractorKind {
  return (CONTRACTOR_KINDS as readonly string[]).includes(v);
}

/** Display label for a contractor kind — reuses F12a's `partnerKind.*` keys. */
export const contractorKindLabel = (kind: string, locale: Locale) =>
  t(`partnerKind.${kind}`, locale);

/**
 * The tailored default for one contractor kind. `focusKinds` are the work-request kinds
 * this trade primarily handles (the dashboard's default filter + highlighted focus
 * chips); `showParts` surfaces a parts-catalogue shortcut for suppliers/mechanics;
 * `taglineKey` is the per-kind subheading under the dashboard title.
 */
export type ContractorView = {
  kind: ContractorKind;
  focusKinds: WorkKind[];
  showParts: boolean;
  taglineKey: string;
};

const ALL_KINDS: WorkKind[] = ["repair", "quote", "inspection", "parts", "other"];

export const CONTRACTOR_VIEWS: Record<ContractorKind, ContractorView> = {
  mechanic: {
    kind: "mechanic",
    focusKinds: ["repair", "inspection"],
    showParts: true,
    taglineKey: "contractor.tagline.mechanic",
  },
  auto_electrician: {
    kind: "auto_electrician",
    focusKinds: ["repair", "inspection"],
    showParts: true,
    taglineKey: "contractor.tagline.auto_electrician",
  },
  parts_supplier: {
    kind: "parts_supplier",
    focusKinds: ["parts", "quote"],
    showParts: true,
    taglineKey: "contractor.tagline.parts_supplier",
  },
  panel_beater: {
    kind: "panel_beater",
    focusKinds: ["repair", "quote"],
    showParts: false,
    taglineKey: "contractor.tagline.panel_beater",
  },
  tyre: {
    kind: "tyre",
    focusKinds: ["repair", "parts"],
    showParts: true,
    taglineKey: "contractor.tagline.tyre",
  },
  towing: {
    kind: "towing",
    focusKinds: ["repair", "other"],
    showParts: false,
    taglineKey: "contractor.tagline.towing",
  },
  other: {
    kind: "other",
    focusKinds: ALL_KINDS,
    showParts: false,
    taglineKey: "contractor.tagline.other",
  },
};

/** Resolve the tailored view for a workshop kind (unknown → the generic "other" view). */
export function contractorView(kind: string | null | undefined): ContractorView {
  return isContractorKind(kind ?? "") ? CONTRACTOR_VIEWS[kind as ContractorKind] : CONTRACTOR_VIEWS.other;
}
