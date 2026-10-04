import "server-only";
import { createClient } from "@/lib/supabase/server";

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
  const { data, error } = await db.rpc("resolve_member_qr", { p_token: token });
  if (error) throw new Error("QR access unavailable");
  return data?.[0] ?? null;
}
