import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requireProfile, homePathFor, currentPlan } from "@/lib/auth";
import { START_COOKIE, destinationsFor, resolveStartPath } from "@/lib/preferences";

/**
 * Post-login dispatch. A magic link is generated before anyone has signed in, so it
 * cannot know the role it will land as, it points here, and here we know.
 *
 * A person may choose their own start page on /account (`fw_start`, per device). It is
 * honoured only while it is still a screen their role and plan can open; a promotion, a
 * downgrade or a hand-edited cookie falls back to the role's standard home.
 */
export default async function HomeDispatchPage() {
  const profile = await requireProfile();
  const fallback = homePathFor(profile.role);
  const stored = (await cookies()).get(START_COOKIE)?.value;
  if (!stored) redirect(fallback);
  const { plan } = await currentPlan(profile);
  redirect(resolveStartPath(stored, destinationsFor(profile.role, plan), fallback));
}
