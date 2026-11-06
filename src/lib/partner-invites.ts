import "server-only";

import { createHash, randomBytes, randomInt } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { mintSignIn } from "@/lib/email/partner-access";
import { captureError } from "@/lib/observability";

/**
 * The link and code a farmer sends to any contractor (20261106110000).
 *
 * The farmer needs only a business name. The contractor opens the link, types the code and
 * their own email address, and a sign-in email proves the address is theirs. The rules that
 * make that safe live in the migration, under a row lock; this file makes the secrets and
 * does the connecting once the database has said yes.
 *
 * == Nothing here hands a sign-in link to anyone but its owner =================
 * The old invite minted a Supabase sign-in link for whatever address the farmer typed and
 * showed it to them, so typing a stranger's address signed the farmer in as that stranger.
 * A sign-in link now only ever goes by email to the address it opens
 * (`sign-in-links.test.ts` keeps it that way).
 */

export const INVITE_DAYS = 7;
export const INVITE_CODE_LENGTH = 6;

/** 24 random bytes in base64url. Checked before any database work, so junk costs nothing. */
export const INVITE_TOKEN = /^[A-Za-z0-9_-]{32}$/;

/** Set for the person who just claimed a link, so only they see the address it went to. */
export const JOIN_SENT_COOKIE = "fw_join_sent";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export const hashInviteToken = (token: string) => sha256(token);

/** Keyed by the token, so a row of this table alone cannot be tried against other links. */
export const hashInviteCode = (token: string, code: string) => sha256(`${token}:${code}`);

/** "123 456" and "123-456" are how people type a code from a message. */
export function cleanInviteCode(raw: string): string {
  return raw.replace(/\D/g, "").slice(0, INVITE_CODE_LENGTH);
}

export function newInviteSecrets() {
  const token = randomBytes(24).toString("base64url");
  const code = String(randomInt(0, 10 ** INVITE_CODE_LENGTH)).padStart(INVITE_CODE_LENGTH, "0");
  return { token, code, tokenHash: hashInviteToken(token), codeHash: hashInviteCode(token, code) };
}

