import "server-only";
import { createClient } from "@/lib/supabase/server";
import { must } from "@/lib/supabase/must";

export async function memberQr(
  token: string,
): Promise<{ id: string; farm_id: string; name: string } | null> {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      token,
    )
  )
    return null;
  const db = await createClient();
  const { data: auth } = await db.auth.getUser();
  if (!auth.user) return null;
  // Thrown as before, now with the database's code in the report.
  const data = must(await db.rpc("resolve_member_qr", { p_token: token }), "member-qr:resolve");
  return data?.[0] ?? null;
}
