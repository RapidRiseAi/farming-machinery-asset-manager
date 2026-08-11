import { t, type Lang } from "@/lib/i18n";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { SubmitButton } from "@/components/ui/submit-button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { rands } from "@/lib/money";
import { correctionsFor, type DocKind, type DocStatus } from "@/lib/partner-docs";
import { voidDocument, createCreditNote, createDebitNote, writeOffDocument } from "@/app/(app)/documents/actions";

export type CorrectionDoc = {
  id: string;
  kind: DocKind;
  status: DocStatus;
  number: string;
  total_cents: number;
  void_reason: string | null;
  written_off_reason: string | null;
  /**
   * What is genuinely still owed: total less payments AND less anything already credited
   * back. Not the raw balance — an invoice with a credit note against it owes less than
   * `total − paid`, and a confirmation naming the wrong figure is worse than none.
   */
  outstanding_cents: number;
};

export type CreditNoteRef = { id: string; number: string; total_cents: number; status: DocStatus };

/**
 * "Something is wrong with this document."
 *
 * The panel exists because the honest answer used to be "phone the customer". A sent
 * document was correctly locked, and the only escape was a cancel button that erased the
 * farm's cost entry without recording a reason — so the number moved and nothing said
 * why.
 *
 * Three ways to be wrong, three different answers, and the panel names them in the words
 * a partner would use rather than in accounting vocabulary:
 *
 *   the amount is wrong    → a credit note, then a fresh invoice. The customer's account
 *                            shows what was billed AND what was credited back, which is
 *                            what actually happened.
 *   it should not exist    → void it, with a reason. Number and history stay; the money
 *                            stands down.
 *   never sent             → delete it (handled by the draft actions, not here).
 *
 * Crediting is offered FIRST for an invoice because it is almost always the right one,
 * and voiding is behind a reason box because a void with no explanation is how a
 * statement ends up unexplainable six months later.
 */
