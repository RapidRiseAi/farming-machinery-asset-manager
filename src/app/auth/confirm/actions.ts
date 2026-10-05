"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { CURRENT_FARM_COOKIE } from "@/lib/auth";
import { syncLocaleOnSignIn } from "@/lib/locale-sync";

/** GoTrue's hashed token is hex; anything else never reaches the auth server. */
const TOKEN_HASH = /^[A-Za-z0-9_-]{16,256}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The button on /auth/confirm: verify the emailed token and start the session.
 *
 * `type: "email"` finds the token whether GoTrue filed it as a magic link or as a sign-up
 * confirmation, so this does not depend on which one the admin API chose to mint. A
 * failure of any kind is the same "that link has expired or was used" the sign-in page
 * already explains, with the form to ask for a new one right under it.
 */
export async function confirmSignIn(formData: FormData) {
  const tokenHash = String(formData.get("token_hash") ?? "");
  const farm = String(formData.get("farm") ?? "");
  if (!TOKEN_HASH.test(tokenHash)) redirect("/login?error=auth");

  const supabase = await createClient();
  const { data, error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: "email" });
  if (error || !data.session) redirect("/login?error=auth");

  // The same reconciliation the other two ways of signing in run.
  await syncLocaleOnSignIn();

  // Open on the farm that sent the invite. Read back through RLS with the new session, so
  // a farm id edited into the link opens nothing that person could not already reach.
  if (UUID.test(farm)) {
    const { data: row } = await supabase
      .from("farms")
      .select("id")
      .eq("id", farm)
      .is("deleted_at", null)
      .maybeSingle();
    if (row) {
      (await cookies()).set(CURRENT_FARM_COOKIE, farm, {
        path: "/",
        httpOnly: true,
        sameSite: "lax",
        maxAge: 60 * 60 * 24 * 365,
      });
    }
  }

  redirect("/home");
}
