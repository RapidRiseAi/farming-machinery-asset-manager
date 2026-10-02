import Link from "next/link";
import { redirect } from "next/navigation";
import QRCode from "qrcode";
import { requireProfile, currentFarmId } from "@/lib/auth";
import { farmPermissionState } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";
import { sanitiseFilterTerm } from "@/lib/search-filter";
import { num } from "@/lib/format";
import { t } from "@/lib/i18n";
import { PrintButton } from "@/components/print-button";
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { backHref } from "@/components/ui/back-href";
import { EmptyState } from "@/components/ui/empty-state";
import { SubmitButton } from "@/components/ui/submit-button";
import { Card } from "@/components/ui/card";
import { MachinesIcon } from "@/components/ui/icons";
import { acknowledgeQrLabels } from "@/app/(app)/onboarding/actions";

type SP = { type?: string; cc?: string; dept?: string; q?: string; from?: string };

/**
 * A sheet of QR stickers for the whole fleet, or for the machines the list was filtered
 * to, printed in one go.
 *
 * Onboarding's step three ("print and stick QR codes") used to mean opening every
 * machine, tapping QR code and printing: twelve round trips for a twelve-machine farm.
 * Each sticker carries what the single-machine sheet does (the machine's name, the QR
 * pointing at its no-login page, and the scan caption), plus the registration, which is
 * how a sticker finds the right bakkie when two share a nickname.
 */
export default async function MachineQrSheetPage({ searchParams }: { searchParams: Promise<SP> }) {
  const profile = await requireProfile();
  const locale = profile.lang;
  const sp = await searchParams;

  const supabase = await createClient();
  const farmId = await currentFarmId(profile);
  const permissionState = await farmPermissionState(profile, farmId);
  const role = permissionState.role;
  // Printing the fleet's stickers is an office task, the same people who add machines.
  if (role !== "owner" && role !== "manager" && role !== "rr_admin") redirect("/machines?error=forbidden");

  let query = supabase
    .from("machines")
    .select("id, name, reg_no, public_token")
    .is("deleted_at", null)
    .not("status", "in", "(retired,sold)")
    .order("name", { ascending: true });
  if (farmId) query = query.eq("farm_id", farmId);
  if (sp.type) query = query.eq("type", sp.type);
  if (sp.cc) query = query.eq("cost_centre", sp.cc);
  if (sp.dept) query = query.eq("department", sp.dept);
  // Sanitised for the same reason as the list: PostgREST reads `or=(...)` as an expression.
  const qTerm = sp.q ? sanitiseFilterTerm(sp.q) : "";
  if (qTerm) {
    query = query.or(
      `name.ilike.%${qTerm}%,make.ilike.%${qTerm}%,model.ilike.%${qTerm}%,serial_no.ilike.%${qTerm}%,reg_no.ilike.%${qTerm}%`,
    );
  }

  const [{ data }, farmResult] = await Promise.all([
    query,
    farmId
      ? supabase.from("farms").select("settings").eq("id", farmId).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  const machines = ((data as { id: string; name: string; reg_no: string | null; public_token: string | null }[] | null) ?? [])
    .filter((m): m is { id: string; name: string; reg_no: string | null; public_token: string } => !!m.public_token);

  const site = process.env.NEXT_PUBLIC_SITE_URL ?? "";
  const stickers = await Promise.all(
    machines.map(async (m) => ({
      ...m,
      svg: await QRCode.toString(`${site}/m/${m.public_token}`, { type: "svg", margin: 1, width: 176 }),
    })),
  );

  const filtered = !!(sp.type || sp.cc || sp.dept || qTerm);
  const settings = ((farmResult.data as { settings: Record<string, unknown> | null } | null)?.settings ?? {}) as Record<string, unknown>;
  // Onboarding's own acknowledgement, offered here because this is where the stickers
  // are actually printed. Owner/manager only, as the action itself requires.
  const canAcknowledge = (role === "owner" || role === "manager") && !settings.qr_labels_printed_at;

  return (
    <PageContainer size="wide">
      <PageHeader
        title={t("machines.qrSheetTitle", locale)}
        lead={t("machines.qrSheetLead", locale)}
        meta={t("machines.qrSheetCount", locale).replace("{n}", num(stickers.length, 0))}
        back={{ href: backHref(sp.from, "/machines"), label: t("nav.machines", locale) }}
        actions={stickers.length > 0 ? <PrintButton label={t("machines.qrSheetPrint", locale)} /> : undefined}
      />

      {filtered ? (
        <p className="text-sm text-sand-600 print:hidden">
          {t("machines.qrSheetFiltered", locale)}{" "}
          <Link
            href="/machines/qr"
            className="focus-ring inline-flex min-h-[48px] items-center rounded font-medium text-brand-ink underline-offset-2 hover:underline sm:min-h-0"
          >
            {t("machines.qrSheetAll", locale)}
          </Link>
        </p>
      ) : null}

      {stickers.length === 0 ? (
        <EmptyState
          icon={<MachinesIcon />}
          title={t("machines.qrSheetEmpty", locale)}
        />
      ) : (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 print:grid-cols-3 print:gap-3">
          {stickers.map((m) => (
            <li
              key={m.id}
              className="flex min-w-0 break-inside-avoid flex-col items-center rounded-2xl border border-sand-200 bg-surface p-4 text-center shadow-card print:rounded-lg print:border-2 print:border-sand-900 print:bg-white print:p-3 print:shadow-none"
            >
              <p className="max-w-full break-words text-lg font-bold leading-snug text-ink">{m.name}</p>
              {m.reg_no ? <p className="text-sm font-medium tabular-nums text-sand-600">{m.reg_no}</p> : null}
              {/* The SVG is generated here from the machine's token, not user input. */}
              <div
                className="mt-2 w-44 max-w-full [&>svg]:h-auto [&>svg]:w-full"
                dangerouslySetInnerHTML={{ __html: m.svg }}
              />
              <p className="mt-2 text-sm font-medium text-sand-800">{t("qr.scanCaption", locale)}</p>
              <p className="mt-0.5 text-xs text-sand-500">{t("app.name", locale)}</p>
            </li>
          ))}
        </ul>
      )}

      {canAcknowledge && stickers.length > 0 ? (
        <Card className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between print:hidden">
          <p className="text-sm text-sand-600">{t("machines.qrSheetDoneHint", locale)}</p>
          <form action={acknowledgeQrLabels}>
            <SubmitButton variant="secondary">{t("machines.qrSheetDone", locale)}</SubmitButton>
          </form>
        </Card>
      ) : null}
    </PageContainer>
  );
}