export function CorrectionPanel({
  doc,
  credits,
  locale,
}: {
  doc: CorrectionDoc;
  credits: CreditNoteRef[];
  locale: Lang;
}) {
  const options = correctionsFor(doc);
  if (options.length === 0 && credits.length === 0) return null;

  const creditedCents = credits
    .filter((c) => c.status !== "draft" && c.status !== "void")
    .reduce((s, c) => s + c.total_cents, 0);
  const remaining = Math.max(0, doc.total_cents - creditedCents);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("correct.title", locale)}</CardTitle>
      </CardHeader>

      {doc.status === "void" ? (
        <p className="text-sm text-sand-600">
          <Badge tone="warning" className="mr-2 align-middle">{t("docStatus.void", locale)}</Badge>
          {doc.void_reason}
        </p>
      ) : doc.status === "written_off" ? (
        <p className="text-sm text-sand-600">
          <Badge tone="danger" className="mr-2 align-middle">{t("docStatus.written_off", locale)}</Badge>
          {doc.written_off_reason}
        </p>
      ) : (
        <p className="mb-3 text-sm text-sand-600">{t("correct.intro", locale)}</p>
      )}

      {credits.length > 0 ? (
        <div className="mb-3 rounded-lg border border-sand-200 bg-sand-50 p-3">
          <p className="text-sm font-medium text-sand-900">{t("correct.creditedTitle", locale)}</p>
          <ul className="mt-1.5 flex flex-col gap-1 text-sm">
            {credits.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-3">
                <a className="focus-ring rounded text-brand-700 underline-offset-2 hover:underline" href={`/documents/${c.id}`}>
                  {c.number}
                </a>
                <span className="tabular-nums text-sand-700">
                  −{rands(c.total_cents)}
                  {c.status === "draft" ? ` (${t("docStatus.draft", locale)})` : ""}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-2 border-t border-sand-200 pt-2 text-sm text-sand-600">
            {t("correct.remaining", locale)}{" "}
            <span className="font-semibold tabular-nums text-sand-900">{rands(remaining)}</span>
          </p>
        </div>
      ) : null}

      {options.includes("credit") ? (
        <>
          {/* Money back to the customer. Kept alongside the edit form rather than instead
              of it, because a refund on an invoice the customer has already PAID has to be
              its own event — you cannot correct that away, and 0417 refuses to. */}
          <form action={createCreditNote} className="flex flex-col gap-3 border-t border-sand-100 pt-3">
            <input type="hidden" name="document_id" value={doc.id} />
            <p className="text-sm font-medium text-sand-900">{t("correct.overcharged", locale)}</p>
            <p className="-mt-2 text-sm text-sand-600">{t("correct.overchargedHint", locale)}</p>
            <Field label={t("correct.reason", locale)} hint={t("correct.reasonHint", locale)} htmlFor="credit-reason">
              <Input id="credit-reason" name="reason" maxLength={200} />
            </Field>
            <SubmitButton variant="secondary" className="self-start">{t("correct.startCredit", locale)}</SubmitButton>
          </form>

          {/* The other half of an adjustment, and the one AutoVault has that we did not:
              the invoice was too LOW. Without it, a part left off an invoice could only
              become a second invoice, which reads as an unrelated charge on a statement. */}
          <form action={createDebitNote} className="flex flex-col gap-3 border-t border-sand-100 pt-3">
            <input type="hidden" name="document_id" value={doc.id} />
            <p className="text-sm font-medium text-sand-900">{t("correct.undercharged", locale)}</p>
            <p className="-mt-2 text-sm text-sand-600">{t("correct.underchargedHint", locale)}</p>
            <Field label={t("correct.reason", locale)} hint={t("correct.reasonHint", locale)} htmlFor="debit-reason">
              <Input id="debit-reason" name="reason" maxLength={200} />
            </Field>
            <SubmitButton variant="secondary" className="self-start">{t("correct.startDebit", locale)}</SubmitButton>
          </form>
        </>
      ) : null}

      {options.includes("write_off") ? (
        <div className="mt-3 border-t border-sand-100 pt-3">
          <p className="text-sm font-medium text-sand-900">{t("correct.neverPaying", locale)}</p>
          <p className="mt-0.5 text-sm text-sand-600">{t("correct.neverPayingHint", locale)}</p>
          <ConfirmDialog
            action={writeOffDocument}
            triggerLabel={t("correct.writeOff", locale)}
            triggerVariant="ghost"
            triggerSize="sm"
            triggerClassName="mt-2"
            title={t("correct.writeOffTitle", locale).replace("{number}", doc.number)}
            intro={t("correct.writeOffBody", locale)}
            facts={[{ label: t("correct.stillOwed", locale), value: rands(doc.outstanding_cents) }]}
            consequences={[
              t("correct.writeOffConsequence1", locale),
              t("correct.writeOffConsequence2", locale),
              t("correct.writeOffConsequence3", locale),
            ]}
            confirmLabel={t("correct.writeOff", locale)}
            cancelLabel={t("common.cancel", locale)}
            closeLabel={t("ui.close", locale)}
          >
            <input type="hidden" name="document_id" value={doc.id} />
            <Field label={t("correct.writeOffReason", locale)} hint={t("correct.writeOffReasonHint", locale)} htmlFor="writeoff_reason">
              <Input id="writeoff_reason" name="reason" required minLength={3} maxLength={500} />
            </Field>
          </ConfirmDialog>
        </div>
      ) : null}

      {options.includes("void") ? (
        <div className="mt-3 border-t border-sand-100 pt-3">
          <p className="text-sm font-medium text-sand-900">{t("correct.shouldNotExist", locale)}</p>
          <p className="mt-0.5 text-sm text-sand-600">{t("correct.shouldNotExistHint", locale)}</p>
          <ConfirmDialog
            action={voidDocument}
            triggerLabel={t("correct.void", locale)}
            triggerVariant="ghost"
            triggerSize="sm"
            triggerClassName="mt-2"
            title={t("correct.voidTitle", locale).replace("{number}", doc.number)}
            intro={t("correct.voidBody", locale)}
            consequences={[t("correct.voidConsequence1", locale), t("correct.voidConsequence2", locale)]}
            confirmLabel={t("correct.void", locale)}
            cancelLabel={t("common.cancel", locale)}
            closeLabel={t("ui.close", locale)}
          >
            <input type="hidden" name="document_id" value={doc.id} />
            <Field label={t("correct.voidReason", locale)} hint={t("correct.voidReasonHint", locale)} htmlFor="void_reason">
              <Input id="void_reason" name="void_reason" required minLength={3} maxLength={500} />
            </Field>
          </ConfirmDialog>
        </div>
      ) : null}
    </Card>
  );
}
