"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export async function signInWithPassword(formData: FormData) {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) redirect(`/login?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/", "layout");
  redirect("/dashboard");
}

export async function signInWithMagicLink(formData: FormData) {
  const email = String(formData.get("email") ?? "").trim();
  const supabase = await createClient();
  const origin =
    (await headers()).get("origin") ??
    process.env.NEXT_PUBLIC_SITE_URL ??
    "";
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: `${origin}/auth/callback?next=/dashboard` },
  });
  if (error) redirect(`/login?error=${encodeURIComponent(error.message)}`);
  redirect("/login?sent=1");
}
