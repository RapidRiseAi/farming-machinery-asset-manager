import { getProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

/**
 * POPIA Data-Subject Access Request: download everything we hold on a person as
 * JSON. Guarded server-side by the `export_personal_data` RPC (owner/manager of the
 * subject's farm, or rr_admin cross-tenant — logged). RLS never lets anon here; a
 * non-owner/manager caller trips the RPC's guard → 403.
 */
export async function GET(request: Request) {
  const profile = await getProfile();
  if (!profile || !profile.active) return new Response("Unauthorized", { status: 401 });

  const userId = new URL(request.url).searchParams.get("user")?.trim() ?? "";
  if (!userId) return new Response("Missing user", { status: 400 });

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("export_personal_data", { p_user: userId });
  if (error) return new Response(error.message, { status: 403 });

  const body = JSON.stringify(data ?? {}, null, 2);
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="personal-data-${userId}.json"`,
      "Cache-Control": "no-store",
    },
  });
}
