import { notFound } from "next/navigation";
import { createServiceClient } from "@/lib/supabase/service";
import { loadDocument } from "@/lib/document-load";
import { brandingFrom, brandingOf, onBrand } from "@/lib/branding";
import { documentLabel } from "@/lib/pdf/partner-document";
import { rands } from "@/lib/money";
import { vatPercent, shortDate } from "@/lib/format";
import { balanceDueCents } from "@/lib/partner-docs";
import { t } from "@/lib/i18n";
import { deviceLocale } from "@/lib/locale";
import { DeviceLanguageSwitcher } from "@/components/ui/device-language-switcher";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { SubmitButton } from "@/components/ui/submit-button";
import { Flash } from "@/components/ui/flash";
import { CheckIcon, DownloadIcon } from "@/components/ui/icons";
import { acceptFromLink, declineFromLink, notifyPaidFromLink } from "./actions";
import { buildCheckout } from "@/lib/payments";
import { publicDocumentUrl, siteUrl } from "@/lib/public-url";

export const dynamic = "force-dynamic";

/**
 * The document as the customer sees it, from a link in an email — no account, no app.
 *
 * Zero anon database access, exactly like the public QR page: the token is resolved by a
 * SERVICE-role read on the server, and the browser never speaks to Postgres. The token is
 * the only credential and it grants exactly this one document.
 *
 * The page leads with the decision, because that is why they opened the link. Everything
 * else — the items, the totals, how to pay — is underneath it, and the PDF is one tap away
 * for the person who wants to file it.
 */
