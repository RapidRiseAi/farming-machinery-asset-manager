import { redirect } from "next/navigation";
import { requireProfile, homePathFor } from "@/lib/auth";

/**
 * Post-login dispatch. A magic link is generated before anyone has signed in, so it
 * cannot know the role it will land as — it points here, and here we know.
 */
export default async function HomeDispatchPage() {
  const profile = await requireProfile();
  redirect(homePathFor(profile.role));
}
