"use client";

import { useState } from "react";
import { t, type Lang } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { TextareaField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";

/**
 * Saying no to a quote, with a reason.
 *
 * The "no" path is deliberately as visible as the "yes" — a farmer who cannot find how to
 * decline simply ignores the quote, and the partner is left guessing. Declining asks for
 * one line of reason because "too expensive" and "we fixed it ourselves" lead the partner
 * to completely different next moves, and neither is guessable from silence.
 */
export function DeclineQuote({
  locale,
  documentId,
  action,
}: {
  locale: Lang;
  documentId: string;
  action: (formData: FormData) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
        {t("doc.decline", locale)}
      </Button>
    );
  }

  return (
    <form action={action} className="flex w-full flex-col gap-3 rounded-xl border border-sand-200 bg-sand-50/60 p-3">
      <input type="hidden" name="document_id" value={documentId} />
      <TextareaField
        name="reason"
        rows={3}
        label={t("doc.declineReason", locale)}
        hint={t("doc.declineReasonHint", locale)}
      />
      <div className="flex flex-wrap gap-2">
        <SubmitButton variant="danger">{t("doc.decline", locale)}</SubmitButton>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
          {t("common.cancel", locale)}
        </Button>
      </div>
    </form>
  );
}
