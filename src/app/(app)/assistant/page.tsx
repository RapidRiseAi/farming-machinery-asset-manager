import { redirect } from "next/navigation";
import { AssistantClient } from "@/components/assistant/assistant-client";
import { UpgradeNotice } from "@/components/entitlement/upgrade-notice";
import { EmptyState } from "@/components/ui/empty-state";
import { InfoIcon } from "@/components/ui/icons";
import { PageInfoButton } from "@/components/ui/page-info-button";
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { checkEntitlement, currentFarmId, effectiveFarmRole, getFarmPlan } from "@/lib/auth";
import { loadAssistantMachines } from "@/lib/assistant/data";
import { loadAssistantThread } from "@/lib/assistant/history";
import { aiHelpOn } from "@/lib/assistant/transcription";
import { planAllows } from "@/lib/entitlements";
import { t } from "@/lib/i18n";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

export default async function AssistantPage() {
  const gate = await checkEntitlement("voice_ai");
  const profile = gate.profile;
  const locale = profile.lang;
  if (profile.role === "workshop") redirect("/contractor?denied=1");

  const farmId = await currentFarmId(profile);
  if (!farmId) {
    return (
      <PageContainer size="narrow">
        <PageHeader title={t("assistant.title", locale)} infoKey="assistant" locale={locale} />
        <EmptyState
          icon={<InfoIcon />}
          title={t("assistant.farmRequired", locale)}
          hint={t("assistant.farmRequiredHint", locale)}
        />
      </PageContainer>
    );
  }

  const role = await effectiveFarmRole(farmId, profile);
  if (!role) redirect("/machines?denied=1");

  const farmPlan = role !== "rr_admin" ? await getFarmPlan(farmId) : gate.plan;
  const allowed = role === "rr_admin" ? true : Boolean(farmPlan && planAllows(farmPlan, "voice_ai"));
  if (!allowed) {
    return (
      <PageContainer size="narrow">
        <PageHeader
          title={t("assistant.title", locale)}
          lead={t("assistant.lead", locale)}
          infoKey="assistant"
          locale={locale}
        />
        <UpgradeNotice
          feature="voice_ai"
          requiredPlan={gate.requiredPlan}
          currentPlan={farmPlan}
          locale={locale}
          canUpgrade={role === "owner"}
        />
      </PageContainer>
    );
  }

  const supabase = await createClient();
  const machines = await loadAssistantMachines(supabase, farmId, {
    role,
    userId: profile.id,
  });
  // The owner's farm-wide AI switch (/settings/ai). Members cannot read the settings row,
  // so the server reads it: with AI off for the farm there is no notice to show and no AI
  // hearing to ask for. The server refuses AI on its own either way.
  const { data: farmAi } = await createServiceClient()
    .from("farm_ai_settings")
    .select("ai_enabled")
    .eq("farm_id", farmId)
    .maybeSingle();
  const farmAiEnabled = farmAi?.ai_enabled !== false;
  // The same request-scoped client, so RLS decides whose history this is. The
  // machine list is passed through so a pending proposal is only rebuilt for
  // review against a machine this person may still act on.
  const initialThread = await loadAssistantThread(supabase, farmId, profile.id, machines);
  const canChange = ["rr_admin", "owner", "manager", "mechanic"].includes(role);
  return (
    <AssistantClient
      locale={locale}
      offlineContextKey={`${profile.id}:${farmId}`}
      initialSpeechLanguage={profile.language === "af" ? "af-ZA" : "en-ZA"}
      machines={machines}
      initialAiConsent={aiHelpOn(profile)}
      initialNoticeSeen={Boolean(profile.ai_notice_seen_at)}
      initialAiWithdrawn={!profile.ai_processing_opt_in && Boolean(profile.ai_processing_withdrawn_at)}
      farmAiEnabled={farmAiEnabled}
      initialThread={initialThread}
      infoButton={<PageInfoButton infoKey="assistant" locale={locale} />}
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
