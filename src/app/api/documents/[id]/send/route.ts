import { NextResponse } from "next/server";
import { requireApiRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { loadDocument } from "@/lib/document-load";
import { buildDocumentPdf, documentFilename, documentLabel } from "@/lib/pdf/partner-document";
import { BARE_ADDRESS, sendEmail, emailConfigured, fromAddress } from "@/lib/email/resend";
import { documentEmailHtml, documentEmailText, documentSubject } from "@/lib/email/document-email";
import { balanceDueCents } from "@/lib/partner-docs";
import { publicDocumentUrl } from "@/lib/public-url";
import { sameOrigin } from "@/lib/security/same-origin";
import { claimRequest, emailKey } from "@/lib/request-claim";
import { readRequestId } from "@/lib/request-id";

export const dynamic = "force-dynamic";

/**
 * Email a document to the customer, with the PDF attached (G2).
 *
 * Before this, "send" set a status and wrote an in-app alert, the customer had to log
 * into FleetWise to discover they had been invoiced. Now they get it where they read
 * their post, with a link that opens the document without an account.
 *
 * == WHY THE ATTEMPT IS LOGGED EVEN WHEN IT FAILS =============================
 *
 * The question a partner asks the day after sending an invoice is "did it go, and
 * where". Without a record the only answer is a provider dashboard they have no login
 * for. So every attempt writes a `document_emails` row, and a failure writes one too
 * with the provider's message on it, a bounce is the most useful thing on that table
 * and the easiest to lose.
 *
 * The document is read through the RLS client (so a partner cannot email another
 * partner's invoice), and the log row is written with the service client because
 * `document_emails` grants no insert to a user, the record of what we sent is ours to
 * write, not something a caller can fabricate.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!sameOrigin(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { profile, denied } = await requireApiRole(["workshop", "owner", "manager"]);
  if (denied) return denied;
  const { id } = await params;

  const supabase = await createClient();
  const loaded = await loadDocument(supabase, { id });
  if (!loaded) return NextResponse.json({ error: "not-found" }, { status: 404 });

  const { doc } = loaded;
  if (doc.status === "draft") {
    return NextResponse.json({ error: "not-issued" }, { status: 400 });
  }

  const body = (await request.json().catch(() => ({}))) as { to?: string; cc?: string; message?: string; requestId?: string };
  const to = (body.to || doc.bill_to_email || "").trim();
  if (!to || !BARE_ADDRESS.test(to)) {
    return NextResponse.json({ error: "no-address" }, { status: 400 });
  }
  // The copy line gets the same check: one bare address, never a list.
  const cc = (body.cc ?? "").trim() || null;
  if (cc && !BARE_ADDRESS.test(cc)) {
    return NextResponse.json({ error: "bad-cc" }, { status: 400 });
  }

  // One send per request: a retry whose first answer was lost gets that answer back
  // instead of a second email to the customer (request_claims).
  const requestId = readRequestId(body.requestId);
  const claim = await claimRequest(supabase, requestId, `documents:send:${id}`);
  if (claim.state === "done") {
    return new Response(claim.outcome, { headers: { "content-type": "application/json" } });
  }
  if (claim.state === "running") return NextResponse.json({ error: "still-sending" }, { status: 409 });

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
        scope: { workshopId: doc.workshop_id },
        to,
        cc,
        from: fromAddress(brand.name),
        // A reply goes to the partner, not to us, they are the ones doing business here.
        replyTo: brand.email ?? null,
        subject,
        html: documentEmailHtml(emailInput),
        text: documentEmailText(emailInput),
        attachments: [{ filename: documentFilename(doc), content: bytes }],
        idempotencyKey: emailKey(requestId, [id, to, cc, subject, emailInput.message]),
      })
    : ({ ok: false, error: "email-not-configured", provider: "none" } as const);

  const service = createServiceClient();
  await service.from("document_emails").insert({
    document_id: doc.id,
    workshop_id: doc.workshop_id,
    farm_id: doc.farm_id,
    to_email: to,
    cc_email: cc,
    subject,
    status: result.ok ? "sent" : "failed",
    provider: result.provider,
    provider_id: result.ok ? result.id : null,
    error: result.ok ? null : result.error,
    sent_by: profile.id,
  });

  if (!result.ok) {
    // A refusal is the request's fault (an address a test workshop may not email), not ours.
    const status = "refused" in result && result.refused ? 400 : 502;
    // A code, never the provider's own words: the screen says what it means in the
    // person's language, and the detail is in document_emails.error above.
    await claim.release();
    return NextResponse.json({ error: status === 400 ? "refused" : "send-failed", label: documentLabel(doc.kind) }, { status });
  }
  const answer = { ok: true, to };
  await claim.finish(JSON.stringify(answer));
  return NextResponse.json(answer);
}
