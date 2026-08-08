import { getProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { pdfResponse } from "@/lib/pdf/doc";
import { loadDocument } from "@/lib/document-load";
import { buildDocumentPdf, documentFilename } from "@/lib/pdf/partner-document";

export const dynamic = "force-dynamic";

/**
 * A quote, invoice or credit note as a PDF, on the PARTNER's letterhead (F14f).
 *
 * The document is fetched through the RLS-bound client, so this route needs no access
 * check of its own: `app.partner_doc_visible` (0381/0410) already decides who may read
 * the row, which means a partner cannot pull another partner's invoice by guessing an
 * id, and a farm cannot pull another farm's.
 *
 * The rendering itself lives in `lib/pdf/partner-document` so this route, the emailed
 * attachment and the customer's public link all produce the same bytes.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const profile = await getProfile();
  if (!profile || !profile.active) return new Response("Forbidden", { status: 403 });

  const { id } = await params;
  const supabase = await createClient();

  const loaded = await loadDocument(supabase, { id });
  if (!loaded) return new Response("Not found", { status: 404 });

  const { bytes } = await buildDocumentPdf(loaded);
  return pdfResponse(bytes, documentFilename(loaded.doc));
}
