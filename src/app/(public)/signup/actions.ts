"use server";

import { redirect } from "next/navigation";

import { PLANS, BILLING_PERIODS, perVehicleMonthlyCents, type Plan } from "@/lib/entitlements";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { sendVerificationEmail } from "@/lib/email/verify";
import { deviceLocale } from "@/lib/locale";
import { TERMS_VERSION } from "@/lib/legal";
import type { BillingPeriod } from "@/lib/entitlements";

/** The most vehicles somebody may buy on the public form without talking to us first. */
const MAX_SELF_SERVE_VEHICLES = 200;

function bounce(code: string): never {
  redirect(`/signup?error=${encodeURIComponent(code)}`);
}

/**
 * Create a farm, its owner and a PENDING subscription, then send them to pay.
 *
 * ── The order, and why it is not negotiable ──────────────────────────────────
 * The account is created BEFORE the money moves. The tempting alternative — take the
 * payment, then create the farm on success — leaves money taken with nothing to attach it
 * to if anything fails in between, and no row to reconcile against. An abandoned sign-up
 * leaves a farm nobody can log into, which is tidy-up-able; a successful payment with no
 * farm is a refund and an apology.
 *
 * That is the same reasoning `beginCheckout` already follows with charge attempts: claim
 * the row before contacting Paystack, precisely so a lost response is recoverable.
 *
 * ── The one thing that cannot be in the transaction ──────────────────────────
 * `auth.users` belongs to Supabase Auth, not to a table this schema may write. So the auth
 * user is created FIRST and deleted if the database function raises. Everything else —
 * farm, owner, subscription, first invoice — is one call and one transaction, so a failure
 * halfway cannot leave a farm with no owner or an owner who can never be invoiced.
 */
export async function signUp(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const farmName = String(formData.get("farm_name") ?? "").trim();
  const plan = String(formData.get("plan") ?? "") as Plan;
  const period = String(formData.get("billing_period") ?? "monthly") as BillingPeriod;
  const vehicles = Number.parseInt(String(formData.get("vehicles") ?? ""), 10);

  if (!email || !email.includes("@")) bounce("signup-email");
  if (password.length < 8) bounce("signup-password");
  if (!name) bounce("signup-name");
  if (!farmName) bounce("signup-farm");
  if (!(PLANS as readonly string[]).includes(plan)) bounce("signup-plan");
  if (!(BILLING_PERIODS as readonly string[]).includes(period)) bounce("signup-plan");
  if (!Number.isFinite(vehicles) || vehicles < 1) bounce("signup-vehicles");
  if (vehicles > MAX_SELF_SERVE_VEHICLES) bounce("signup-too-many");

  // The tick is required, and the VERSION is checked rather than trusted. The form posts
  // what the page rendered, so a deploy between load and submit cannot record agreement to
  // wording the visitor never saw — but a posted value is still a posted value, and storing
  // an arbitrary string somebody typed into a form is not a record of anything.
  if (String(formData.get("terms") ?? "") !== "on") bounce("terms-required");
  if (String(formData.get("terms_version") ?? "") !== TERMS_VERSION) bounce("terms-stale");

  // A plan with no published price is either bespoke or simply not on sale. Refused here
  // as well as in SQL, so the visitor gets a sentence rather than a failed transaction.
  if (perVehicleMonthlyCents(plan, period) == null) bounce("signup-plan-unavailable");

  const svc = createServiceClient();

  // Somebody who started a sign-up, abandoned the payment and came back. Their auth user
  // already owns this address, so a second createUser would fail with a message about
  // internals. Send them to sign in instead: the billing gate will land them straight on
  // /activate with the invoice they already have, which IS the resumption — no second code
  // path to keep correct.
  const { data: existing } = await svc.auth.admin.listUsers();
  const taken = (existing?.users ?? []).some(
    (u) => (u.email ?? "").toLowerCase() === email,
  );
  if (taken) redirect(`/login?resume=1&email=${encodeURIComponent(email)}`);

  const created = await svc.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { name },
  });
  if (created.error || !created.data.user) bounce("signup-failed");
  const userId = created.data.user.id;

  const { error } = await svc.rpc("billing_create_pending_signup", {
    p_user: userId,
    p_email: email,
    p_name: name,
    p_farm_name: farmName,
    p_plan: plan,
    p_period: period,
    p_quota: vehicles,
  });

  if (error) {
    // Nothing was written on the database side (it is one transaction), so the auth user
    // is the only orphan and it goes too. Leaving it would make the address unusable: the
    // branch above would send them to sign in, to an account with no farm behind it.
    await svc.auth.admin.deleteUser(userId).catch(() => {});
    bounce("signup-failed");
  }

  // What they agreed to, and when. Written after the farm exists because the user row is
  // created by `billing_create_pending_signup`, and deliberately NOT backfilled onto
  // anybody else: recording a consent nobody gave is worse than recording none.
  await svc
    .from("users")
    .update({ terms_accepted_at: new Date().toISOString(), terms_version: TERMS_VERSION })
    .eq("id", userId);

  // Prove the address works. The auth user is already confirmed — it has to be, or they
  // could not sign in and pay in the next two lines — so this is OUR check, it gates
  // nothing, and its failure is swallowed on purpose. A farm that has paid and cannot be
  // emailed is a support problem; a farm that could not sign up because our mail provider
  // was down is a lost customer. `/account` carries the resend.
  await sendVerificationEmail(svc, {
    userId,
    email,
    name,
    locale: await deviceLocale(),
  }).catch(() => undefined);

  // Sign them in with the password they just chose, so they arrive at /activate as
  // themselves rather than at a login screen wondering whether any of that worked.
  const browser = await createClient();
  const { error: signInError } = await browser.auth.signInWithPassword({ email, password });
  if (signInError) redirect("/login?signedup=1");

  redirect("/activate");
}
