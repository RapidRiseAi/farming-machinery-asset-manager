import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { soft } from "@/lib/supabase/must";
import { sendInviteEmail } from "@/lib/email/invite";
import { APP_NAME } from "@/lib/env";
import { errorCode } from "@/lib/action-errors";

/**
 * Rapid Rise inviting somebody onto a client's farm, an owner included: the shared core of
 * the client page's Invite button and of setting up a quoted customer (20261105100000).
 *
 * `team_invite_existing` decides (and checks the staff member's id again in the
 * database); a new address gets a login from the admin API first; then the sign-in email
 * goes out. Returns a code rather than redirecting, so each caller says it in its own place.
 */

export const INVITE_ROLES = ["owner", "manager", "mechanic", "operator"] as const;

type InviteDecision = {
  outcome: "none" | "created" | "already" | "switched_off" | "added" | "moved" | "refused";
  user_id?: string;
  name?: string;
  language?: string;
};

export type InviteResult =
  | { ok: true; outcome: InviteDecision["outcome"]; emailSent: boolean }
  | { ok: false; code: string };

function alreadyRegistered(error: { code?: string; message?: string }): boolean {
  return error.code === "email_exists" || /already (been )?registered|already exists/i.test(error.message ?? "");
}

export async function inviteToFarm(
  svc: SupabaseClient,
  input: { adminId: string; farmId: string; email: string; name: string; role: string; language: "en" | "af" },
): Promise<InviteResult> {
  const { adminId, farmId, email, name, role, language } = input;
  if (!(INVITE_ROLES as readonly string[]).includes(role)) return { ok: false, code: "admin-invite-role" };
  if (!email || !name) return { ok: false, code: "admin-invite-fields" };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, code: "need-email" };

  const decide = async (): Promise<InviteDecision | { error: string }> => {
    const { data, error } = await svc.rpc("team_invite_existing", {
      p_farm: farmId,
      p_actor: adminId,
      p_email: email,
      p_role: role,
      p_name: name,
      p_language: language,
    });
    if (error) {
      const fence = /never mix|cannot join a (real|test) (farm|workshop)/i.test(error.message ?? "");
      return { error: fence ? "invite-refused" : error.code === "42501" ? "forbidden" : errorCode(error, "admin:invite", "invite-failed") };
    }
    return data as InviteDecision;
  };

  let decision = await decide();
  if ("error" in decision) return { ok: false, code: decision.error };
  if (decision.outcome === "none") {
    const { error } = await svc.auth.admin.createUser({ email, email_confirm: true, user_metadata: { name } });
    if (error && !alreadyRegistered(error)) {
      return { ok: false, code: error.code === "email_address_invalid" ? "need-email" : "invite-failed" };
    }
    decision = await decide();
    if ("error" in decision) return { ok: false, code: decision.error };
  }
  if (decision.outcome === "refused") return { ok: false, code: "invite-refused" };
  if (decision.outcome === "switched_off") return { ok: false, code: "invite-switched-off" };
  if (decision.outcome === "none") return { ok: false, code: "invite-failed" };

  // On the farm from here on: the email may fail without undoing it.
  const farmRow = soft(await svc.from("farms").select("name").eq("id", farmId).maybeSingle(), "admin:invite:farm-name");
  const sent = await sendInviteEmail(svc, {
    email,
    name: decision.name ?? name,
    farmId,
    farmName: (farmRow as { name?: string } | null)?.name ?? APP_NAME,
    inviterName: null,
    locale: decision.language === "af" ? "af" : language,
  });
  if (!sent.ok) console.error(`[admin] invite email not sent: ${sent.reason}${sent.detail ? ` (${sent.detail})` : ""}`);
  return { ok: true, outcome: decision.outcome, emailSent: sent.ok };
}
