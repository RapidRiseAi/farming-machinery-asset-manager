import { requireProfile } from "@/lib/auth";
import { farmPermissionState } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";
import { t } from "@/lib/i18n";
import { PageInfoButton } from "@/components/ui/page-info-button";
import type { Locale, Lang } from "@/lib/i18n";
import { telHref, waHref, mailtoHref } from "@/lib/contact";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { SubmitButton } from "@/components/ui/submit-button";
import { EmptyState } from "@/components/ui/empty-state";
import { Flash } from "@/components/ui/flash";
import { buttonVariants } from "@/components/ui/button";
import { PhoneIcon, ChatIcon, MailIcon, LinkIcon, TrashIcon, WarningIcon } from "@/components/ui/icons";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { CopyField } from "./copy-field";
import { PartnerAccessCard, type PartnerAccess } from "@/components/partners/access-card";
import { readPartnerLink } from "@/lib/partner-link";
import {
  createPartner,
  updatePartner,
  deletePartner,
  dismissLoginUrl,
  adoptSuggested,
  inviteContractor,
  sendLoginUrl,
  approveLinkRequest,
  declineLinkRequest,
} from "./actions";

type WorkshopBrief = {
  id: string;
  name: string;
  trading_name: string | null;
  kind: string;
  phone: string | null;
  whatsapp: string | null;
  email: string | null;
  area: string | null;
};

const KINDS = [
  "mechanic", "auto_electrician", "parts_supplier",
  "panel_beater", "tyre", "towing", "other",
] as const;

type Partner = {
  id: string;
  farm_id: string | null;
  name: string;
  kind: string;
  phone: string | null;
  whatsapp: string | null;
  email: string | null;
  area: string | null;
  is_suggested: boolean;
  workshop_id: string | null;
  notes: string | null;
};

type SP = {
  error?: string;
  saved?: string;
  connected?: string;
  linkerror?: string;
  pid?: string;
  access?: string;
  declined?: string;
  disconnected?: string;
};

/** Provider-free quick-contact button row (tel / wa.me / mailto). */
function ContactButtons({ p, locale }: { p: Partner; locale: Lang }) {
  const tel = telHref(p.phone);
  const wa = waHref(p.whatsapp ?? p.phone, t("contact.waPrefill", locale));
  const mail = mailtoHref(p.email);
  const cls = buttonVariants({ variant: "secondary", size: "sm" });
  return (
    <div className="flex flex-wrap gap-2">
      {tel ? (
        <a href={tel} className={cls}>
          <PhoneIcon className="text-[1.05rem]" /> {t("contact.call", locale)}
        </a>
      ) : null}
      {wa ? (
        <a href={wa} target="_blank" rel="noopener noreferrer" className={cls}>
          <ChatIcon className="text-[1.05rem]" /> {t("contact.whatsapp", locale)}
        </a>
      ) : null}
      {mail ? (
        <a href={mail} className={cls}>
          <MailIcon className="text-[1.05rem]" /> {t("contact.email", locale)}
        </a>
      ) : null}
      {!tel && !wa && !mail ? (
        <span className="text-xs text-sand-400">{t("contact.none", locale)}</span>
      ) : null}
    </div>
  );
}

/** The add / edit form fields (shared markup). */
function KindSelect({ locale, value }: { locale: Lang; value?: string }) {
  return (
    <Select name="kind" defaultValue={value ?? "other"}>
      {KINDS.map((k) => (
        <option key={k} value={k}>
          {t(`partnerKind.${k}`, locale)}
        </option>
      ))}
    </Select>
  );
}

