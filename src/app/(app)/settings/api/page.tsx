import Link from "next/link";
import { redirect } from "next/navigation";
import {
  currentFarmId,
  effectiveFarmRole,
  getFarmPlan,
  homePathFor,
  requireProfile,
} from "@/lib/auth";
import { planAllows, requiredPlan } from "@/lib/entitlements";
import { createClient } from "@/lib/supabase/server";
import { t } from "@/lib/i18n";
import { shortDate } from "@/lib/format";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/ui/badge";
import { Flash } from "@/components/ui/flash";
import { ConfirmForm } from "@/components/confirm-form";
import { UpgradeNotice } from "@/components/entitlement/upgrade-notice";
import { ApiTokenCreateForm } from "./api-token-create-form";
import { revokeApiToken } from "./actions";

export const dynamic = "force-dynamic";

type ApiTokenRow = {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
};

function localTomorrow(): string {
  const parts = new Intl.DateTimeFormat("en-ZA", {
    timeZone: "Africa/Johannesburg",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(Date.now() + 24 * 60 * 60 * 1_000));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export default async function ApiTokensPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; revoked?: string }>;
}) {
  const profile = await requireProfile();
  const locale = profile.lang;
  const sp = await searchParams;
  const farmId = await currentFarmId(profile);
  if (!farmId) redirect(`${homePathFor(profile.role)}?denied=1`);
  const role = await effectiveFarmRole(farmId, profile);
  if (!role || !["owner", "manager", "rr_admin"].includes(role)) {
    redirect(`${homePathFor(profile.role)}?denied=1`);
  }

  const plan = role === "rr_admin" ? null : await getFarmPlan(farmId);
  if (role !== "rr_admin" && (!plan || !planAllows(plan, "api_access"))) {
    return (
      <div className="flex flex-col gap-5">
        <h1 className="text-2xl font-bold tracking-tight text-sand-900">{t("apiTokens.title", locale)}</h1>
        <UpgradeNotice
          feature="api_access"
          requiredPlan={requiredPlan("api_access")}
          currentPlan={plan}
          locale={locale}
        />
      </div>
    );
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("api_tokens")
    .select("id,name,prefix,scopes,created_at,last_used_at,expires_at,revoked_at")
    .eq("farm_id", farmId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  const tokens = (data ?? []) as ApiTokenRow[];
  const now = Date.now();

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <div>
        <Link href="/machines" className="text-sm font-medium text-brand-700 hover:underline">
          &larr; {t("apiTokens.back", locale)}
        </Link>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-sand-900">{t("apiTokens.title", locale)}</h1>
        <p className="mt-1 text-sm text-sand-600">{t("apiTokens.intro", locale)}</p>
      </div>

      <Flash tone="error" message={error || sp.error ? t("apiTokens.error.load_failed", locale) : undefined} />
      <Flash tone="success" message={sp.revoked ? t("apiTokens.revoked", locale) : undefined} />

      <Card>
        <CardHeader><CardTitle>{t("apiTokens.createTitle", locale)}</CardTitle></CardHeader>
        <ApiTokenCreateForm locale={locale} minExpiry={localTomorrow()} />
      </Card>

      <Card>
        <CardHeader><CardTitle>{t("apiTokens.existing", locale)}</CardTitle></CardHeader>
        {tokens.length === 0 ? (
          <p className="text-sm text-sand-500">{t("apiTokens.empty", locale)}</p>
        ) : (
          <ul className="divide-y divide-sand-200">
            {tokens.map((token) => {
              const expired = token.expires_at ? Date.parse(token.expires_at) <= now : false;
              const active = !token.revoked_at && !expired;
              return (
                <li key={token.id} className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-semibold text-sand-900">{token.name}</p>
                      <StatusBadge
                        tone={active ? "ok" : token.revoked_at ? "danger" : "warning"}
                        shape={active ? "dot" : token.revoked_at ? "dash" : "triangle"}
                        label={t(
                          active
                            ? "apiTokens.active"
                            : token.revoked_at
                              ? "apiTokens.statusRevoked"
                              : "apiTokens.expired",
                          locale,
                        )}
                      />
                    </div>
                    <p className="mt-1 font-mono text-xs text-sand-600">{token.prefix}&hellip;</p>
                    <p className="mt-1 text-xs text-sand-500">
                      {token.scopes.join(", ")} &middot; {t("apiTokens.created", locale)} {shortDate(token.created_at, locale)} &middot; {t("apiTokens.lastUsed", locale)} {token.last_used_at ? shortDate(token.last_used_at, locale) : t("apiTokens.never", locale)}
                    </p>
                    {token.expires_at ? (
                      <p className="mt-1 text-xs text-sand-500">{t("apiTokens.expires", locale)} {shortDate(token.expires_at, locale)}</p>
                    ) : null}
                  </div>
                  {active ? (
                    <ConfirmForm
                      action={revokeApiToken}
                      message={t("apiTokens.revokeConfirm", locale).replace("{name}", token.name)}
                      label={t("apiTokens.revoke", locale)}
                    >
                      <input type="hidden" name="id" value={token.id} />
                    </ConfirmForm>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
