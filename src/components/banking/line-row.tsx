import { t, type Lang } from "@/lib/i18n";
import { rands } from "@/lib/money";
import { shortDate } from "@/lib/format";
import type { MatchConfidence } from "@/lib/banking";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { SubmitButton } from "@/components/ui/submit-button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { TrashIcon } from "@/components/ui/icons";
import { confirmMatch, undoMatch, setAsideLine, restoreLine, removeLine } from "@/app/(app)/banking/actions";

export type BankLineView = {
  id: string;
  txn_date: string;
  description: string | null;
  reference: string | null;
  amount_cents: number;
  status: string;
  matched_at: string | null;
  matched_document_id: string | null;
  matched_expense_id: string | null;
};

export type SuggestionView = {
  targetId: string;
  targetKind: "invoice" | "expense";
  confidence: MatchConfidence;
  reasons: string[];
  amountCents: number;
  outstandingCents: number;
  /** What the partner will recognise: an invoice number, a supplier's name. */
  label: string;
  sub: string | null;
};

const CONFIDENCE_TONE: Record<MatchConfidence, BadgeTone> = {
  strong: "ok",
  likely: "info",
  possible: "neutral",
};

/**
 * One bank line, and what can be done about it.
 *
 * The design decision worth stating: a suggestion is never pre-selected and never sits
 * behind a bare "Confirm" button. Each one names WHY it was suggested — the amount is
 * exactly what is owed, the reference contains the invoice number — and pressing it opens a
 * dialog that puts the bank line and the document's outstanding balance side by side. This
 * writes real money into a real customer's account, and it will be pressed on a phone, in a
 * hurry, by someone who has twenty of them to get through. The friction is the feature.
 */
