import Link from "next/link";
import { currentFarmId, requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { t } from "@/lib/i18n";
import { whatsappEnabled } from "@/lib/whatsapp/config";
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { WhatsAppSettings, type LinkStatus } from "./whatsapp-settings";

export const dynamic = "force-dynamic";

export default async function WhatsAppPage() {
  const profile = await requireProfile();
  const db = await createClient();
  const farmId = await currentFarmId(profile);
  const [{ data: status, error }, { data: farm }] = await Promise.all([
    db.rpc("whatsapp_link_status"),
    farmId ? db.from("farms").select("name").eq("id", farmId).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  return <PageContainer size="narrow">
    <PageHeader title={t("whatsapp.title", profile.lang)} lead={t("whatsapp.description", profile.lang)} />
    <Link href="/account#alerts" className="text-brand-ink underline">{t("whatsapp.back", profile.lang)}</Link>
    <WhatsAppSettings locale={profile.lang} status={status as LinkStatus | null}
      enabled={whatsappEnabled() && !error} farmName={farm?.name ?? null} />
  </PageContainer>;
}
