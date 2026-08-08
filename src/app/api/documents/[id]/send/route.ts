import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { loadDocument } from "@/lib/document-load";
import { buildDocumentPdf, documentFilename, documentLabel } from "@/lib/pdf/partner-document";
import { sendEmail, emailConfigured, fromAddress } from "@/lib/email/resend";
import { documentEmailHtml, documentEmailText, documentSubject } from "@/lib/email/document-email";
import { balanceDueCents } from "@/lib/partner-docs";
import { publicDocumentUrl } from "@/lib/public-url";

export const dynamic = "force-dynamic";

/**
 * Email a document to the customer, with the PDF attached (G2).
 *
 * Before this, "send" set a status and wrote an in-app alert — the customer had to log
 * into FleetWise to discover they had been invoiced. Now they get it where they read
 * their post, with a link that opens the document without an account.
 *
 * ── WHY THE ATTEMPT IS LOGGED EVEN WHEN IT FAILS ─────────────────────────────
 *
 * The question a partner asks the day after sending an invoice is "did it go, and
 * where". Without a record the only answer is a provider dashboard they have no login
 * for. So every attempt writes a `document_emails` row, and a failure writes one too
 * with the provider's message on it — a bounce is the most useful thing on that table
 * and the easiest to lose.
 *
 * The document is read through the RLS client (so a partner cannot email another
 * partner's invoice), and the log row is written with the service client because
 * `document_emails` grants no insert to a user — the record of what we sent is ours to
 * write, not something a caller can fabricate.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const profile = await requireRole(["workshop", "owner", "manager"]);
  const { id } = await params;

  const supabase = await createClient();
  const loaded = await loadDocument(supabase, { id });
  if (!loaded) return NextResponse.json({ error: "not-found" }, { status: 404 });

  const { doc } = loaded;
  if (doc.status === "draft") {
    return NextResponse.json({ error: "not-issued" }, { status: 400 });
  }

  const body = (await request.json().catch(() => ({}))) as { to?: string; cc?: string; message?: string };
  const to = (body.to || doc.bill_to_email || "").trim();
  if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
    return NextResponse.json({ error: "no-address" }, { status: 400 });
  }

  const { bytes, brand } = await buildDocumentPdf(loaded);
  const publicUrl = publicDocumentUrl(doc.public_token);

  const subject = documentSubject({ kind: doc.kind, number: doc.number, brand });
  const emailInput = {
    kind: doc.kind,
    number: doc.number,
    brand,
    customerName: doc.bill_to_name ?? "there",
    totalCents: doc.total_cents,
    dueDate: doc.due_date,
    outstandingCents: doc.kind === "invoice" ? balanceDueCents(doc) : null,
    publicUrl,
    message: body.message?.trim() || null,
    vehicle: loaded.machine ? [loaded.machine.name, loaded.machine.reg_no].filter(Boolean).join(" · ") : null,
  };

  const result = emailConfigured()
    ? await sendEmail({
        to,
        cc: body.cc?.trim() || null,
        from: fromAddress(brand.name),
        // A reply goes to the partner, not to us — they are the ones doing business here.
        replyTo: brand.email ?? null,
        subject,
        html: documentEmailHtml(emailInput),
        text: documentEmailText(emailInput),
        attachments: [{ filename: documentFilename(doc), content: bytes }],
      })
    : ({ ok: false, error: "email-not-configured", provider: "none" } as const);

  const service = createServiceClient();
  await service.from("document_emails").insert({
    document_id: doc.id,
    workshop_id: doc.workshop_id,
    farm_id: doc.farm_id,
    to_email: to,
    cc_email: body.cc?.trim() || null,
    subject,
    status: result.ok ? "sent" : "failed",
    provider: result.provider,
    provider_id: result.ok ? result.id : null,
    error: result.ok ? null : result.error,
    sent_by: profile.id,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error, label: documentLabel(doc.kind) }, { status: 502 });
  }
  return NextResponse.json({ ok: true, to });
}