export function inviteExpiry(now: Date = new Date()): string {
  return new Date(now.getTime() + INVITE_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

export function inviteUrl(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, "")}/join/${token}`;
}

export type ConnectResult =
  | { ok: true; tokenHash: string }
  | { ok: false; reason: "partner" | "email-taken" | "login" | "workshop" | "link" | "profile" };

/**
 * Connect the person who claimed a link. Safe to run twice: `again` finishes a run that
 * stopped halfway, which is why every step looks before it writes.
 *
 * == Whose workshop ============================================================
 * Everyone in a workshop sees all of that workshop's customers. So a login is added to an
 * existing workshop only when nobody else is in it yet: a person who already has a login
 * brings their own workshop, and a new person whose partner row points at somebody else's
 * workshop gets a workshop of their own. Otherwise a farmer could send a link to themselves
 * and read a contractor's other clients.
 *
 * == What `firstClaim` protects ================================================
 * Only the first claim sets what the contractor may see. Coming back with the same link must
 * not undo a change the farmer has made since, or reopen a link they closed.
 */
export async function connectContractor(
  svc: SupabaseClient,
  input: {
    inviteId: string;
    farmId: string;
    partnerId: string;
    email: string;
    personName: string;
    firstClaim: boolean;
  },
): Promise<ConnectResult> {
  const { inviteId, farmId, partnerId, email, firstClaim } = input;

  const { data: partner, error: partnerError } = await svc
    .from("partners")
    .select("id, farm_id, name, kind, phone, whatsapp, email, area, workshop_id")
    .eq("id", partnerId)
    .eq("farm_id", farmId)
    .is("deleted_at", null)
    .maybeSingle();
  if (partnerError) captureError(partnerError, { where: "partner-invites:partner" });
  if (!partner) return { ok: false, reason: "partner" };

  const { data: invite, error: inviteError } = await svc
    .from("partner_invites")
    .select("see_all_vehicles, see_service_history, see_costs, see_team")
    .eq("id", inviteId)
    .maybeSingle();
  if (inviteError) captureError(inviteError, { where: "partner-invites:grants" });
  if (!invite) return { ok: false, reason: "link" };

  const personName = input.personName.trim() || (partner.name as string);

  // Identity first: which workshop this is depends on who the address already belongs to.
  // createUser fails harmlessly for an address that exists; the sign-in link names them.
  const created = await svc.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: { name: personName },
  });
  const signIn = await mintSignIn(svc, email);
  const userId = created.data?.user?.id ?? signIn.userId;
  if (!userId || !signIn.tokenHash) return { ok: false, reason: "login" };

  const { data: profile, error: profileReadError } = await svc
    .from("users")
    .select("id, role, workshop_id")
    .eq("id", userId)
    .maybeSingle();
  if (profileReadError) {
    captureError(profileReadError, { where: "partner-invites:profile-read" });
    return { ok: false, reason: "profile" };
  }
  // The database refused this before the claim. Checked again because this decides whose
  // account the sign-in email opens.
  if (profile && profile.role !== "workshop") return { ok: false, reason: "email-taken" };

  let workshopId = (profile?.workshop_id as string | null | undefined) ?? null;
  if (!workshopId && partner.workshop_id) {
    const { count, error: countError } = await svc
      .from("users")
      .select("id", { count: "exact", head: true })
      .eq("workshop_id", partner.workshop_id);
    if (countError) {
      captureError(countError, { where: "partner-invites:workshop-logins" });
      return { ok: false, reason: "workshop" };
    }
    if (count === 0) workshopId = partner.workshop_id as string;
  }

  if (!workshopId) {
    // Takes the farm's test mark (20261014120000): a test farm's contractor is a test
    // workshop. A failed read would put it on the wrong side of the fence.
    const { data: farm, error: farmError } = await svc.from("farms").select("is_test").eq("id", farmId).maybeSingle();
    if (farmError || !farm) {
      if (farmError) captureError(farmError, { where: "partner-invites:test-mark" });
      return { ok: false, reason: "workshop" };
    }
    const { data: workshop, error: workshopError } = await svc
      .from("workshops")
      .insert({
        is_test: (farm as { is_test?: boolean }).is_test === true,
        name: partner.name,
        kind: partner.kind,
        phone: partner.phone,
        whatsapp: partner.whatsapp,
        email,
        area: partner.area,
        contact: partner.phone ?? email,
      })
      .select("id")
      .single();
    if (workshopError || !workshop) {
      if (workshopError) captureError(workshopError, { where: "partner-invites:workshop" });
      return { ok: false, reason: "workshop" };
    }
    workshopId = workshop.id as string;
  }

  if (partner.workshop_id !== workshopId || !partner.email) {
    const { error: stampError } = await svc
      .from("partners")
      .update({ workshop_id: workshopId, email: partner.email ?? email })
      .eq("id", partnerId);
    // Reported, not fatal: the link below is what grants access, this only labels the row.
    if (stampError) captureError(stampError, { where: "partner-invites:stamp" });
  }

  const { data: link, error: linkReadError } = await svc
    .from("workshop_links")
    .select("id, status")
    .eq("workshop_id", workshopId)
    .eq("farm_id", farmId)
    .maybeSingle();
  if (linkReadError) {
    captureError(linkReadError, { where: "partner-invites:link-read" });
    return { ok: false, reason: "link" };
  }
  if (!link) {
    const { error } = await svc
      .from("workshop_links")
      .insert({ workshop_id: workshopId, farm_id: farmId, status: "active", ...invite });
    if (error) {
      captureError(error, { where: "partner-invites:link" });
      return { ok: false, reason: "link" };
    }
  } else if (firstClaim) {
    const { error } = await svc
      .from("workshop_links")
      .update({ status: "active", deleted_at: null, ...invite })
      .eq("id", link.id);
    if (error) {
      captureError(error, { where: "partner-invites:link-update" });
      return { ok: false, reason: "link" };
    }
  }

  if (!profile) {
    const { error } = await svc.from("users").insert({
      id: userId,
      workshop_id: workshopId,
      role: "workshop",
      name: personName,
      email,
      active: true,
    });
    // 23505: a double tap got here first, and that is the profile this run wanted.
    if (error && error.code !== "23505") {
      captureError(error, { where: "partner-invites:profile" });
      return { ok: false, reason: "profile" };
    }
  }

  return { ok: true, tokenHash: signIn.tokenHash };
}
