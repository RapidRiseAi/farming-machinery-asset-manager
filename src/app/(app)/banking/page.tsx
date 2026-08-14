import Link from "next/link";
import { redirect } from "next/navigation";
import { requireProfile, currentWorkshop } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { t } from "@/lib/i18n";
import { rands } from "@/lib/money";
import { shortDate, relativeDate } from "@/lib/format";
import {
  suggestInvoiceMatches, suggestExpenseMatches,
  type BankLineLike, type InvoiceCandidate, type ExpenseCandidate,
} from "@/lib/banking";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Stat } from "@/components/ui/stat";
import { Flash } from "@/components/ui/flash";
import { Button } from "@/components/ui/button";
import { AllClear, GetStarted } from "@/components/ui/empty-state";
import { BankLineRow, type BankLineView, type SuggestionView } from "@/components/banking/line-row";

export const dynamic = "force-dynamic";

/** How much statement history the screen works with. Reconciliation is a recent-weeks job;
 *  pulling a whole year of lines into one page would make it slow at exactly the moment a
 *  partner is trying to get through a backlog. */
const LINE_LIMIT = 300;
const CANDIDATE_LIMIT = 400;

type LineRow = BankLineView & { import_id: string | null };

/**
 * Reconciling the bank (G15).
 *
 * Customers pay by EFT and that happens entirely outside this product, so until now the only
 * way an invoice became "paid" was a partner reading internet banking on one screen and
 * typing into another. The cost of that is not the minutes — it is that it does not get
 * done, and every number downstream (the ageing, the debtors list, a statement that will be
 * argued about with a customer) is only as true as the typing.
 *
 * The screen is ordered by what is actually in the way: what has not been dealt with comes
 * first, worst first is meaningless here so it is newest first, and everything already
 * reconciled is pushed to the bottom where it can be checked but not waded through.
 */
