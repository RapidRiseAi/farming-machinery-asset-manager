import "server-only";

import { rands } from "@/lib/money";
import { onBrand } from "@/lib/branding";
import type { StatementData } from "@/lib/pdf/statement";
import { statementTotals, AGEING_BUCKETS } from "@/lib/statement";

/**
 * The email a customer gets with their monthly statement.
 *
 * It leads with the one number they need — the balance — and then the ageing, because a
 * customer who pays off a statement is deciding how much to transfer, not reading a
 * ledger. The ledger is in the attached PDF for whoever wants it.
 *
 * Same mail-client constraints as the document email: tables and inline styles, no
 * flexbox, no webfont, no remote image, and a plain-text alternative always sent.
 */

const AGE_LABEL: Record<string, string> = {
  current: "Not yet due",
  d30: "1–30 days late",
  d60: "31–60 days late",
  d90: "60+ days late",
};

function esc(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function statementSubject(data: StatementData): string {
  return `Statement from ${data.brand.name} — ${data.to}`;
}

export function statementEmailText(data: StatementData, message?: string | null): string {
  const totals = statementTotals(data.rows);
  const lines = [
    `Hello ${data.party.name},`,
    "",
    `Here is your statement from ${data.brand.name} for ${data.from} to ${data.to}.`,
    "",
    `Balance due: ${rands(totals.closingCents)}`,
    "",
    ...AGEING_BUCKETS
      .filter((b) => data.ageing[b.field] > 0)
      .map((b) => `  ${AGE_LABEL[b.key]}: ${rands(data.ageing[b.field])}`),
    "",
    message ? `${message}\n` : null,
    "The full statement is attached as a PDF.",
    "",
    data.brand.bank_name ? `Pay to: ${data.brand.bank_account_name ?? data.brand.name}, ${data.brand.bank_name}` : null,
    data.brand.bank_account_number ? `Account: ${data.brand.bank_account_number}` : null,
    "",
    data.brand.phone ? `Questions: ${data.brand.phone}` : null,
    `— ${data.brand.name}`,
  ];
  return lines.filter((l) => l !== null).join("\n");
}

export function statementEmailHtml(data: StatementData, message?: string | null): string {
  const totals = statementTotals(data.rows);
  const accent = data.brand.brand_primary || "#15803d";
  const ink = onBrand(accent);
  const overdue = AGEING_BUCKETS.filter((b) => b.key !== "current" && data.ageing[b.field] > 0);

  const row = (label: string, value: string, strong = false) => `
    <tr>
      <td style="padding:6px 0;color:#6b6356;font-size:14px;">${esc(label)}</td>
      <td style="padding:6px 0;color:#26221c;font-size:14px;${strong ? "font-weight:700;" : "font-weight:600;"}text-align:right;">${esc(value)}</td>
    </tr>`;

  return `<!-- statement ${esc(data.to)} -->
<div style="background:#faf9f7;padding:24px 12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e9e5dd;border-radius:12px;overflow:hidden;">
    <tr>
      <td style="background:${esc(accent)};padding:20px 24px;">
        <div style="color:${ink};font-size:18px;font-weight:700;">${esc(data.brand.name)}</div>
        ${data.brand.vat_number ? `<div style="color:${ink};opacity:.85;font-size:12px;margin-top:2px;">VAT ${esc(data.brand.vat_number)}</div>` : ""}
      </td>
    </tr>
    <tr>
      <td style="padding:24px;">
        <p style="margin:0 0 12px;color:#26221c;font-size:15px;">Hello ${esc(data.party.name)},</p>
        <p style="margin:0 0 18px;color:#26221c;font-size:15px;line-height:1.55;">
          Your statement for ${esc(data.from)} to ${esc(data.to)}.
        </p>

        ${message ? `<p style="margin:0 0 18px;padding:12px 14px;background:#f4f2ee;border-radius:8px;color:#26221c;font-size:14px;line-height:1.55;">${esc(message)}</p>` : ""}

        <div style="padding:16px;background:#f4f2ee;border-radius:10px;margin:0 0 18px;">
          <div style="color:#6b6356;font-size:13px;">Balance due</div>
          <div style="color:#26221c;font-size:28px;font-weight:700;">${esc(rands(totals.closingCents))}</div>
        </div>

        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-top:1px solid #e9e5dd;border-bottom:1px solid #e9e5dd;margin:0 0 18px;">
          ${row("Brought forward", rands(totals.openingCents))}
          ${row("Invoiced this period", rands(totals.invoicedCents))}
          ${totals.creditedCents > 0 ? row("Credited back", `-${rands(totals.creditedCents)}`) : ""}
          ${row("Received", `-${rands(totals.paidCents)}`)}
          ${row("Balance due", rands(totals.closingCents), true)}
        </table>

        ${overdue.length > 0 ? `
        <p style="margin:0 0 6px;color:#26221c;font-size:14px;font-weight:600;">Of that, overdue:</p>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 18px;">
          ${overdue.map((b) => row(AGE_LABEL[b.key], rands(data.ageing[b.field]))).join("")}
        </table>` : ""}

        ${data.brand.bank_name ? `
        <p style="margin:0 0 4px;color:#26221c;font-size:14px;font-weight:600;">How to pay</p>
        <p style="margin:0 0 18px;color:#6b6356;font-size:14px;line-height:1.6;">
          ${esc(data.brand.bank_account_name ?? data.brand.name)}<br/>
          ${esc(data.brand.bank_name)}${data.brand.bank_account_number ? `<br/>Account ${esc(data.brand.bank_account_number)}` : ""}${data.brand.bank_branch_code ? `<br/>Branch ${esc(data.brand.bank_branch_code)}` : ""}
        </p>` : ""}

        <p style="margin:0 0 6px;color:#6b6356;font-size:13px;">The full statement is attached as a PDF.</p>
        ${data.brand.phone ? `<p style="margin:0;color:#6b6356;font-size:13px;">Questions? Call ${esc(data.brand.phone)}.</p>` : ""}
      </td>
    </tr>
    <tr>
      <td style="padding:14px 24px;background:#f4f2ee;color:#9a9083;font-size:12px;line-height:1.5;">
        ${esc(data.brand.footer || data.brand.name)}
        ${data.brand.show_powered_by !== false ? `<div style="margin-top:4px;">Sent with FleetWise</div>` : ""}
      </td>
    </tr>
  </table>
</div>`;
}
