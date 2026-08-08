import { createServiceClient } from "@/lib/supabase/service";
import { loadDocument } from "@/lib/document-load";
import { buildDocumentPdf, documentFilename } from "@/lib/pdf/partner-document";
import { pdfResponse } from "@/lib/pdf/doc";

export const dynamic = "force-dynamic";

/**
 * The customer's copy of the PDF, from the emailed link.
 *
 * Same zero-anon-DB rule as the rest of the public surface: the unguessable token is
 * resolved by this SERVICE-role route and nothing else is reachable with it. A draft
 * 404s even with a valid token — it was never sent, so there is nothing to fetch.
 *
 * Renders through the same `buildDocumentPdf` the authenticated route uses, so the
 * customer's copy and the partner's copy are byte-for-byte the same document.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(token)) return new Response("Not found", { status: 404 });

  const svc = createServiceClient();
  const loaded = await loadDocument(svc, { token });
  if (!loaded || loaded.doc.status === "draft") return new Response("Not found", { status: 404 });

  const { bytes } = await buildDocumentPdf(loaded);
  return pdfResponse(bytes, documentFilename(loaded.doc));
}
