import { errorMessage } from "@/lib/errors";
import { notFound } from "next/navigation";
import QRCode from "qrcode";
import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { t } from "@/lib/i18n";
import { PrintButton } from "@/components/print-button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Disclosure } from "@/components/ui/disclosure";
import { Flash } from "@/components/ui/flash";
import { BackLink, PageContainer } from "@/components/ui/page-header";
import { reissueQr } from "../qr-actions";

export default async function MachineQrPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ reissued?: string; error?: string }>;
}) {
  const profile = await requireProfile();
  const locale = profile.lang;
  const { id } = await params;
  const sp = await searchParams;

  const supabase = await createClient();
  const { data } = await supabase
    .from("machines")
    .select("name, public_token")
    .eq("id", id)
    .maybeSingle();
  const machine = data as { name: string; public_token: string } | null;
  if (!machine) notFound();

  const site = process.env.NEXT_PUBLIC_SITE_URL ?? "";
  const url = `${site}/m/${machine.public_token}`;
  const svg = await QRCode.toString(url, { type: "svg", margin: 1, width: 260 });

  // Only owner/manager (or a cross-tenant RR admin) may rotate the token; the
  // reissueQr action re-checks this, the UI gate here just hides the control.
  const canReissue = profile.role === "owner" || profile.role === "manager" || profile.role === "rr_admin";

  return (
    <PageContainer size="narrow">
      <BackLink href={`/machines/${id}`} label={machine.name} className="-mb-2 -mt-2 print:hidden" />

      {sp.reissued ? (
        <Flash tone="success" message={t("qr.reissued", locale)} className="w-full print:hidden" />
      ) : null}
      {sp.error ? <Flash tone="error" message={errorMessage(sp.error, locale)} className="w-full print:hidden" /> : null}

      {/* Print sheet */}
      <div className="w-full rounded-2xl border border-sand-200 bg-surface p-8 text-center shadow-card print:border-2 print:border-sand-900 print:shadow-none">
        <h1 className="mb-1 text-2xl font-bold tracking-tight text-ink">{machine.name}</h1>
        <p className="mb-4 text-sm text-sand-500">{t("app.name", locale)}</p>
        <div className="mx-auto w-[260px]" dangerouslySetInnerHTML={{ __html: svg }} />
        <p className="mt-4 text-base font-medium text-sand-800">{t("qr.scanCaption", locale)}</p>
        <p className="mt-2 break-all text-xs text-sand-400">{url}</p>
      </div>

      <div className="flex flex-col items-center gap-2 print:hidden">
        <PrintButton label={t("qr.print", locale)} />
        {!site ? <p className="text-sm text-status-due">{t("qr.siteUrlMissing", locale)}</p> : null}
      </div>

      {/* Re-issue / replace the QR (FR-9.4), lost, damaged, or possibly-copied sticker.
          Shut until somebody needs it: it is rare, and it kills the printed sticker at once,
          so it is a quiet button behind a question, and the confirmation names what breaks
          (it was a filled red button at rest gated by the browser's own confirm()). */}
      {canReissue ? (
        <Disclosure summary={t("qr.reissueTitle", locale)} className="print:hidden">
          <p className="text-sm text-sand-600">{t("qr.reissueDesc", locale)}</p>
          <div className="mt-3 flex">
            <ConfirmDialog
              action={reissueQr}
              triggerVariant="secondary"
              triggerLabel={t("qr.reissueBtn", locale)}
              title={t("confirm.reissueQrTitle", locale).replace("{machine}", machine.name)}
              consequencesTitle={t("confirm.whatHappens", locale)}
              consequences={[t("confirm.reissueQrEffect1", locale), t("confirm.reissueQrEffect2", locale)]}
              confirmLabel={t("qr.reissueBtn", locale)}
              cancelLabel={t("confirm.keepIt", locale)}
              closeLabel={t("ui.close", locale)}
            >
              <input type="hidden" name="machine_id" value={id} />
            </ConfirmDialog>
          </div>
        </Disclosure>
      ) : null}
    </PageContainer>
  );
}