export default async function BankingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const profile = await requireProfile();
  if (profile.role !== "workshop") redirect("/documents");
  const locale = profile.lang;
  const sp = await searchParams;

  const { workshop } = await currentWorkshop(profile);
  if (!workshop) redirect("/contractor?error=no-workshop");

  const supabase = await createClient();

  // Everything the page needs, fetched together. RLS scopes all four to this workshop, so
  // none of them carry a workshop filter — a missing filter here would be a bug in a query,
  // not a hole, because the policies decide.
  const [linesRes, importsRes, invoiceRes, expenseRes] = await Promise.all([
    supabase
      .from("bank_lines")
      .select("id, txn_date, description, reference, amount_cents, status, matched_at, matched_document_id, matched_expense_id, import_id")
      .is("deleted_at", null)
      .order("txn_date", { ascending: false })
      .order("row_no", { ascending: true })
      .limit(LINE_LIMIT),
    supabase
      .from("bank_statement_imports")
      .select("id, file_name, account_label, rows_in_file, rows_added, imported_at")
      .is("deleted_at", null)
      .order("imported_at", { ascending: false })
      .limit(3),
    supabase
      .from("partner_documents")
      .select("id, number, bill_to_name, issue_date, due_date, total_cents, amount_paid_cents")
      .eq("kind", "invoice")
      .in("status", ["sent", "part_paid"])
      .is("deleted_at", null)
      .order("issue_date", { ascending: false })
      .limit(CANDIDATE_LIMIT),
    supabase
      .from("partner_expenses")
      .select("id, supplier_name, reference, expense_date, amount_cents, vat_cents")
      .is("paid_on", null)
      .is("deleted_at", null)
      .order("expense_date", { ascending: false })
      .limit(CANDIDATE_LIMIT),
  ]);

  const lines = (linesRes.data ?? []) as LineRow[];
  const imports = (importsRes.data ?? []) as {
    id: string; file_name: string | null; account_label: string | null;
    rows_in_file: number; rows_added: number; imported_at: string;
  }[];
  const invoices = (invoiceRes.data ?? []) as InvoiceCandidate[];
  const expenses = (expenseRes.data ?? []) as ExpenseCandidate[];

  const unmatched = lines.filter((l) => l.status === "unmatched");
  const matched = lines.filter((l) => l.status === "matched");
  const aside = lines.filter((l) => l.status === "ignored");

  const openIn = unmatched.filter((l) => l.amount_cents > 0).reduce((s, l) => s + l.amount_cents, 0);
  const openOut = unmatched.filter((l) => l.amount_cents < 0).reduce((s, l) => s + -l.amount_cents, 0);

  // What a matched line settled, so the reconciled list reads as sentences rather than ids.
  // Fetched from the documents/expenses themselves because a fully paid invoice is no longer
  // in the candidate list above — and it is the settled ones that end up here.
  const docIds = matched.map((l) => l.matched_document_id).filter((v): v is string => !!v);
  const expIds = matched.map((l) => l.matched_expense_id).filter((v): v is string => !!v);
  const [matchedDocs, matchedExps] = await Promise.all([
    docIds.length
      ? supabase.from("partner_documents").select("id, number, bill_to_name").in("id", docIds)
      : Promise.resolve({ data: [] }),
    expIds.length
      ? supabase.from("partner_expenses").select("id, supplier_name, reference").in("id", expIds)
      : Promise.resolve({ data: [] }),
  ]);
  const docLabel = new Map(
    ((matchedDocs.data ?? []) as { id: string; number: string; bill_to_name: string | null }[])
      .map((d) => [d.id, `${d.number}${d.bill_to_name ? ` · ${d.bill_to_name}` : ""}`]),
  );
  const expLabel = new Map(
    ((matchedExps.data ?? []) as { id: string; supplier_name: string; reference: string | null }[])
      .map((e) => [e.id, `${e.supplier_name}${e.reference ? ` · ${e.reference}` : ""}`]),
  );

  const invoiceById = new Map(invoices.map((i) => [i.id, i]));
  const expenseById = new Map(expenses.map((e) => [e.id, e]));

  /** Rank the candidates for one line, then dress them in what the partner will recognise.
   *  The ranking itself lives in `lib/banking.ts` so the same code answers on the server and
   *  in any future preview — a suggestion that differed between the two would be the worst
   *  kind of bug, because it would look like the button did something else than it said. */
  const viewsFor = (line: LineRow): SuggestionView[] => {
    const like: BankLineLike = {
      id: line.id,
      txn_date: line.txn_date,
      description: line.description,
      reference: line.reference,
      amount_cents: line.amount_cents,
    };
    if (line.amount_cents > 0) {
      return suggestInvoiceMatches(like, invoices).map((sg) => {
        const inv = invoiceById.get(sg.targetId);
        return {
          ...sg,
          targetKind: "invoice" as const,
          label: inv ? `${inv.number}${inv.bill_to_name ? ` · ${inv.bill_to_name}` : ""}` : sg.targetId,
          sub: inv
            ? `${t("bank.issued", locale)} ${shortDate(inv.issue_date, locale)} · ${t("bank.owing", locale)} ${rands(sg.outstandingCents)}`
            : null,
        };
      });
    }
    return suggestExpenseMatches(like, expenses).map((sg) => {
      const ex = expenseById.get(sg.targetId);
      return {
        ...sg,
        targetKind: "expense" as const,
        label: ex ? `${ex.supplier_name}${ex.reference ? ` · ${ex.reference}` : ""}` : sg.targetId,
        sub: ex
          ? `${t("bank.dated", locale)} ${shortDate(ex.expense_date, locale)} · ${rands(sg.outstandingCents)}`
          : null,
      };
    });
  };

  const last = imports[0];
  const knownErrors = new Set([
    "not_found", "wrong_direction", "not_an_invoice", "already_settled", "more_than_owed",
  ]);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0">
          <h1 className="text-xl font-bold tracking-tight text-sand-900">{t("bank.title", locale)}</h1>
          <p className="text-sm text-sand-600">{t("bank.lead", locale)}</p>
        </div>
        <Link href="/banking/import" className="ml-auto">
          <Button variant="primary">{t("bank.loadStatement", locale)}</Button>
        </Link>
      </div>

      <Flash
        tone="error"
        message={sp.error ? (knownErrors.has(sp.error) ? t(`bank.err.${sp.error}`, locale) : sp.error) : undefined}
      />
      <Flash
        tone="success"
        message={
          sp.imported
            ? t("bank.importedFlash", locale)
                .replace("{n}", sp.imported)
                .replace("{seen}", sp.seen ?? sp.imported)
            : undefined
        }
      />
      <Flash tone="success" message={sp.matched ? t("bank.matchedFlash", locale) : undefined} />
      <Flash tone="info" message={sp.already ? t("bank.alreadyFlash", locale) : undefined} />
      <Flash tone="success" message={sp.undone ? t("bank.undoneFlash", locale) : undefined} />
      <Flash tone="success" message={sp.aside ? t("bank.asideFlash", locale) : undefined} />
      <Flash tone="success" message={sp.restored ? t("bank.restoredFlash", locale) : undefined} />
      <Flash tone="success" message={sp.removed ? t("bank.removedFlash", locale) : undefined} />

      {lines.length === 0 ? (
        <GetStarted
          title={t("bank.emptyTitle", locale)}
          hint={t("bank.emptyBody", locale)}
          action={
            <Link href="/banking/import">
              <Button variant="primary">{t("bank.loadStatement", locale)}</Button>
            </Link>
          }
        />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat
              label={t("bank.statOpen", locale)}
              value={String(unmatched.length)}
              delta={t("bank.statOpenHint", locale)}
              tone={unmatched.length > 0 ? "due" : "ok"}
            />
            <Stat
              label={t("bank.statOpenIn", locale)}
              value={rands(openIn)}
              delta={t("bank.statOpenInHint", locale)}
            />
            <Stat
              label={t("bank.statOpenOut", locale)}
              value={rands(openOut)}
              delta={t("bank.statOpenOutHint", locale)}
            />
          </div>

          {last ? (
            <p className="text-sm text-sand-500">
              {t("bank.lastImport", locale)
                .replace("{what}", last.account_label || last.file_name || t("bank.aStatement", locale))
                .replace("{when}", relativeDate(last.imported_at, locale))
                .replace("{added}", String(last.rows_added))
                .replace("{seen}", String(last.rows_in_file))}
            </p>
          ) : null}

          <Card flush>
            <CardHeader className="px-4 pt-4">
              <CardTitle>{t("bank.openTitle", locale)}</CardTitle>
            </CardHeader>
            <div className="px-4 pb-2">
              {unmatched.length === 0 ? (
                <AllClear title={t("bank.allClearTitle", locale)} hint={t("bank.allClearBody", locale)} />
              ) : (
                <ul className="flex flex-col">
                  {unmatched.map((line) => (
                    <BankLineRow key={line.id} locale={locale} line={line} suggestions={viewsFor(line)} />
                  ))}
                </ul>
              )}
            </div>
          </Card>

          {aside.length > 0 ? (
            <Card flush>
              <CardHeader className="px-4 pt-4">
                <CardTitle>{t("bank.asideTitle", locale)}</CardTitle>
              </CardHeader>
              <div className="px-4 pb-2">
                <ul className="flex flex-col">
                  {aside.map((line) => (
                    <BankLineRow key={line.id} locale={locale} line={line} suggestions={[]} />
                  ))}
                </ul>
              </div>
            </Card>
          ) : null}

          {matched.length > 0 ? (
            <Card flush>
              <CardHeader className="px-4 pt-4">
                <CardTitle>{t("bank.doneTitle", locale)}</CardTitle>
              </CardHeader>
              <div className="px-4 pb-2">
                <ul className="flex flex-col">
                  {matched.map((line) => (
                    <BankLineRow
                      key={line.id}
                      locale={locale}
                      line={line}
                      suggestions={[]}
                      matchedLabel={
                        (line.matched_document_id ? docLabel.get(line.matched_document_id) : null) ??
                        (line.matched_expense_id ? expLabel.get(line.matched_expense_id) : null) ??
                        null
                      }
                    />
                  ))}
                </ul>
              </div>
            </Card>
          ) : null}
        </>
      )}
    </div>
  );
}
