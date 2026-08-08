import "server-only";

import { rands } from "@/lib/money";
import type { Branding } from "@/lib/branding";
import { onBrand } from "@/lib/branding";
import type { DocKind } from "@/lib/partner-docs";

/**
 * The email a customer receives when a partner sends them a document.
 *
 * Two constraints shape it. It goes out under the PARTNER's identity — their business
 * name, their colour, their reply address — because the customer is doing business with
 * them, not with us. And it has to survive the mail clients a South African farm actually
 * reads on: tables and inline styles, no flexbox, no external stylesheet, no web font, no
 * remote image. A plain-text alternative is always sent alongside, because some of these
 * addresses are on mail systems that will only show that.
 */

export type DocumentEmailInput = {
  kind: DocKind;
  number: string;
  brand: Branding;
  customerName: string;
  totalCents: number;
  dueDate: string | null;
  /** Balance still owed on an invoice, when it differs from the total. */
  outstandingCents?: number | null;
  publicUrl: string;
  message?: string | null;
  vehicle?: string | null;
};

const LABEL: Record<DocKind, string> = {
  quote: "Quote",
  invoice: "Invoice",
  credit_note: "Credit note",
};

function esc(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function documentSubject(input: Pick<DocumentEmailInput, "kind" | "number" | "brand">): string {
  return `${LABEL[input.kind]} ${input.number} from ${input.brand.name}`;
}

export function documentEmailText(input: DocumentEmailInput): string {
  const { kind, number, brand, customerName, totalCents, dueDate, publicUrl, message, vehicle } = input;
  const owed = input.outstandingCents ?? totalCents;
  const lines = [
    `Hello ${customerName},`,
    "",
    kind === "quote"
      ? `${brand.name} has sent you a quote.`
      : kind === "credit_note"
        ? `${brand.name} has issued you a credit note.`
        : `${brand.name} has sent you an invoice.`,
    "",
    `${LABEL[kind]} number: ${number}`,
    vehicle ? `Vehicle: ${vehicle}` : null,
    `Total: ${rands(totalCents)}`,
    kind === "invoice" && owed !== totalCents ? `Still owing: ${rands(owed)}` : null,
    dueDate ? (kind === "quote" ? `Valid until: ${dueDate}` : `Due by: ${dueDate}`) : null,
    "",
    message ? `${message}\n` : null,
    kind === "quote" ? "You can read it and accept or decline it here:" : "You can read and download it here:",
    publicUrl,
    "",
    "The PDF is attached to this email as well.",
    "",
    brand.phone ? `Questions: ${brand.phone}` : null,
    `— ${brand.name}`,
  ];
  return lines.filter((l) => l !== null).join("\n");
}

export function documentEmailHtml(input: DocumentEmailInput): string {
  const { kind, number, brand, customerName, totalCents, dueDate, publicUrl, message, vehicle } = input;
  const owed = input.outstandingCents ?? totalCents;
  const accent = brand.brand_primary || "#15803d";
  const onAccent = onBrand(accent);

  const row = (label: string, value: string) => `
    <tr>
      <td style="padding:6px 0;color:#6b6356;font-size:14px;">${esc(label)}</td>
      <td style="padding:6px 0;color:#26221c;font-size:14px;font-weight:600;text-align:right;">${esc(value)}</td>
    </tr>`;

  const cta = kind === "quote" ? "View and respond" : "View the document";

  return `<!-- ${esc(number)} -->
<div style="background:#faf9f7;padding:24px 12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e9e5dd;border-radius:12px;overflow:hidden;">
    <tr>
      <td style="background:${esc(accent)};padding:20px 24px;">
        <div style="color:${onAccent};font-size:18px;font-weight:700;">${esc(brand.name)}</div>
        ${brand.vat_number ? `<div style="color:${onAccent};opacity:.85;font-size:12px;margin-top:2px;">VAT ${esc(brand.vat_number)}</div>` : ""}
      </td>
    </tr>
    <tr>
      <td style="padding:24px;">
        <p style="margin:0 0 12px;color:#26221c;font-size:15px;">Hello ${esc(customerName)},</p>
        <p style="margin:0 0 18px;color:#26221c;font-size:15px;line-height:1.55;">
          ${kind === "quote"
            ? `${esc(brand.name)} has sent you a quote.`
            : kind === "credit_note"
              ? `${esc(brand.name)} has issued you a credit note.`
              : `${esc(brand.name)} has sent you an invoice.`}
        </p>

        ${message ? `<p style="margin:0 0 18px;padding:12px 14px;background:#f4f2ee;border-radius:8px;color:#26221c;font-size:14px;line-height:1.55;">${esc(message)}</p>` : ""}

        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-top:1px solid #e9e5dd;border-bottom:1px solid #e9e5dd;margin:0 0 20px;">
          ${row(`${LABEL[kind]} number`, number)}
          ${vehicle ? row("Vehicle", vehicle) : ""}
          ${row("Total", rands(totalCents))}
          ${kind === "invoice" && owed !== totalCents ? row("Still owing", rands(owed)) : ""}
          ${dueDate ? row(kind === "quote" ? "Valid until" : "Due by", dueDate) : ""}
        </table>

        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px;">
          <tr><td style="background:${esc(accent)};border-radius:8px;">
            <a href="${esc(publicUrl)}" style="display:inline-block;padding:13px 22px;color:${onAccent};font-size:15px;font-weight:600;text-decoration:none;">${cta}</a>
          </td></tr>
        </table>

        <p style="margin:0 0 6px;color:#6b6356;font-size:13px;">The PDF is attached to this email as well.</p>
        ${brand.phone ? `<p style="margin:0;color:#6b6356;font-size:13px;">Questions? Call ${esc(brand.phone)}.</p>` : ""}
      </td>
    </tr>
    <tr>
      <td style="padding:14px 24px;background:#f4f2ee;color:#9a9083;font-size:12px;line-height:1.5;">
        ${esc(brand.footer || brand.name)}
        ${brand.show_powered_by !== false ? `<div style="margin-top:4px;">Sent with FleetWise</div>` : ""}
      </td>
    </tr>
  </table>
</div>`;
}
