"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

import { BARE_ADDRESS } from "@/lib/email/resend";
import { sendContractorSignIn } from "@/lib/email/partner-access";
import { deviceLocale } from "@/lib/locale";
import { captureError } from "@/lib/observability";
import {
  INVITE_CODE_LENGTH,
  INVITE_TOKEN,
  JOIN_SENT_COOKIE,
  cleanInviteCode,
  connectContractor,
  hashInviteCode,
  hashInviteToken,
} from "@/lib/partner-invites";
import { createServiceClient } from "@/lib/supabase/service";

function bounce(token: string, query: string): never {
  redirect(`/join/${token}?${query}`);
}

type Redeemed = {
  outcome: string;
  attempts_left: number | null;
  invite_id: string | null;
  invite_farm: string | null;
  invite_partner: string | null;
};

/**
 * Claim a link: the code and an address, posted from the page.
 *
 * This is the only thing that spends a link. The page itself only reads, because WhatsApp and
 * mail scanners open every link in a message. Who wins is decided inside the database under
 * a row lock; nothing here can let a second person through. Holding a right answer here gets
 * nobody into anything either: the next step is a sign-in email to the address given.
 */
export async function claimInvite(formData: FormData): Promise<void> {
  const token = String(formData.get("token") ?? "");
  if (!INVITE_TOKEN.test(token)) redirect("/login");

  const code = cleanInviteCode(String(formData.get("code") ?? ""));
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const name = String(formData.get("name") ?? "").trim().slice(0, 120);
  if (code.length !== INVITE_CODE_LENGTH) bounce(token, "error=join-code");
  if (email.length > 200 || !BARE_ADDRESS.test(email)) bounce(token, "error=join-email");

  const svc = createServiceClient();

  // A cost multiplier, not a boundary, as on /signup: what stops a guessed code is the five
  // tries on the link itself. Fails open, because turning a contractor away is the worse way
  // round. The key is prefixed so these do not spend somebody's sign-up allowance.
  const forwarded = (await headers()).get("x-forwarded-for") ?? "";
  const source = forwarded.split(",")[0]?.trim() || "unknown";
  const { data: slot, error: slotError } = await svc.rpc("billing_take_signup_slot", {
    p_source: `join:${source}`,
    p_limit: 20,
  });
  if (!slotError && slot === false) bounce(token, "error=join-busy");

  const { data, error } = await svc.rpc("partner_invite_redeem", {
    p_token_hash: hashInviteToken(token),
    p_code_hash: hashInviteCode(token, code),
    p_email: email,
  });
  if (error) {
    captureError(error, { where: "join:redeem" });
    bounce(token, "error=join-failed");
  }
  const row = ((data as Redeemed[] | null) ?? [])[0];

  switch (row?.outcome) {
    case "ok":
    case "again":
      break;
    case "wrong-code":
      bounce(token, `wrong=${row.attempts_left ?? 0}`);
    case "email-taken":
      bounce(token, "error=join-email-taken");
    case "bad-email":
      bounce(token, "error=join-email");
    case "used":
      bounce(token, "error=join-used");
    default:
      // Locked, expired, cancelled or unknown: the page says which, from the link's own state.
      redirect(`/join/${token}`);
  }

  const farmId = row.invite_farm as string;
  const connected = await connectContractor(svc, {
    inviteId: row.invite_id as string,
    farmId,
    partnerId: row.invite_partner as string,
    email,
    personName: name,
    firstClaim: row.outcome === "ok",
  });
  // The link is theirs now, so a retry arrives as `again` and finishes the job.
  if (!connected.ok) {
    captureError(new Error(`join: could not connect (${connected.reason})`), { where: "join:connect" });
    bounce(token, connected.reason === "email-taken" ? "error=join-email-taken" : "error=join-failed");
  }

  const { data: farm, error: farmError } = await svc.from("farms").select("name").eq("id", farmId).maybeSingle();
  if (farmError) captureError(farmError, { where: "join:farm-name" });

  const mail = await sendContractorSignIn({
    email,
    name,
    farmId,
    farmName: (farm as { name?: string } | null)?.name ?? "",
    tokenHash: connected.tokenHash,
    locale: await deviceLocale(),
  });
  if (!mail.ok) {
    captureError(new Error(`join: sign-in email not sent (${mail.reason})`), { where: "join:mail" });
    bounce(token, "error=join-mail-failed");
  }

  // Only the person who posted this sees the address again; a query string would show it to
  // anyone the link reaches next.
  (await cookies()).set(JOIN_SENT_COOKIE, email, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: `/join/${token}`,
    maxAge: 900,
  });
  redirect(`/join/${token}?sent=1`);
}