export default async function PartnersPage({ searchParams }: { searchParams: Promise<SP> }) {
  const profile = await requireProfile();
  const sp = await searchParams;
  const locale = profile.lang;

  const permissionState = await farmPermissionState(profile);
  const viewingFarmId = permissionState.farmId;
  const selectedRole = permissionState.role;
  const isAdmin = profile.role === "rr_admin";
  const canManageDirectory = permissionState.allows("manage_partners");
  // Connecting a contractor opens broader farm data and remains owner/manager-only.
  const canInvite = selectedRole === "owner" || selectedRole === "manager";

  const supabase = await createClient();
  let partnersQuery = supabase
    .from("partners")
    .select("id, farm_id, name, kind, phone, whatsapp, email, area, is_suggested, workshop_id, notes")
    .is("deleted_at", null)
    .order("name", { ascending: true });
  partnersQuery = viewingFarmId
    ? partnersQuery.or(`farm_id.is.null,farm_id.eq.${viewingFarmId}`)
    : partnersQuery.is("farm_id", null);
  const { data } = await partnersQuery;
  const all = (data as Partner[] | null) ?? [];
  const yours = all.filter((p) => p.farm_id === viewingFarmId);
  const suggested = all.filter((p) => p.farm_id == null);

  // A row is editable when it is a farm row the user manages, or a global row and the
  // user is RR admin. (RLS also enforces this on write.)
  const canEditRow = (p: Partner) =>
    p.farm_id == null ? isAdmin : canManageDirectory && p.farm_id === viewingFarmId;

  /*
    Freshly-issued login URL to hand to a contractor. It arrives in a short-lived,
    httpOnly, SameSite=Strict cookie rather than the query string it used to ride in —
    see lib/partner-link.ts for why a magic `action_link` must never touch a URL.
  */
  const pendingLink = await readPartnerLink();
  const loginUrl = pendingLink?.url ?? null;

  /*
    Contractors asking to be connected (F15). A partner who has this farm in their own
    client book can raise a PENDING workshop_link; pending grants nothing — every access
    helper counts only 'active' — so this list is the farm deciding, not being told.
  */
  /*
    Scoped to the farm being VIEWED, not the primary one. With multi-site (F7) an
    owner may be looking at a second farm while `profile.farm_id` still points at their
    first; RLS returns pending links for every farm they can reach, so without this
    filter a request for another site would render as actionable here and the approval
    would write against the wrong farm.
  */
  const { data: reqData } = canInvite && viewingFarmId
    ? await supabase
        .from("workshop_links")
        .select("workshop_id, farm_id, status, created_at, workshops(id, name, trading_name, kind, phone, whatsapp, email, area)")
        .eq("status", "pending")
        .eq("farm_id", viewingFarmId)
        .is("deleted_at", null)
    : { data: null };

  // Connected contractors and what each may see (F16). Same farm scoping as the
  // requests above — this is a decision about the site you are looking at.
  const { data: accessData } = canInvite && viewingFarmId
    ? await supabase
        .from("workshop_links")
        .select("workshop_id, farm_id, see_all_vehicles, see_service_history, see_costs, see_team, workshops(id, name, trading_name)")
        .eq("status", "active")
        .eq("farm_id", viewingFarmId)
        .is("deleted_at", null)
    : { data: null };

  const accessRows: PartnerAccess[] = ((accessData ?? []) as unknown as {
    workshop_id: string; farm_id: string;
    see_all_vehicles: boolean; see_service_history: boolean; see_costs: boolean; see_team: boolean;
    workshops: { name: string; trading_name: string | null } | { name: string; trading_name: string | null }[] | null;
  }[]).map((r) => {
    const w = Array.isArray(r.workshops) ? (r.workshops[0] ?? null) : r.workshops;
    return {
      workshop_id: r.workshop_id,
      farm_id: r.farm_id,
      name: w?.trading_name || w?.name || "",
      see_all_vehicles: r.see_all_vehicles,
      see_service_history: r.see_service_history,
      see_costs: r.see_costs,
      see_team: r.see_team,
    };
  }).filter((r) => r.name);

  const requests = ((reqData ?? []) as unknown as {
    workshop_id: string;
    farm_id: string;
    created_at: string;
    workshops: WorkshopBrief | WorkshopBrief[] | null;
  }[])
    .map((r) => ({
      workshop_id: r.workshop_id,
      farm_id: r.farm_id,
      created_at: r.created_at,
      shop: Array.isArray(r.workshops) ? (r.workshops[0] ?? null) : r.workshops,
    }))
    .filter((r) => r.shop);
  const loginPartner = pendingLink?.pid ? all.find((p) => p.id === pendingLink.pid) : undefined;
  const loginMsg = t("contact.loginMsg", locale);
  const loginShareText = loginUrl ? `${loginMsg} ${loginUrl}` : "";

  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="text-2xl font-bold tracking-tight text-sand-900">{t("partners.title", locale)}</h1>
          <PageInfoButton infoKey="partners" locale={locale} />
        </div>
        <p className="mt-0.5 text-sm text-sand-500">{t("partners.subtitle", locale)}</p>
      </div>

      <Flash tone="error" message={sp.error} />
      <Flash tone="error" message={sp.linkerror} />
      <Flash tone="success" message={sp.saved ? t("ui.saved", locale) : undefined} />
      <Flash tone="success" message={sp.connected ? t("partners.connectedFlash", locale) : undefined} />
      <Flash tone="success" message={sp.access ? t("access.saved", locale) : undefined} />
      <Flash tone="success" message={sp.disconnected ? t("access.disconnect", locale) : undefined} />

      {/* Freshly generated login URL */}
      {loginUrl ? (
        <Card className="border-brand-200 bg-brand-50/40">
          <CardHeader>
            <CardTitle>
              {t("partners.loginUrlTitle", locale)}
              {loginPartner ? <span className="text-sand-500"> — {loginPartner.name}</span> : null}
            </CardTitle>
          </CardHeader>
          <div className="mb-3 flex items-start gap-2.5 rounded-lg border border-status-due/40 bg-amber-50 p-3">
            <WarningIcon className="mt-0.5 shrink-0 text-[1.15rem] text-status-due" />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-sand-900">{t("partners.loginUrlWarnTitle", locale)}</p>
              <p className="mt-0.5 text-sm leading-relaxed text-sand-700">
                {t("partners.loginUrlWarn", locale).replace("{name}", loginPartner?.name ?? t("partners.thisContractor", locale))}
              </p>
            </div>
          </div>
          <p className="mb-3 text-sm text-sand-600">{t("partners.loginUrlHint", locale)}</p>
          <CopyField value={loginUrl} copyLabel={t("partners.copy", locale)} copiedLabel={t("partners.copied", locale)} />
          <div className="mt-3 flex flex-wrap gap-2">
            {loginPartner && waHref(loginPartner.whatsapp ?? loginPartner.phone, loginShareText) ? (
              <a
                href={waHref(loginPartner.whatsapp ?? loginPartner.phone, loginShareText)!}
                target="_blank"
                rel="noopener noreferrer"
                className={buttonVariants({ variant: "secondary", size: "sm" })}
              >
                <ChatIcon className="text-[1.05rem]" /> {t("partners.loginUrlShareWa", locale)}
              </a>
            ) : null}
            {loginPartner && mailtoHref(loginPartner.email, t("contact.loginSubject", locale), loginShareText) ? (
              <a
                href={mailtoHref(loginPartner.email, t("contact.loginSubject", locale), loginShareText)!}
                className={buttonVariants({ variant: "secondary", size: "sm" })}
              >
                <MailIcon className="text-[1.05rem]" /> {t("partners.loginUrlShareEmail", locale)}
              </a>
            ) : null}
            <form action={dismissLoginUrl}>
              <SubmitButton variant="ghost">{t("partners.loginUrlDone", locale)}</SubmitButton>
            </form>
          </div>
        </Card>
      ) : null}

      {/* A contractor is asking to be connected (F15). Approving hands them real access
          to this farm's vehicles and jobs, so it is stated plainly and confirmed. */}
      {requests.length > 0 ? (
        <Card>
          <CardHeader><CardTitle>{t("partners.requestsTitle", locale)}</CardTitle></CardHeader>
          <p className="mb-3 text-sm text-sand-600">{t("partners.requestsHint", locale)}</p>
          <ul className="flex flex-col gap-3">
            {requests.map((r) => (
              <li key={r.workshop_id} className="flex flex-col gap-2 rounded-xl border border-sand-200 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-sand-900">{r.shop!.trading_name || r.shop!.name}</span>
                  <Badge tone="neutral">{t(`partnerKind.${r.shop!.kind}`, locale)}</Badge>
                  {r.shop!.area ? <span className="text-sm text-sand-500">{r.shop!.area}</span> : null}
                </div>
                <p className="text-sm text-sand-600">
                  {[r.shop!.phone ?? r.shop!.whatsapp, r.shop!.email].filter(Boolean).join(" · ")}
                </p>
                <div className="flex flex-wrap gap-2">
                  <ConfirmDialog
                    action={approveLinkRequest}
                    triggerLabel={t("partners.approveRequest", locale)}
                    triggerVariant="primary"
                    triggerSize="sm"
                    title={t("partners.approveTitle", locale)}
                    intro={t("partners.approveBody", locale).replace("{name}", r.shop!.trading_name || r.shop!.name)}
                    consequences={[
                      t("partners.approveConsequence1", locale),
                      t("partners.approveConsequence2", locale),
                    ]}
                    footnote={t("partners.approveFootnote", locale)}
                    confirmLabel={t("partners.approveRequest", locale)}
                    cancelLabel={t("common.cancel", locale)}
                    closeLabel={t("ui.close", locale)}
                    tone="brand"
                  >
                    <input type="hidden" name="workshop_id" value={r.workshop_id} />
                    <input type="hidden" name="farm_id" value={r.farm_id} />
                  </ConfirmDialog>
                  <form action={declineLinkRequest}>
                    <input type="hidden" name="workshop_id" value={r.workshop_id} />
                    <input type="hidden" name="farm_id" value={r.farm_id} />
                    <SubmitButton variant="secondary" size="sm">{t("partners.declineRequest", locale)}</SubmitButton>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {/* What each connected contractor can see (F16). Placed above the directory
          because it is the decision with consequences on this screen. */}
      {accessRows.length > 0 ? (
        <div className="flex flex-col gap-3">
          {accessRows.map((a) => (
            <PartnerAccessCard key={a.workshop_id} access={a} locale={locale} />
          ))}
        </div>
      ) : null}

      {/* Add a partner (owner/manager for their farm; RR admin for the global catalogue) */}
      {canManageDirectory || isAdmin ? (
        <Card>
          <details>
            <summary className="cursor-pointer font-semibold text-sand-900">{t("partners.add", locale)}</summary>
            <p className="mt-1 text-sm text-sand-500">
              {isAdmin ? t("partners.addHintAdmin", locale) : t("partners.addHint", locale)}
            </p>
            <form action={createPartner} className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Field label={t("partners.name", locale)} htmlFor="new_name">
                <Input id="new_name" name="name" required placeholder={t("partners.namePlaceholder", locale)} />
              </Field>
              <Field label={t("partners.kind", locale)} htmlFor="new_kind">
                <KindSelect locale={locale} />
              </Field>
              <Field label={t("partners.area", locale)} htmlFor="new_area">
                <Input id="new_area" name="area" placeholder={t("partners.areaPlaceholder", locale)} />
              </Field>
              <Field label={t("partners.phone", locale)} htmlFor="new_phone">
                <Input id="new_phone" name="phone" inputMode="tel" placeholder="082 555 0134" />
              </Field>
              <Field label={t("partners.whatsapp", locale)} htmlFor="new_wa">
                <Input id="new_wa" name="whatsapp" inputMode="tel" placeholder="+27 82 555 0134" />
              </Field>
              <Field label={t("partners.email", locale)} htmlFor="new_email">
                <Input id="new_email" name="email" type="email" inputMode="email" />
              </Field>
              <div className="sm:col-span-2 lg:col-span-3">
                <Field label={t("partners.notes", locale)} htmlFor="new_notes">
                  <Textarea id="new_notes" name="notes" rows={2} />
                </Field>
              </div>
              <div className="sm:col-span-2 lg:col-span-3">
                <SubmitButton variant="primary" size="sm">{t("partners.add", locale)}</SubmitButton>
              </div>
            </form>
          </details>
        </Card>
      ) : null}

      {/* Your partners */}
      <Card>
        <CardHeader><CardTitle>{t("partners.yours", locale)}</CardTitle></CardHeader>
        {yours.length === 0 ? (
          <EmptyState
            title={t("partners.yoursEmpty", locale)}
            hint={canManageDirectory ? t("partners.yoursEmptyHint", locale) : undefined}
          />
        ) : (
          <ul className="flex flex-col gap-3">
            {yours.map((p) => (
              <li key={p.id} className="rounded-xl border border-sand-200 p-3.5">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-sand-900">{p.name}</span>
                      <Badge tone="neutral">{t(`partnerKind.${p.kind}`, locale)}</Badge>
                      {p.workshop_id ? (
                        <Badge tone="ok">{t("partners.connected", locale)}</Badge>
                      ) : (
                        <Badge tone="neutral">{t("partners.notConnected", locale)}</Badge>
                      )}
                    </div>
                    {p.area ? <p className="mt-0.5 text-xs text-sand-500">{p.area}</p> : null}
                    {p.notes ? <p className="mt-1 text-sm text-sand-600">{p.notes}</p> : null}
                  </div>
                </div>

                <div className="mt-3">
                  <ContactButtons p={p} locale={locale} />
                </div>

                {/* Invite / connect + send login (owner/manager) */}
                {canInvite ? (
                  <div className="mt-3 border-t border-sand-100 pt-3">
                    {p.workshop_id ? (
                      <form action={sendLoginUrl} className="flex flex-wrap items-end gap-2">
                        <input type="hidden" name="id" value={p.id} />
                        <Field label={t("partners.inviteEmail", locale)} htmlFor={`si_${p.id}`}>
                          <Input id={`si_${p.id}`} name="email" type="email" defaultValue={p.email ?? ""} className="w-56" required />
                        </Field>
                        <SubmitButton variant="secondary" size="sm" leftIcon={<LinkIcon className="text-[1.05rem]" />}>
                          {t("partners.sendLogin", locale)}
                        </SubmitButton>
                      </form>
                    ) : (
                      <details>
                        <summary className="cursor-pointer text-sm font-medium text-brand-700">
                          {t("partners.invite", locale)}
                        </summary>
                        <p className="mt-1 text-xs text-sand-500">{t("partners.inviteHint", locale)}</p>
                        <form action={inviteContractor} className="mt-2 flex flex-wrap items-end gap-2">
                          <input type="hidden" name="id" value={p.id} />
                          <Field label={t("partners.inviteEmail", locale)} htmlFor={`iv_${p.id}`}>
                            <Input id={`iv_${p.id}`} name="email" type="email" defaultValue={p.email ?? ""} className="w-56" required />
                          </Field>
                          <SubmitButton variant="primary" size="sm" leftIcon={<LinkIcon className="text-[1.05rem]" />}>
                            {t("partners.invite", locale)}
                          </SubmitButton>
                        </form>
                      </details>
                    )}
                  </div>
                ) : null}

                {/* Edit / remove (owner/manager) */}
                {canEditRow(p) ? (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs font-medium text-sand-500">{t("common.edit", locale)}</summary>
                    <form action={updatePartner} className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                      <input type="hidden" name="id" value={p.id} />
                      <Field label={t("partners.name", locale)} htmlFor={`e_name_${p.id}`}>
                        <Input id={`e_name_${p.id}`} name="name" defaultValue={p.name} required />
                      </Field>
                      <Field label={t("partners.kind", locale)} htmlFor={`e_kind_${p.id}`}>
                        <KindSelect locale={locale} value={p.kind} />
                      </Field>
                      <Field label={t("partners.area", locale)} htmlFor={`e_area_${p.id}`}>
                        <Input id={`e_area_${p.id}`} name="area" defaultValue={p.area ?? ""} />
                      </Field>
                      <Field label={t("partners.phone", locale)} htmlFor={`e_phone_${p.id}`}>
                        <Input id={`e_phone_${p.id}`} name="phone" inputMode="tel" defaultValue={p.phone ?? ""} />
                      </Field>
                      <Field label={t("partners.whatsapp", locale)} htmlFor={`e_wa_${p.id}`}>
                        <Input id={`e_wa_${p.id}`} name="whatsapp" inputMode="tel" defaultValue={p.whatsapp ?? ""} />
                      </Field>
                      <Field label={t("partners.email", locale)} htmlFor={`e_email_${p.id}`}>
                        <Input id={`e_email_${p.id}`} name="email" type="email" defaultValue={p.email ?? ""} />
                      </Field>
                      <div className="sm:col-span-2 lg:col-span-3">
                        <Field label={t("partners.notes", locale)} htmlFor={`e_notes_${p.id}`}>
                          <Textarea id={`e_notes_${p.id}`} name="notes" rows={2} defaultValue={p.notes ?? ""} />
                        </Field>
                      </div>
                      <div className="flex items-center gap-3 sm:col-span-2 lg:col-span-3">
                        <SubmitButton variant="secondary" size="sm">{t("common.save", locale)}</SubmitButton>
                        <span className="flex-1" />
                      </div>
                    </form>
                    <div className="mt-1">
                      <ConfirmDialog
                        action={deletePartner}
                        triggerVariant="ghost"
                        triggerSize="sm"
                        triggerIcon={<TrashIcon />}
                        triggerLabel={t("common.delete", locale)}
                        triggerClassName="text-status-overdue hover:bg-red-50"
                        title={t("confirm.deletePartnerTitle", locale).replace("{partner}", p.name)}
                        intro={t("confirm.deletePartnerIntro", locale)}
                        consequencesTitle={t("confirm.whatHappens", locale)}
                        consequences={[
                          t("confirm.deletePartnerEffect1", locale),
                          t("confirm.deletePartnerEffect2", locale),
                        ]}
                        footnote={t("confirm.softDeleteNote", locale)}
                        confirmLabel={t("confirm.deletePartnerYes", locale)}
                        cancelLabel={t("confirm.keepIt", locale)}
                        closeLabel={t("ui.close", locale)}
                      >
                        <input type="hidden" name="id" value={p.id} />
                      </ConfirmDialog>
                    </div>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* Suggested partners (RR-curated, global) */}
      <Card>
        <CardHeader><CardTitle>{t("partners.suggested", locale)}</CardTitle></CardHeader>
        {suggested.length === 0 ? (
          <EmptyState title={t("partners.suggestedEmpty", locale)} />
        ) : (
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {suggested.map((p) => (
              <li key={p.id} className="rounded-xl border border-sand-200 p-3.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-sand-900">{p.name}</span>
                  <Badge tone="info">{t(`partnerKind.${p.kind}`, locale)}</Badge>
                </div>
                {p.area ? <p className="mt-0.5 text-xs text-sand-500">{p.area}</p> : null}
                <div className="mt-3">
                  <ContactButtons p={p} locale={locale} />
                </div>
                {canManageDirectory && !isAdmin ? (
                  <form action={adoptSuggested} className="mt-3">
                    <input type="hidden" name="id" value={p.id} />
                    <SubmitButton variant="secondary" size="sm">{t("partners.adopt", locale)}</SubmitButton>
                  </form>
                ) : null}
                {isAdmin && canEditRow(p) ? (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs font-medium text-sand-500">{t("common.edit", locale)}</summary>
                    <form action={updatePartner} className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                      <input type="hidden" name="id" value={p.id} />
                      <Field label={t("partners.name", locale)} htmlFor={`g_name_${p.id}`}>
                        <Input id={`g_name_${p.id}`} name="name" defaultValue={p.name} required />
                      </Field>
                      <Field label={t("partners.kind", locale)} htmlFor={`g_kind_${p.id}`}>
                        <KindSelect locale={locale} value={p.kind} />
                      </Field>
                      <Field label={t("partners.area", locale)} htmlFor={`g_area_${p.id}`}>
                        <Input id={`g_area_${p.id}`} name="area" defaultValue={p.area ?? ""} />
                      </Field>
                      <Field label={t("partners.phone", locale)} htmlFor={`g_phone_${p.id}`}>
                        <Input id={`g_phone_${p.id}`} name="phone" inputMode="tel" defaultValue={p.phone ?? ""} />
                      </Field>
                      <Field label={t("partners.whatsapp", locale)} htmlFor={`g_wa_${p.id}`}>
                        <Input id={`g_wa_${p.id}`} name="whatsapp" inputMode="tel" defaultValue={p.whatsapp ?? ""} />
                      </Field>
                      <Field label={t("partners.email", locale)} htmlFor={`g_email_${p.id}`}>
                        <Input id={`g_email_${p.id}`} name="email" type="email" defaultValue={p.email ?? ""} />
                      </Field>
                      <div className="sm:col-span-2">
                        <SubmitButton variant="secondary" size="sm">{t("common.save", locale)}</SubmitButton>
                      </div>
                    </form>
                    <div className="mt-1">
                      <ConfirmDialog
                        action={deletePartner}
                        triggerVariant="ghost"
                        triggerSize="sm"
                        triggerIcon={<TrashIcon />}
                        triggerLabel={t("common.delete", locale)}
                        triggerClassName="text-status-overdue hover:bg-red-50"
                        title={t("confirm.deletePartnerTitle", locale).replace("{partner}", p.name)}
                        intro={t("confirm.deletePartnerIntro", locale)}
                        consequencesTitle={t("confirm.whatHappens", locale)}
                        consequences={[
                          t("confirm.deletePartnerEffect1", locale),
                          t("confirm.deletePartnerEffect2", locale),
                        ]}
                        footnote={t("confirm.softDeleteNote", locale)}
                        confirmLabel={t("confirm.deletePartnerYes", locale)}
                        cancelLabel={t("confirm.keepIt", locale)}
                        closeLabel={t("ui.close", locale)}
                      >
                        <input type="hidden" name="id" value={p.id} />
                      </ConfirmDialog>
                    </div>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