export function BankLineRow({
  locale,
  line,
  suggestions,
  matchedLabel,
}: {
  locale: Lang;
  line: BankLineView;
  suggestions: SuggestionView[];
  matchedLabel?: string | null;
}) {
  const moneyIn = line.amount_cents > 0;

  return (
    <li className="flex flex-col gap-3 border-b border-sand-100 py-4 last:border-0">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="font-medium text-sand-900">
            {line.description || t("bank.noDescription", locale)}
          </p>
          <p className="text-sm text-sand-500">
            {shortDate(line.txn_date, locale)}
            {line.reference ? <span className="font-mono"> · {line.reference}</span> : null}
          </p>
        </div>
        <div className="text-right">
          <p
            className={`text-lg font-semibold tabular-nums ${moneyIn ? "text-status-ok" : "text-status-overdue"}`}
          >
            {rands(line.amount_cents)}
          </p>
          <p className="text-xs text-sand-500">
            {moneyIn ? t("bank.moneyIn", locale) : t("bank.moneyOut", locale)}
          </p>
        </div>
      </div>

      {line.status === "matched" ? (
        <div className="flex flex-wrap items-center gap-3 rounded-lg bg-sand-50 px-3 py-2.5">
          <span className="min-w-0 flex-1 text-sm text-sand-700">
            {t("bank.matchedTo", locale)}{" "}
            <span className="font-medium text-sand-900">{matchedLabel ?? "—"}</span>
            {line.matched_at ? (
              <span className="block text-xs text-sand-500">
                {t("bank.matchedOn", locale)} {shortDate(line.matched_at, locale)}
              </span>
            ) : null}
          </span>
          <ConfirmDialog
            action={undoMatch}
            triggerLabel={t("bank.undo", locale)}
            triggerVariant="ghost"
            triggerSize="sm"
            title={t("bank.undoTitle", locale)}
            intro={`${line.description ?? ""} · ${rands(line.amount_cents)}`}
            consequences={[
              t("bank.undoConsequence1", locale),
              t("bank.undoConsequence2", locale),
            ]}
            confirmLabel={t("bank.undo", locale)}
            cancelLabel={t("common.cancel", locale)}
            closeLabel={t("ui.close", locale)}
          >
            <input type="hidden" name="line_id" value={line.id} />
          </ConfirmDialog>
        </div>
      ) : null}

      {line.status === "ignored" ? (
        <div className="flex flex-wrap items-center gap-3 rounded-lg bg-sand-50 px-3 py-2.5">
          <span className="min-w-0 flex-1 text-sm text-sand-600">{t("bank.setAsideNote", locale)}</span>
          <form action={restoreLine}>
            <input type="hidden" name="line_id" value={line.id} />
            <SubmitButton variant="ghost" size="sm">
              {t("bank.restore", locale)}
            </SubmitButton>
          </form>
        </div>
      ) : null}

      {line.status === "unmatched" ? (
        <>
          {suggestions.length > 0 ? (
            <ul className="flex flex-col gap-2">
              {suggestions.map((sg) => (
                <li
                  key={`${sg.targetKind}-${sg.targetId}`}
                  className="flex flex-wrap items-center gap-3 rounded-lg border border-sand-200 px-3 py-2.5"
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-sand-900">{sg.label}</span>
                      <Badge tone={CONFIDENCE_TONE[sg.confidence]}>
                        {t(`bank.confidence.${sg.confidence}`, locale)}
                      </Badge>
                    </span>
                    {sg.sub ? <span className="block text-sm text-sand-500">{sg.sub}</span> : null}
                    {/* Why this was suggested, in words. A ranked list with no reasons is
                        just an oracle, and an oracle is not something a person can check. */}
                    <span className="mt-0.5 block text-xs text-sand-500">
                      {sg.reasons.map((r) => t(`bank.why.${r}`, locale)).join(" · ")}
                    </span>
                  </span>
                  <ConfirmDialog
                    action={confirmMatch}
                    triggerLabel={t("bank.confirmMatch", locale)}
                    triggerVariant="primary"
                    triggerSize="sm"
                    title={
                      sg.targetKind === "invoice"
                        ? t("bank.confirmInTitle", locale)
                        : t("bank.confirmOutTitle", locale)
                    }
                    intro={sg.label}
                    facts={[
                      {
                        label: t("bank.factBankLine", locale),
                        value: rands(Math.abs(line.amount_cents)),
                        hint: shortDate(line.txn_date, locale),
                      },
                      {
                        label:
                          sg.targetKind === "invoice"
                            ? t("bank.factOutstanding", locale)
                            : t("bank.factBillTotal", locale),
                        value: rands(sg.outstandingCents),
                      },
                    ]}
                    consequences={[
                      sg.targetKind === "invoice"
                        ? t("bank.confirmInConsequence", locale)
                        : t("bank.confirmOutConsequence", locale),
                    ]}
                    footnote={t("bank.confirmFootnote", locale)}
                    confirmLabel={t("bank.confirmMatch", locale)}
                    cancelLabel={t("common.cancel", locale)}
                    closeLabel={t("ui.close", locale)}
                    tone="brand"
                  >
                    <input type="hidden" name="line_id" value={line.id} />
                    <input type="hidden" name="target_kind" value={sg.targetKind} />
                    <input type="hidden" name="target_id" value={sg.targetId} />
                  </ConfirmDialog>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-sand-500">
              {moneyIn ? t("bank.noSuggestionsIn", locale) : t("bank.noSuggestionsOut", locale)}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <form action={setAsideLine}>
              <input type="hidden" name="line_id" value={line.id} />
              <SubmitButton variant="ghost" size="sm">
                {t("bank.setAside", locale)}
              </SubmitButton>
            </form>
            <ConfirmDialog
              action={removeLine}
              triggerLabel={t("common.remove", locale)}
              triggerIcon={<TrashIcon />}
              triggerVariant="ghost"
              triggerSize="sm"
              title={t("bank.removeTitle", locale)}
              intro={`${line.description ?? ""} · ${rands(line.amount_cents)}`}
              consequences={[
                t("bank.removeConsequence1", locale),
                t("bank.removeConsequence2", locale),
              ]}
              confirmLabel={t("common.remove", locale)}
              cancelLabel={t("common.cancel", locale)}
              closeLabel={t("ui.close", locale)}
            >
              <input type="hidden" name="line_id" value={line.id} />
            </ConfirmDialog>
          </div>
        </>
      ) : null}
    </li>
  );
}
