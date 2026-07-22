import { LoginForm } from "./login-form";
import { APP_NAME } from "@/lib/env";
import { t } from "@/lib/i18n";
import { MachinesIcon } from "@/components/ui/icons";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; sent?: string }>;
}) {
  const sp = await searchParams;
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 p-6">
      <div className="flex flex-col items-center gap-3 text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-600 text-[1.8rem] text-white shadow-soft">
          <MachinesIcon />
        </span>
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-sand-900">{APP_NAME}</h1>
          <p className="mt-1 text-sm text-sand-500">{t("auth.welcomeSub")}</p>
        </div>
      </div>
      <LoginForm error={sp.error} sent={sp.sent} />
    </main>
  );
}
