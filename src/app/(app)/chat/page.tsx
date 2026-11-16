import { requireProfile, currentFarmId } from "@/lib/auth";
import { featureOn } from "@/lib/features";
import { t } from "@/lib/i18n";
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { ChatHome } from "@/components/chat/chat-home";
export default async function ChatPage() {
  const profile=await requireProfile(),farm=await currentFarmId(profile);
  const enabled=farm&&await featureOn("general_chat",farm);
  return <PageContainer><PageHeader title={t("chat.title",profile.lang)}/>
    {enabled&&profile.role!=="workshop"?<ChatHome farm={farm!} locale={profile.lang}/>:<p>{t("chat.unavailable",profile.lang)}</p>}
  </PageContainer>;
}
