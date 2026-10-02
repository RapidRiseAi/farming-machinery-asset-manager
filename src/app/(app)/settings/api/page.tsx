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
import { t, type Lang } from "@/lib/i18n";
import { shortDate, todayLocal } from "@/lib/format";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/ui/badge";
import { Flash } from "@/components/ui/flash";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DialogForm } from "@/components/ui/dialog-form";
import { PlusIcon } from "@/components/ui/icons";
import { PageContainer, PageHeader } from "@/components/ui/page-header";
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

/** A scope id ("read", "write:readings") in the farm's words; an unknown id stays as-is. */
const SCOPE_LABEL: Record<string, string> = {
  read: "apiTokens.scopeRead",
  "write:readings": "apiTokens.scopeWrite",
};

function scopeLabels(scopes: string[], locale: Lang): string {
  return scopes.map((scope) => (SCOPE_LABEL[scope] ? t(SCOPE_LABEL[scope], locale) : scope)).join(", ");
}

/** Errors the actions redirect back with; anything else is the page failing to load. */
const KNOWN_ERRORS = new Set(["revoke_failed"]);

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

  const back = { href: "/settings", label: t("nav.settings", locale) };

  const plan = role === "rr_admin" ? null : await getFarmPlan(farmId);
  if (role !== "rr_admin" && (!plan || !planAllows(plan, "api_access"))) {
    return (
      <PageContainer size="narrow">
        <PageHeader
          title={t("apiTokens.title", locale)}
          infoKey="apiTokens"
          locale={locale}
          back={back}
        />
        <UpgradeNotice
          feature="api_access"
          requiredPlan={requiredPlan("api_access")}
          currentPlan={plan}
          locale={locale}
          canUpgrade={role === "owner"}
        />
      </PageContainer>
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
  const errorKey =
    sp.error && KNOWN_ERRORS.has(sp.error) ? `apiTokens.error.${sp.error}` : "apiTokens.error.load_failed";

  return (
    <PageContainer size="narrow">
      <PageHeader
        title={t("apiTokens.title", locale)}
        lead={t("apiTokens.intro", locale)}
        infoKey="apiTokens"
        locale={locale}
        back={back}
        actions={
          <DialogForm
            trigger={t("apiTokens.new", locale)}
            triggerIcon={<PlusIcon />}
            title={t("apiTokens.createTitle", locale)}
            description={t("apiTokens.createLead", locale)}
            closeLabel={t("ui.close", locale)}
            size="md"
          >
            <ApiTokenCreateForm
              locale={locale}
              minExpiry={todayLocal(new Date(Date.now() + 24 * 60 * 60 * 1_000))}
            />
          </DialogForm>
        }
      />

      <Flash tone="error" message={error || sp.error ? t(errorKey, locale) : undefined} />
      <Flash tone="success" message={sp.revoked ? t("apiTokens.revoked", locale) : undefined} />

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
                      <p className="min-w-0 break-words font-semibold text-sand-900">{token.name}</p>
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
                    <p className="mt-1 break-all font-mono text-xs text-sand-600">{token.prefix}&hellip;</p>
                    <p className="mt-1 text-sm text-sand-700">{scopeLabels(token.scopes, locale)}</p>
                    <p className="mt-1 text-xs text-sand-500">
                      {t("apiTokens.created", locale)} {shortDate(token.created_at, locale)} &middot;{" "}
                      {t("apiTokens.lastUsed", locale)}{" "}
                      {token.last_used_at ? shortDate(token.last_used_at, locale) : t("apiTokens.never", locale)}
                      {token.expires_at ? (
                        <>
                          {" "}&middot; {t("apiTokens.expires", locale)} {shortDate(token.expires_at, locale)}
                        </>
                      ) : null}
                    </p>
                  </div>
                  {active ? (
                    <ConfirmDialog
                      action={revokeApiToken}
                      triggerLabel={t("apiTokens.revoke", locale)}
                      triggerVariant="secondary"
                      triggerSize="sm"
                      title={t("apiTokens.revokeTitle", locale).replace("{name}", token.name)}
                      intro={t("apiTokens.revokeIntro", locale)}
                      confirmLabel={t("apiTokens.revoke", locale)}
                      cancelLabel={t("common.cancel", locale)}
                      closeLabel={t("ui.close", locale)}
                      tone="danger"
                    >
                      <input type="hidden" name="id" value={token.id} />
                    </ConfirmDialog>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </PageContainer>
  );
}
