import { getProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/ids";
import { captureError } from "@/lib/observability";

export const dynamic = "force-dynamic";

/**
 * One finance document (a signed agreement, a lease, a policy schedule), as a download.
 *
 * Both reads go through the caller's own client: the attachment row through the
 * restrictive finance policies on `attachments`, the file through the `finance-docs`
 * bucket's policies (20261028110200). So only an owner or a manager of the document's farm
 * gets the file; anybody else gets a 404 that says nothing about whether it exists.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const profile = await getProfile();
  if (!profile || !profile.active) return new Response("Unauthorized", { status: 401 });
  const { id } = await params;
  if (!isUuid(id)) return new Response("Not found", { status: 404 });

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("attachments")
    .select("storage_path, created_at")
    .eq("id", id)
    .in("parent_type", ["finance_agreement", "asset_contract"])
    .is("deleted_at", null)
    .maybeSingle();
  if (error) {
    captureError(error, { where: "finance:document:row" });
    return new Response("Could not read the document", { status: 500 });
  }
  const path = (data as { storage_path: string | null } | null)?.storage_path;
  if (!path) return new Response("Not found", { status: 404 });

  const file = await supabase.storage.from("finance-docs").download(path);
  if (file.error || !file.data) {
    captureError(file.error ?? new Error("finance document missing"), { where: "finance:document:file" });
    return new Response("Not found", { status: 404 });
  }
  const ext = path.split(".").pop() ?? "bin";
  return new Response(file.data, {
    headers: {
      "Content-Type": file.data.type || "application/octet-stream",
      "Content-Disposition": `attachment; filename="finance-document-${id.slice(0, 8)}.${ext}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
