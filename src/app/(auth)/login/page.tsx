import { LoginForm } from "./login-form";
import { APP_NAME } from "@/lib/env";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; sent?: string }>;
}) {
  const sp = await searchParams;
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 p-6">
      <h1 className="text-2xl font-bold">{APP_NAME}</h1>
      <LoginForm error={sp.error} sent={sp.sent} />
    </main>
  );
}
