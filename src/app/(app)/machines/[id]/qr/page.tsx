import Link from "next/link";
import { notFound } from "next/navigation";
import QRCode from "qrcode";
import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { t } from "@/lib/i18n";
import { PrintButton } from "@/components/print-button";
import { ConfirmForm } from "@/components/confirm-form";
import { Flash } from "@/components/ui/flash";
import { ChevronLeftIcon } from "@/components/ui/icons";
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
  // reissueQr action re-checks this — the UI gate here just hides the control.
  const canReissue = profile.role === "owner" || profile.role === "manager" || profile.role === "rr_admin";

  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-center gap-4">
      <div className="w-full print:hidden">
        <Link href={`/machines/${id}`} className="focus-ring inline-flex items-center gap-1 rounded-md text-sm text-sand-500">
          <ChevronLeftIcon className="text-[1rem]" />
          {machine.name}
        </Link>
      </div>

      {sp.reissued ? (
        <Flash tone="success" message={t("qr.reissued", locale)} className="w-full print:hidden" />
      ) : null}
      {sp.error ? <Flash tone="error" message={sp.error} className="w-full print:hidden" /> : null}

      {/* Print sheet */}
      <div className="w-full rounded-2xl border border-sand-200 bg-white p-8 text-center shadow-card print:border-2 print:border-sand-900 print:shadow-none">
        <h1 className="mb-1 text-2xl font-bold text-sand-900">{machine.name}</h1>
        <p className="mb-4 text-sm text-sand-500">{t("app.name", locale)}</p>
        <div className="mx-auto w-[260px]" dangerouslySetInnerHTML={{ __html: svg }} />
        <p className="mt-4 text-base font-medium text-sand-800">{t("qr.scanCaption", locale)}</p>
        <p className="mt-2 break-all text-xs text-sand-400">{url}</p>
      </div>

      <PrintButton label={t("qr.print", locale)} />
      {!site ? (
        <p className="text-xs text-status-due">
          Set NEXT_PUBLIC_SITE_URL so the QR points at your production URL.
        </p>
      ) : null}

      {/* Re-issue / replace the QR (FR-9.4) — lost, damaged, or possibly-copied sticker. */}
      {canReissue ? (
        <div className="w-full rounded-2xl border border-sand-200 bg-sand-50 p-5 print:hidden">
          <h2 className="text-base font-semibold text-sand-900">{t("qr.reissueTitle", locale)}</h2>
          <p className="mt-1 text-sm text-sand-600">{t("qr.reissueDesc", locale)}</p>
          <ConfirmForm
            action={reissueQr}
            message={t("qr.reissueConfirm", locale)}
            label={t("qr.reissueBtn", locale)}
            className="mt-3"
          >
            <input type="hidden" name="machine_id" value={id} />
          </ConfirmForm>
        </div>
      ) : null}
    </div>
  );
}
