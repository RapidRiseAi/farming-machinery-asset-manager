"use client";

import { useRef, useState } from "react";
import { t, type Lang } from "@/lib/i18n";
import { menuItemClass } from "@/components/ui/menu-item";
import { ReceiptIcon } from "@/components/ui/icons";
import { attachReceipt } from "@/app/(app)/expenses/actions";

/**
 * Attaching the supplier's tax invoice to a row that is already captured.
 *
 * This is a client component for one reason: choosing the file submits it. In a table of
 * twenty supplier invoices, a "choose a file" followed by a separate "upload" is two taps
 * per row and a half-finished state in between, someone picks the photo, is called away,
 * and the row still reads as unsupported. Selecting a file IS the intent, so `onChange`
 * submits the form and the button is only there for anyone navigating by keyboard who
 * lands on it before the change event fires.
 *
 * The pending flag exists because a phone photo over a farm connection is not instant and
 * an input that looks idle invites a second attempt.
 *
 * `look="menuItem"` draws it as a row in a row's `ActionMenu`, which is where /expenses
 * keeps it now, beside "Mark paid" and "Remove", instead of as a link in a table cell.
 */
export function ReceiptUpload({
  expenseId,
  locale,
  compact = false,
  look = "link",
}: {
  expenseId: string;
  locale: Lang;
  compact?: boolean;
  look?: "link" | "menuItem";
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [pending, setPending] = useState(false);

  return (
    <form ref={formRef} action={attachReceipt} className="flex items-center gap-2">
      <input type="hidden" name="expense_id" value={expenseId} />
      <label
        className={
          look === "menuItem"
            ? menuItemClass("default", "cursor-pointer focus-within:outline focus-within:outline-2 focus-within:outline-brand-500")
            : "focus-within:outline-brand-500 cursor-pointer text-sm font-medium text-brand-ink underline decoration-dotted underline-offset-2 hover:text-brand-800"
        }
      >
        {look === "menuItem" ? <ReceiptIcon className="shrink-0" /> : null}
        {pending
          ? t("expenses.receiptUploading", locale)
          : look === "menuItem"
            ? t("expenses.receiptAttachMenu", locale)
            : t("expenses.receiptAttach", locale)}
        <input
          type="file"
          name="receipt"
          accept="image/*,application/pdf"
          disabled={pending}
          className="sr-only"
          onChange={() => {
            setPending(true);
            formRef.current?.requestSubmit();
          }}
        />
      </label>
      {compact ? null : (
        <noscript>
          <button type="submit" className="text-sm underline">
            {t("expenses.receiptAttach", locale)}
          </button>
        </noscript>
      )}
    </form>
  );
}
