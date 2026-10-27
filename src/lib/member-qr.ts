import "server-only";
import { createClient } from "@/lib/supabase/server";
import { must, ReadFailed } from "@/lib/supabase/must";
import { authUnanswered } from "@/lib/auth-unanswered";

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
  const { data: auth, error: authError } = await db.auth.getUser();
  // Auth not answering is not "signed out": thrown, so the person is told to try again
  // rather than shown the QR page as if they were nobody (lib/auth-unanswered).
  if (authUnanswered(authError)) throw new ReadFailed("member-qr:get-user", { code: authError?.name });
  if (!auth.user) return null;
  // Thrown as before, now with the database's code in the report.
  const data = must(await db.rpc("resolve_member_qr", { p_token: token }), "member-qr:resolve");
  return data?.[0] ?? null;
}
