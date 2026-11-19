import type { ReactNode } from "react";
import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { t } from "@/lib/i18n";
import { isUuid } from "@/lib/ids";
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { UploadField } from "@/components/upload/upload-field";
import { looksLikeUploadToken, uploadTokenHash } from "@/lib/whatsapp/upload-link";

export const dynamic = "force-dynamic";

type Opened =
  | { ok: true; farm_id: string; purpose: "fault_photo" | "document" | "voice"; target_kind: "fault" | null; target_id: string | null }
  | { ok: false; reason: "unknown" | "expired" | "not_member" };

/**
 * A file WhatsApp could not carry (20261121090000). The link is the person's own: it opens only
 * for the signed-in person it was made for, on the business it was made for, while they are a
 * member, for 30 minutes. The upload itself is the app's (B1's pipeline, the normal row
 * security), so a forwarded link gives nobody else anything.
 */
export default async function WhatsAppUploadPage({
  params, searchParams,
}: { params: Promise<{ token: string }>; searchParams: Promise<{ fault?: string }> }) {
  const profile = await requireProfile();
  const lang = profile.lang;
  const { token } = await params;
  const { fault: chosen } = await searchParams;
  const db = await createClient();
  const opened = looksLikeUploadToken(token)
    ? await db.rpc("whatsapp_upload_link_open", { p_token_hash: uploadTokenHash(token) })
    : { data: { ok: false, reason: "unknown" } as Opened, error: null };
  const answer = (opened.error ? { ok: false, reason: "unknown" } : opened.data) as Opened;

  const shell = (body: ReactNode) => <PageContainer size="narrow">
    <PageHeader title={t("whatsapp.uploadTitle", lang)} lead={t("whatsapp.uploadLead", lang)} />
    {body}
  </PageContainer>;

  if (!answer.ok) {
    const message = answer.reason === "expired" ? "whatsapp.uploadExpired"
      : answer.reason === "not_member" ? "whatsapp.uploadNotMember" : "whatsapp.uploadUnknown";
    return shell(<p className="text-sand-700">{t(message, lang)}</p>);
  }
  if (answer.purpose === "voice") {
    return shell(<p className="text-sand-700">{t("whatsapp.uploadVoice", lang)}{" "}
      <Link href="/assistant" className="text-brand-ink underline">{t("whatsapp.uploadOpenAssistant", lang)}</Link></p>);
  }
  if (answer.purpose === "document") {
    return shell(<p className="text-sand-700">{t("whatsapp.uploadDocument", lang)}{" "}
      <Link href="/machines" className="text-brand-ink underline">{t("whatsapp.uploadOpenMachines", lang)}</Link></p>);
  }

  // A photo for a fault: the one the link names, or one the person picks on that business.
  const faultId = answer.target_id ?? (isUuid(chosen ?? "") ? chosen! : null);
  if (faultId) {
    const fault = await db.from("faults").select("id,description").eq("id", faultId)
      .eq("farm_id", answer.farm_id).is("deleted_at", null).maybeSingle();
    if (fault.error || !fault.data) return shell(<p className="text-sand-700">{t("whatsapp.uploadUnknown", lang)}</p>);
    return shell(<div className="space-y-3">
      <p className="text-sand-700">{t("whatsapp.uploadFor", lang).replace("{fault}", fault.data.description ?? "")}</p>
      <UploadField locale={lang} accept="photo" capture uploadLabel="photo" attachmentKind="photo" finish="generic"
        scope={`whatsapp-upload:${faultId}`} target={{ kind: "fault", id: faultId, farmId: answer.farm_id }} />
    </div>);
  }
  const faults = await db.from("faults").select("id,description").eq("farm_id", answer.farm_id)
    .in("status", ["open", "in_job", "scheduled"]).is("deleted_at", null).order("created_at", { ascending: false }).limit(20);
  const rows = (faults.data ?? []) as { id: string; description: string | null }[];
  return shell(rows.length ? <div className="space-y-2">
    <p className="text-sand-700">{t("whatsapp.uploadPickFault", lang)}</p>
    <ul className="space-y-1">{rows.map((f) => <li key={f.id}>
      <Link href={`/whatsapp/upload/${token}?fault=${f.id}`} className="text-brand-ink underline">
        {f.description || t("whatsapp.uploadUnnamedFault", lang)}
      </Link>
    </li>)}</ul>
  </div> : <p className="text-sand-700">{t("whatsapp.uploadNoFaults", lang)}{" "}
    <Link href="/faults" className="text-brand-ink underline">{t("whatsapp.uploadOpenFaults", lang)}</Link></p>);
}