export default async function PublicDocumentPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { token } = await params;
  const sp = await searchParams;
  const locale = await deviceLocale();

  const svc = createServiceClient();
  const loaded = await loadDocument(svc, { token });
  if (!loaded) notFound();

  const { doc, lines, machine, corrects } = loaded;
  // A draft was never sent; a link to one should not resolve, even with the right token.
  if (doc.status === "draft") notFound();

  // Record that they looked. A partner asking "have they even seen it?" is asking about
  // this timestamp, and it is the cheapest possible answer.
  if (!doc.viewed_at) {
    await svc.from("partner_documents").update({ viewed_at: new Date().toISOString() }).eq("id", doc.id);
  }

  const brand = brandingOf(doc.issuer_snapshot as never, brandingFrom(loaded.workshop as never));
  const accent = brand.brand_primary || "#15803d";
  const ink = onBrand(accent);
  const label = documentLabel(doc.kind);
  const isQuote = doc.kind === "quote";
  const isInvoice = doc.kind === "invoice";
  const isCredit = doc.kind === "credit_note";
  const isDebit = doc.kind === "debit_note";
  const charging = doc.vat_rate_bps > 0;
  const owed = balanceDueCents(doc);

  // A "pay now" form, when the partner has a provider configured. Built server-side
  // because the signature must never be computed in the browser: the merchant key would
  // have to go with it.
  const checkout = doc.kind === "invoice" && owed > 0
    ? buildCheckout({
        paymentId: doc.id,
        amountCents: owed,
        itemName: `${brand.name} ${doc.number}`,
        buyerEmail: doc.bill_to_email,
        returnUrl: publicDocumentUrl(token) + "?paid=1",
        cancelUrl: publicDocumentUrl(token),
        notifyUrl: `${siteUrl()}/api/payments/notify`,
      })
    : null;
  const open = isQuote && doc.status === "sent";
  const voided = doc.status === "void";

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col gap-4 p-4 pb-16">
      {/* The partner's letterhead — the customer is doing business with them, not with us. */}
      <header className="rounded-xl px-5 py-4" style={{ background: accent, color: ink }}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-lg font-bold">{brand.name}</p>
            {brand.vat_number ? <p className="text-sm opacity-85">{t("pubDoc.vatNo", locale)} {brand.vat_number}</p> : null}
          </div>
          <DeviceLanguageSwitcher current={locale} label={t("ui.language", locale)} />
        </div>
      </header>

      <Flash tone="success" message={sp.accepted ? t("pubDoc.acceptedFlash", locale) : undefined} />
      <Flash tone="info" message={sp.declined ? t("pubDoc.declinedFlash", locale) : undefined} />
      <Flash tone="success" message={sp.told ? t("pubDoc.toldFlash", locale) : undefined} />
      {/* PayFast sends the customer back here. The notification that actually records the
          money arrives separately and may land a moment later, so this thanks them
          without claiming the balance has already moved. */}
      <Flash tone="success" message={sp.paid ? t("pubDoc.paidFlash", locale) : undefined} />
      <Flash tone="warning" message={sp.error === "closed" ? t("pubDoc.closedFlash", locale) : undefined} />
      <Flash tone="warning" message={sp.error === "name" ? t("pubDoc.nameFlash", locale) : undefined} />

      <Flash
        tone="warning"
        message={
          voided
            ? `${t("pubDoc.voided", locale).replace("{label}", label.toLowerCase())}${doc.void_reason ? ` ${doc.void_reason}` : ""}`
            : undefined
        }
      />

      <section className="rounded-xl border border-sand-200 bg-white p-5">
        <p className="text-sm text-sand-500">{t("pubDoc.for", locale)}</p>
        <h1 className="text-2xl font-bold tracking-tight text-sand-900">
          {label} {doc.number}
        </h1>
        <p className="mt-1 text-sand-700">{doc.bill_to_name}</p>
        {machine ? (
          <p className="text-sm text-sand-500">
            {machine.name}
            {machine.reg_no ? ` · ${machine.reg_no}` : ""}
          </p>
        ) : null}
        {doc.subject ? <p className="mt-2 text-sand-700">{doc.subject}</p> : null}

        <div className="mt-4 flex flex-wrap items-end justify-between gap-3 border-t border-sand-100 pt-4">
          <div>
            <p className="text-sm text-sand-500">
              {isCredit ? t("pubDoc.totalCredited", locale) : isDebit ? t("pubDoc.extraDue", locale) : isInvoice && owed !== doc.total_cents ? t("pubDoc.stillOwing", locale) : t("pubDoc.total", locale)}
            </p>
            <p className="text-3xl font-bold tabular-nums text-sand-900">
              {rands(isInvoice ? owed : doc.total_cents)}
            </p>
          </div>
          {doc.due_date && !isCredit ? (
            <p className="text-sm text-sand-600">
              {isQuote ? t("pubDoc.validUntil", locale) : t("pubDoc.dueBy", locale)}{" "}
              <span className="font-medium text-sand-900">{shortDate(doc.due_date, locale)}</span>
            </p>
          ) : null}
        </div>
      </section>

      {/* The decision, first — it is why they opened the link. */}
      {open && !voided ? (
        <section className="rounded-xl border border-sand-200 bg-white p-5">
          <h2 className="text-lg font-semibold text-sand-900">{t("pubDoc.decide", locale)}</h2>
          <p className="mt-1 text-sm text-sand-600">{t("pubDoc.decideHint", locale)}</p>

          <form action={acceptFromLink} className="mt-4 flex flex-col gap-3">
            <input type="hidden" name="token" value={token} />
            <Field label={t("pubDoc.yourName", locale)} hint={t("pubDoc.yourNameHint", locale)} htmlFor="accepted_by">
              <Input id="accepted_by" name="accepted_by" required minLength={2} autoComplete="name" />
            </Field>
            <SubmitButton className="self-start">
              <CheckIcon className="text-[1.1rem]" /> {t("pubDoc.accept", locale)}
            </SubmitButton>
          </form>

          <details className="mt-4 border-t border-sand-100 pt-3">
            <summary className="cursor-pointer text-sm font-medium text-sand-700">{t("pubDoc.ratherNot", locale)}</summary>
            <form action={declineFromLink} className="mt-3 flex flex-col gap-3">
              <input type="hidden" name="token" value={token} />
              <Field label={t("pubDoc.declineReason", locale)} htmlFor="reason">
                <Textarea id="reason" name="reason" rows={2} />
              </Field>
              <SubmitButton variant="secondary" className="self-start">{t("pubDoc.decline", locale)}</SubmitButton>
            </form>
          </details>
        </section>
      ) : null}

      {isInvoice && !voided && owed > 0 ? (
        <section className="rounded-xl border border-sand-200 bg-white p-5">
          <h2 className="text-lg font-semibold text-sand-900">{t("pubDoc.howToPay", locale)}</h2>

          {/* Pay it now, if the partner has online payment switched on. First, because a
              customer who is already looking at the bill is the most likely they will
              ever be to pay it — the bank details below are for everyone else. */}
          {checkout ? (
            <form action={checkout.action} method="post" className="mt-3">
              {checkout.fields.map(([k, v]) => (
                <input key={k} type="hidden" name={k} value={v} />
              ))}
              <SubmitButton>{t("pubDoc.payNow", locale).replace("{amount}", rands(owed))}</SubmitButton>
              <p className="mt-1.5 text-xs text-sand-500">{t("pubDoc.payNowHint", locale)}</p>
            </form>
          ) : null}

          {brand.bank_name ? (
            <dl className="mt-3 grid grid-cols-[auto,1fr] gap-x-4 gap-y-1.5 text-sm">
              <dt className="text-sand-500">{t("pubDoc.accountName", locale)}</dt>
              <dd className="font-medium text-sand-900">{brand.bank_account_name ?? brand.name}</dd>
              <dt className="text-sand-500">{t("pubDoc.bank", locale)}</dt>
              <dd className="font-medium text-sand-900">{brand.bank_name}</dd>
              {brand.bank_account_number ? (
                <>
                  <dt className="text-sand-500">{t("pubDoc.accountNo", locale)}</dt>
                  <dd className="font-medium tabular-nums text-sand-900">{brand.bank_account_number}</dd>
                </>
              ) : null}
              {brand.bank_branch_code ? (
                <>
                  <dt className="text-sand-500">{t("pubDoc.branchCode", locale)}</dt>
                  <dd className="font-medium tabular-nums text-sand-900">{brand.bank_branch_code}</dd>
                </>
              ) : null}
              <dt className="text-sand-500">{t("pubDoc.reference", locale)}</dt>
              <dd className="font-medium text-sand-900">{doc.number}</dd>
            </dl>
          ) : (
            <p className="mt-2 text-sm text-sand-600">{t("pubDoc.askThem", locale)}</p>
          )}

          <form action={notifyPaidFromLink} className="mt-4 flex flex-col gap-3 border-t border-sand-100 pt-4">
            <input type="hidden" name="token" value={token} />
            <Field label={t("pubDoc.paidRef", locale)} hint={t("pubDoc.paidRefHint", locale)} htmlFor="reference">
              <Input id="reference" name="reference" />
            </Field>
            <SubmitButton variant="secondary" className="self-start">{t("pubDoc.tellThem", locale)}</SubmitButton>
          </form>
        </section>
      ) : null}

      {/* What it is for. */}
      {lines.length > 0 ? (
        <section className="rounded-xl border border-sand-200 bg-white p-5">
          <h2 className="text-lg font-semibold text-sand-900">{t("pubDoc.items", locale)}</h2>
          <ul className="mt-3 flex flex-col divide-y divide-sand-100">
            {lines.map((l, i) => (
              <li key={i} className="flex items-start justify-between gap-4 py-2.5">
                <div className="min-w-0">
                  <p className="text-sand-900">{l.description}</p>
                  <p className="text-sm text-sand-500">
                    {l.part_no ? `${l.part_no} · ` : ""}
                    {l.qty} × {rands(l.unit_price_cents)}
                  </p>
                </div>
                <p className="shrink-0 font-medium tabular-nums text-sand-900">{rands(l.line_total_cents)}</p>
              </li>
            ))}
          </ul>

          <dl className="mt-3 grid grid-cols-[1fr,auto] gap-y-1.5 border-t border-sand-100 pt-3 text-sm">
            <dt className="text-sand-600">{charging ? t("pubDoc.subtotalEx", locale) : t("pubDoc.subtotal", locale)}</dt>
            <dd className="text-right tabular-nums text-sand-900">{rands(doc.subtotal_cents)}</dd>
            {doc.discount_cents > 0 ? (
              <>
                <dt className="text-sand-600">{t("pubDoc.discount", locale)}</dt>
                <dd className="text-right tabular-nums text-sand-900">−{rands(doc.discount_cents)}</dd>
              </>
            ) : null}
            {charging ? (
              <>
                <dt className="text-sand-600">{t("pubDoc.vat", locale).replace("{pct}", vatPercent(doc.vat_rate_bps))}</dt>
                <dd className="text-right tabular-nums text-sand-900">{rands(doc.vat_cents)}</dd>
              </>
            ) : null}
            <dt className="pt-1 font-semibold text-sand-900">{t("pubDoc.total", locale)}</dt>
            <dd className="pt-1 text-right font-semibold tabular-nums text-sand-900">{rands(doc.total_cents)}</dd>
            {doc.amount_paid_cents > 0 ? (
              <>
                <dt className="text-sand-600">{t("pubDoc.paidSoFar", locale)}</dt>
                <dd className="text-right tabular-nums text-sand-900">−{rands(doc.amount_paid_cents)}</dd>
              </>
            ) : null}
          </dl>
        </section>
      ) : null}

      {isCredit && corrects ? (
        <section className="rounded-xl border border-sand-200 bg-white p-5">
          <h2 className="text-lg font-semibold text-sand-900">{t("pubDoc.whatThisMeans", locale)}</h2>
          <p className="mt-1 text-sand-700">
            {t("pubDoc.creditExplains", locale)
              .replace("{number}", corrects.number)
              .replace("{amount}", rands(doc.total_cents))}
          </p>
        </section>
      ) : null}

      {doc.notes || doc.terms ? (
        <section className="rounded-xl border border-sand-200 bg-white p-5 text-sm text-sand-700">
          {doc.notes ? <p className="whitespace-pre-line">{doc.notes}</p> : null}
          {doc.terms ? <p className="mt-3 whitespace-pre-line text-sand-500">{doc.terms}</p> : null}
        </section>
      ) : null}

      <a
        href={`/d/${token}/pdf`}
        className="focus-ring flex min-h-12 items-center justify-center gap-2 rounded-lg border border-sand-300 bg-white px-4 font-medium text-sand-800 hover:bg-sand-50"
      >
        <DownloadIcon className="text-[1.15rem]" /> {t("pubDoc.download", locale)}
      </a>

      <footer className="pt-2 text-center text-sm text-sand-500">
        {brand.phone ? <p>{t("pubDoc.questions", locale)} {brand.phone}</p> : null}
        <p className="mt-1">{brand.footer ?? brand.name}</p>
      </footer>
    </main>
  );
}
