"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { isWorkshopPlan } from "@/lib/contractor-plan";
import { alertPartnerApplication, sendApplicationReceived } from "@/lib/email/partner-access";
import { BARE_ADDRESS } from "@/lib/email/resend";
import { t } from "@/lib/i18n";
import { deviceLocale } from "@/lib/locale";
import { captureError } from "@/lib/observability";
import { checkTurnstile } from "@/lib/security/turnstile";
import { createServiceClient } from "@/lib/supabase/service";

const KINDS = ["mechanic", "auto_electrician", "parts_supplier", "panel_beater", "tyre", "towing", "other"];

function bounce(code: string): never {
  redirect(`/become-a-partner?error=${code}`);
}

function field(fd: FormData, name: string, max: number): string {
  return String(fd.get(name) ?? "").trim().slice(0, max);
}

/**
 * A business asks to become a partner. It creates a request and nothing else: no account, no
 * price and no plan. Rapid Rise reads it, talks to them, and an account exists only once they
 * approve it in the console.
 *
 * Anonymous and it writes, so it gets what /signup has: a limit per source, checked after the
 * form is valid so a typing mistake does not spend the allowance, and a hidden field that
 * only a script fills in. A repeat from the same address reads as a success, so this form
 * cannot be used to learn who has already applied.
 */
export async function applyToPartner(formData: FormData): Promise<void> {
  // Filled in only by something that reads the page's source rather than the page.
  if (field(formData, "company_site", 200)) redirect("/become-a-partner?sent=1");

  const business = field(formData, "business_name", 120);
  const contact = field(formData, "contact_name", 120);
  const email = field(formData, "email", 200).toLowerCase();
  const phone = field(formData, "phone", 40);
  const area = field(formData, "area", 200);
  const offer = field(formData, "offer", 2000);
  const kind = field(formData, "kind", 40);
  const plan = field(formData, "plan", 20);

  if (business.length < 2 || contact.length < 2 || phone.length < 6 || area.length < 2 || offer.length < 2) {
    bounce("apply-missing");
  }
  if (!KINDS.includes(kind)) bounce("apply-missing");
  if (!BARE_ADDRESS.test(email)) bounce("apply-email");
  if (String(formData.get("consent") ?? "") !== "on") bounce("apply-consent");

  // The bot check (lib/security/turnstile.ts), before the limiter or the insert. A no-op
  // until its keys are set.
  const captcha = await checkTurnstile(formData);
  if (captcha) bounce(captcha);

  const svc = createServiceClient();
  const forwarded = (await headers()).get("x-forwarded-for") ?? "";
  const source = forwarded.split(",")[0]?.trim() || "unknown";
  const { data: slot, error: slotError } = await svc.rpc("billing_take_signup_slot", {
    p_source: `partner:${source}`,
    p_limit: 10,
  });
  // Fails open, as on /signup: turning a real business away is the worse way round.
  if (!slotError && slot === false) bounce("apply-busy");

  const locale = await deviceLocale();
  const { error } = await svc.from("partner_applications").insert({
    business_name: business,
    kind,
    contact_name: contact,
    email,
    phone,
    area,
    website: field(formData, "website", 200) || null,
    offer,
    vouch: field(formData, "vouch", 2000) || null,
    plan_interest: isWorkshopPlan(plan) ? plan : null,
    locale,
  });
  // 23505 is the one open request per address: this is the same request again.
  if (error?.code === "23505") redirect("/become-a-partner?sent=1");
  if (error) {
    captureError(error, { where: "become-a-partner:insert" });
    bounce("apply-failed");
  }

  // The request is safe from here. Neither email is a reason to tell them it failed, and an
  // unsent alert is why the console also lists every open request.
  const [alert, thanks] = await Promise.all([
    alertPartnerApplication({ businessName: business, trade: t(`partnerKind.${kind}`, "en"), area }),
    sendApplicationReceived({ email, name: contact, businessName: business, locale }),
  ]);
  if (!alert.ok) captureError(new Error(`partner request alert not sent (${alert.reason})`), { where: "become-a-partner:alert" });
  if (!thanks.ok) captureError(new Error(`partner request thanks not sent (${thanks.reason})`), { where: "become-a-partner:thanks" });

  redirect("/become-a-partner?sent=1");
}
