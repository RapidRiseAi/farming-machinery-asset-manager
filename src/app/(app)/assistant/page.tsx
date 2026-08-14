import { redirect } from "next/navigation";
import { AssistantClient } from "@/components/assistant/assistant-client";
import { UpgradeNotice } from "@/components/entitlement/upgrade-notice";
import { EmptyState } from "@/components/ui/empty-state";
import { InfoIcon } from "@/components/ui/icons";
import { checkEntitlement, currentFarmId, effectiveFarmRole, getFarmPlan } from "@/lib/auth";
import { loadAssistantMachines } from "@/lib/assistant/data";
import { planAllows } from "@/lib/entitlements";
import { t } from "@/lib/i18n";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function AssistantPage() {
  const gate = await checkEntitlement("voice_ai");
  const profile = gate.profile;
  const locale = profile.lang;
  if (profile.role === "workshop") redirect("/contractor?denied=1");

  const farmId = await currentFarmId(profile);
  const role = farmId ? await effectiveFarmRole(farmId, profile) : null;
  const farmPlan = farmId && role !== "rr_admin" ? await getFarmPlan(farmId) : gate.plan;
  const allowed = role === "rr_admin" ? true : Boolean(role && farmPlan && planAllows(farmPlan, "voice_ai"));
  if (!allowed) {
    return (
      <div className="flex flex-col gap-5">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-sand-900">{t("assistant.title", locale)}</h1>
          <p className="mt-1 text-sm text-sand-600">{t("assistant.lead", locale)}</p>
        </div>
        <UpgradeNotice
          feature="voice_ai"
          requiredPlan={gate.requiredPlan}
          currentPlan={farmPlan}
          locale={locale}
        />
      </div>
    );
  }

  if (!farmId) {
    return (
      <EmptyState
        icon={<InfoIcon />}
        title={t("assistant.farmRequired", locale)}
        hint={t("assistant.farmRequiredHint", locale)}
      />
    );
  }

  if (!role) redirect("/machines?denied=1");
  const machines = await loadAssistantMachines(await createClient(), farmId, {
    role,
    userId: profile.id,
  });
  const canChange = ["rr_admin", "owner", "manager", "mechanic"].includes(role);
  return (
    <AssistantClient
      locale={locale}
      offlineContextKey={`${profile.id}:${farmId}`}
      initialSpeechLanguage={profile.language === "af" ? "af-ZA" : "en-ZA"}
      machines={machines}
      initialAiConsent={profile.ai_processing_opt_in}
      capabilities={{
        reportFault: ["rr_admin", "owner", "manager", "mechanic", "operator"].includes(role),
        logReading: canChange,
        logService: canChange,
        queryStatus: true,
        queryServiceDue: true,
      }}
    />
  );
}
