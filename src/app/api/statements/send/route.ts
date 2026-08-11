import { NextResponse } from "next/server";
import { requireRole, currentWorkshop } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { loadStatement, buildStatementPdf, statementFilename } from "@/lib/pdf/statement";
import { statementEmailHtml, statementEmailText, statementSubject } from "@/lib/email/statement-email";
import { sendEmail, emailConfigured, fromAddress } from "@/lib/email/resend";
import { parseStatementParty } from "@/lib/statement-party";

export const dynamic = "force-dynamic";

/**
 * Email a customer their statement, with the PDF attached.
 *
 * The last step of the monthly-account workflow, and it was missing: a customer who never
 * looks at an individual invoice could be emailed six invoices and no statement, which is
 * the opposite of what they asked for.
 *
 * The statement is loaded through the RLS-bound client, so a partner cannot pull a
 * customer they do not serve — `app.partner_statement` is SECURITY INVOKER and a guessed
 * id returns an empty statement rather than someone else's. Every attempt is logged,
 * failures included, for the same reason document sends are: a bounce nobody sees leaves
 * the partner believing the customer was told.
 */
export async function POST(request: Request) {
  const profile = await requireRole(["workshop"]);
  const { workshop } = await currentWorkshop(profile);
  if (!workshop) return NextResponse.json({ error: "no-workshop" }, { status: 403 });

  const body = (await request.json().catch(() => ({}))) as {
    party?: string; from?: string; to?: string; email?: string; message?: string;
  };
  const params = new URLSearchParams({
    party: body.party ?? "", from: body.from ?? "", to: body.to ?? "",
  });
  const party = parseStatementParty(params);
  if (!party) return NextResponse.json({ error: "bad-request" }, { status: 400 });

  const supabase = await createClient();
  const data = await loadStatement(supabase, {
    workshop, workshopId: workshop.id,
    farmId: party.farmId, clientId: party.clientId,
    from: party.from, to: party.to, lang: profile.lang,
  });

  // The customer's billing address, or one typed for this send.
  const to = (body.email || data.party.email || "").trim();
  if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
    return NextResponse.json({ error: "no-address" }, { status: 400 });
  }

  const bytes = await buildStatementPdf(data);
  const subject = statementSubject(data);

  const result = emailConfigured()
    ? await sendEmail({
        to,
        from: fromAddress(data.brand.name),
        replyTo: data.brand.email ?? null,
        subject,
        html: statementEmailHtml(data, body.message?.trim() || null),
        text: statementEmailText(data, body.message?.trim() || null),
        attachments: [{ filename: statementFilename(data.party, party.to), content: bytes }],
      })
    : ({ ok: false, error: "email-not-configured", provider: "none" } as const);

  const service = createServiceClient();
  await service.from("document_emails").insert({
    document_id: null,
    workshop_id: workshop.id,
    farm_id: party.farmId,
    partner_client_id: party.clientId,
    period_from: party.from,
    period_to: party.to,
    to_email: to,
    subject,
    status: result.ok ? "sent" : "failed",
    provider: result.provider,
    provider_id: result.ok ? result.id : null,
    error: result.ok ? null : result.error,
    sent_by: profile.id,
  });

  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 502 });
  return NextResponse.json({ ok: true, to });
}
