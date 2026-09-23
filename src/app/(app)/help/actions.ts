"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import { requireProfile } from "@/lib/auth";
import { safePath } from "@/lib/safe-path";

/**
 * Asking us for help, from inside the product.
 *
 * == It carries no authority ==================================================
 * `public.open_help_request` establishes who is asking from `auth.uid()` and reads the
 * farm from their own profile. Nothing about the farm comes from this form, so there is no
 * field to tamper with: a farmer cannot open a case against somebody else's farm by
 * editing the HTML.
 *
 * == Why the path is sent =====================================================
 * Because the first reply to a support email is always "which screen were you on". Sending
 * it turns a two-day round trip into an answer. It is validated with `safePath` before it
 * goes, and the database keeps only three named keys whatever this posts.
 */

function bounce(code: string): never {
  redirect(`/help?error=${encodeURIComponent(code)}`);
}

export async function askForHelp(formData: FormData): Promise<void> {
  const profile = await requireProfile();

  const subject = String(formData.get("subject") ?? "").trim();
  const message = String(formData.get("message") ?? "").trim();
  if (!subject) bounce("help-need-subject");
  if (!message) bounce("help-need-message");
  if (subject.length > 200) bounce("help-subject-long");
  if (message.length > 4000) bounce("help-message-long");

  // A form field, so never trusted as a path. `safePath` refuses anything that is not a
  // relative route on this site, which is what keeps an absolute URL out of a queue a
  // person clicks through.
  const path = safePath(String(formData.get("path") ?? ""), "/help");

  const supabase = await createClient();
  const { error } = await supabase.rpc("open_help_request", {
    p_subject: subject,
    p_message: message,
    p_context: { path, locale: profile.lang },
  });

  if (error) {
    // 53000 is the per-farm ceiling. It is the one refusal with a next step, so it gets
    // its own sentence rather than the generic apology.
    if (error.code === "53000") bounce("help-too-many");
    bounce("help-failed");
  }

  revalidatePath("/help");
  redirect("/help?saved=1");
}
