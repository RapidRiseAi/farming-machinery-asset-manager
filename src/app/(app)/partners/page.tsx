import { requireProfile } from "@/lib/auth";
import { errorMessage } from "@/lib/errors";
import { farmPermissionState } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";
import { t } from "@/lib/i18n";
import type { Lang } from "@/lib/i18n";
import { telHref, waHref, mailtoHref } from "@/lib/contact";
import { partnerMatchKey } from "@/lib/partner-match";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { SubmitButton } from "@/components/ui/submit-button";
import { EmptyState } from "@/components/ui/empty-state";
import { Flash } from "@/components/ui/flash";
import { Disclosure } from "@/components/ui/disclosure";
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { buttonVariants } from "@/components/ui/button";
import { CheckIcon, PhoneIcon, ChatIcon, MailIcon, LinkIcon, PlusIcon, TrashIcon, WarningIcon } from "@/components/ui/icons";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ActionMenu } from "@/components/ui/action-menu";
import { DialogActions, DialogFields, DialogForm } from "@/components/ui/dialog-form";
import { CopyField } from "./copy-field";
import {
  PartnerAccessDialog,
  PartnerAccessSummary,
  PartnerDisconnect,
  type PartnerAccess,
} from "@/components/partners/access-card";
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

/** Every outcome word the actions in ./actions.ts redirect with. */
type SP = {
  error?: string;
  saved?: string;
  added?: string;
  removed?: string;
  already?: string;
  connected?: string;
  sent?: string;
  accepted?: string;
  declined?: string;
  disconnected?: string;
  linkerror?: string;
};

/*
  Call / WhatsApp / Email. On a phone they share one row in equal thirds, icon over the
  word, so a card never wraps them onto two lines; from `sm` up they are ordinary small
  buttons. Hand-built rather than `buttonVariants`, whose `flex-row` and `px-3` cannot be
  overridden through `cn` (it does not de-duplicate conflicting utilities).
*/
const CONTACT_CLASS =
  "inline-flex min-h-[48px] min-w-0 select-none flex-col items-center justify-center gap-0.5 rounded-lg border border-sand-300 bg-surface px-1.5 py-1 text-xs font-medium text-sand-800 shadow-xs transition-colors focus-ring hover:bg-sand-50 active:bg-sand-100 sm:min-h-[36px] sm:flex-row sm:gap-1.5 sm:px-3 sm:text-sm";

/** Provider-free quick-contact buttons (tel / wa.me / mailto). */
function ContactButtons({ p, locale }: { p: Partner; locale: Lang }) {
  const tel = telHref(p.phone);
  const wa = waHref(p.whatsapp ?? p.phone, t("contact.waPrefill", locale));
  const mail = mailtoHref(p.email);
  if (!tel && !wa && !mail) {
    return <p className="text-xs text-sand-500">{t("contact.none", locale)}</p>;
  }
  return (
    <div className="grid auto-cols-fr grid-flow-col gap-2 sm:flex sm:flex-wrap">
      {tel ? (
        <a href={tel} className={CONTACT_CLASS}>
          <PhoneIcon className="shrink-0 text-base" />
          <span className="max-w-full truncate">{t("contact.call", locale)}</span>
        </a>
      ) : null}
      {wa ? (
        <a href={wa} target="_blank" rel="noopener noreferrer" className={CONTACT_CLASS}>
          <ChatIcon className="shrink-0 text-base" />
          <span className="max-w-full truncate">{t("contact.whatsapp", locale)}</span>
        </a>
      ) : null}
      {mail ? (
        <a href={mail} className={CONTACT_CLASS}>
          <MailIcon className="shrink-0 text-base" />
          <span className="max-w-full truncate">{t("contact.email", locale)}</span>
        </a>
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
  const closeLabel = t("ui.close", locale);
  const cancelLabel = t("common.cancel", locale);
  const actionsLabel = t("common.actions", locale);

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
    httpOnly, SameSite=Strict cookie rather than the query string it used to ride in -
    see lib/partner-link.ts for why a magic `action_link` must never touch a URL.
  */
  const pendingLink = await readPartnerLink();
  const loginUrl = pendingLink?.url ?? null;

  /*
    Contractors asking to be connected (F15). A partner who has this farm in their own
    client book can raise a PENDING workshop_link; pending grants nothing, every access
    helper counts only 'active', so this list is the farm deciding, not being told.
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
  // requests above, this is a decision about the site you are looking at.
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

  /*
    What each connected contractor can see now lives on their own directory row, as one
    line, with the switches behind the row's actions. A contractor connected by approving
    THEIR request has a link but no directory row (approval writes no `partners` row), so
    those few get a short list of their own rather than losing their controls.
  */
  const accessByWorkshop = new Map(accessRows.map((a) => [a.workshop_id, a]));
  const listedWorkshops = new Set(yours.map((p) => p.workshop_id).filter(Boolean));
  const unlistedAccess = accessRows.filter((a) => !listedWorkshops.has(a.workshop_id));

  // Suggested rows the farm already copied: no second "Add", see lib/partner-match.ts.
  const yourKeys = new Set(yours.map((p) => partnerMatchKey(p.name, p.phone)));

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

  // One sentence per outcome, each saying what actually happened.
  const success = sp.added
    ? t("partners.addedFlash", locale)
    : sp.removed
      ? t("partners.removedFlash", locale)
      : sp.saved === "access"
        ? t("access.saved", locale)
        : sp.saved
          ? t("ui.saved", locale)
          : sp.connected
            ? t("partners.connectedFlash", locale)
            : sp.sent
              ? t("partners.loginSentFlash", locale)
              : sp.accepted
                ? t("partners.approvedFlash", locale)
                : sp.declined
                  ? t("partners.declinedFlash", locale)
                  : sp.disconnected
                    ? t("access.disconnectedFlash", locale)
                    : undefined;

  // A pending request is the decision on this screen, so it takes the one filled button.
  const addVariant = requests.length > 0 ? "secondary" : "primary";

  const addPartner = canManageDirectory || isAdmin ? (
    <DialogForm
      trigger={t("partners.add", locale)}
      triggerIcon={<PlusIcon />}
      triggerVariant={addVariant}
      title={t("partners.add", locale)}
      description={isAdmin ? t("partners.addHintAdmin", locale) : t("partners.addHint", locale)}
      closeLabel={closeLabel}
    >
      <form action={createPartner}>
        <DialogFields>
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
          <div className="sm:col-span-2">
            <Field label={t("partners.notes", locale)} htmlFor="new_notes">
              <Textarea id="new_notes" name="notes" rows={2} />
            </Field>
          </div>
        </DialogFields>
        <DialogActions cancelLabel={cancelLabel}>
          <SubmitButton variant="primary">{t("partners.add", locale)}</SubmitButton>
        </DialogActions>
      </form>
    </DialogForm>
  ) : null;

  const suggestedList = (
    <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {suggested.map((p) => {
        const alreadyYours = yourKeys.has(partnerMatchKey(p.name, p.phone));
        return (
          <li key={p.id} className="flex min-w-0 flex-col gap-3 rounded-xl border border-sand-200 p-3.5">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 break-words font-semibold text-sand-900">{p.name}</span>
                  <Badge tone="info">{t(`partnerKind.${p.kind}`, locale)}</Badge>
                </div>
                {p.area ? <p className="mt-0.5 text-xs text-sand-500">{p.area}</p> : null}
              </div>
              {/* The RR-curated global catalogue, editable by rr_admin only. Same
                  treatment as a farm's own row, so both look like one product. */}
              {isAdmin && canEditRow(p) ? (
                <ActionMenu title={p.name} label={actionsLabel} closeLabel={closeLabel}>
                  <DialogForm
                    triggerLook="menuItem"
                    trigger={t("common.edit", locale)}
                    title={t("common.edit", locale)}
                    description={p.name}
                    closeLabel={closeLabel}
                  >
                    <form action={updatePartner}>
                      <input type="hidden" name="id" value={p.id} />
                      <DialogFields>
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
                      </DialogFields>
                      <DialogActions cancelLabel={cancelLabel}>
                        <SubmitButton variant="primary">{t("common.save", locale)}</SubmitButton>
                      </DialogActions>
                    </form>
                  </DialogForm>

                  <ConfirmDialog
                    action={deletePartner}
                    triggerLook="menuItem"
                    triggerIcon={<TrashIcon />}
                    triggerLabel={t("common.delete", locale)}
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
                    closeLabel={closeLabel}
                  >
                    <input type="hidden" name="id" value={p.id} />
                  </ConfirmDialog>
                </ActionMenu>
              ) : null}
            </div>
            <ContactButtons p={p} locale={locale} />
            {canManageDirectory && !isAdmin ? (
              alreadyYours ? (
                <p className="flex items-center gap-1.5 text-sm text-sand-500">
                  <CheckIcon className="shrink-0 text-base text-status-ok" aria-hidden />
                  {t("partners.inYourList", locale)}
                </p>
              ) : (
                <form action={adoptSuggested}>
                  <input type="hidden" name="id" value={p.id} />
                  <SubmitButton variant="secondary" size="sm" leftIcon={<PlusIcon />}>
                    {t("partners.adopt", locale)}
                  </SubmitButton>
                </form>
              )
            ) : null}
          </li>
        );
      })}
    </ul>
  );

  return (
    <PageContainer>
      <PageHeader
        title={t("partners.title", locale)}
        lead={t("partners.subtitle", locale)}
        infoKey="partners"
        locale={locale}
        actions={addPartner}
      />

      <Flash tone="error" message={errorMessage(sp.error, locale)} />
      <Flash tone="error" message={sp.linkerror ? t("partners.linkErrorFlash", locale) : undefined} />
      <Flash tone="info" message={sp.already ? t("partners.alreadyFlash", locale) : undefined} />
      <Flash tone="success" message={success} />

      {/* Freshly generated login URL */}
      {loginUrl ? (
        <Card className="border-brand-200 bg-brand-tint/40">
          <CardHeader>
            <CardTitle>
              {loginPartner
                ? t("partners.loginUrlTitleFor", locale).replace("{name}", loginPartner.name)
                : t("partners.loginUrlTitle", locale)}
            </CardTitle>
          </CardHeader>
          <div className="mb-3 flex items-start gap-2.5 rounded-lg border border-status-due/40 bg-callout-warn-bg p-3">
            <WarningIcon className="mt-0.5 shrink-0 text-lg text-status-due" />
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
                <ChatIcon className="text-base" /> {t("partners.loginUrlShareWa", locale)}
              </a>
            ) : null}
            {loginPartner && mailtoHref(loginPartner.email, t("contact.loginSubject", locale), loginShareText) ? (
              <a
                href={mailtoHref(loginPartner.email, t("contact.loginSubject", locale), loginShareText)!}
                className={buttonVariants({ variant: "secondary", size: "sm" })}
              >
                <MailIcon className="text-base" /> {t("partners.loginUrlShareEmail", locale)}
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
                  <span className="min-w-0 break-words font-medium text-sand-900">{r.shop!.trading_name || r.shop!.name}</span>
                  <Badge tone="neutral">{t(`partnerKind.${r.shop!.kind}`, locale)}</Badge>
                  {r.shop!.area ? <span className="text-sm text-sand-500">{r.shop!.area}</span> : null}
                </div>
                <p className="break-words text-sm text-sand-600">
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
                    cancelLabel={cancelLabel}
                    closeLabel={closeLabel}
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

      {/* Your partners */}
      <Card>
        <CardHeader><CardTitle>{t("partners.yours", locale)}</CardTitle></CardHeader>
        {yours.length === 0 ? (
          <EmptyState
            title={t("partners.yoursEmpty", locale)}
            hint={canManageDirectory ? t("partners.yoursEmptyHint", locale) : undefined}
          />
        ) : (
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {yours.map((p) => {
              const access = p.workshop_id ? accessByWorkshop.get(p.workshop_id) : undefined;
              const loginLabel = p.workshop_id ? t("partners.sendLogin", locale) : t("partners.invite", locale);
              return (
                <li key={p.id} className="flex min-w-0 flex-col gap-3 rounded-xl border border-sand-200 p-3.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="min-w-0 break-words font-semibold text-sand-900">{p.name}</span>
                        <Badge tone="neutral">{t(`partnerKind.${p.kind}`, locale)}</Badge>
                        {p.workshop_id ? (
                          <Badge tone="ok">{t("partners.connected", locale)}</Badge>
                        ) : null}
                      </div>
                      {p.area ? <p className="mt-0.5 text-xs text-sand-500">{p.area}</p> : null}
                      {access ? <PartnerAccessSummary access={access} locale={locale} className="mt-1 text-sm text-sand-600" /> : null}
                      {p.notes ? <p className="mt-1 break-words text-sm text-sand-600">{p.notes}</p> : null}
                    </div>

                    {/*
                      Invite, what they can see, edit, remove and disconnect, behind one
                      compact button in the row's title line, titled with the partner.
                      The access switches used to be a card per contractor stacked above
                      this list, so a farm with seven contractors opened on 28 controls.
                    */}
                    {canInvite || canEditRow(p) ? (
                      <ActionMenu title={p.name} label={actionsLabel} closeLabel={closeLabel}>
                        {canInvite ? (
                          <DialogForm
                            triggerLook="menuItem"
                            trigger={loginLabel}
                            triggerIcon={<LinkIcon className="text-base" />}
                            title={loginLabel}
                            description={p.workshop_id ? p.name : t("partners.inviteHint", locale)}
                            closeLabel={closeLabel}
                            size="md"
                          >
                            {/* Two different actions behind one row: a connected partner gets
                                a login link, an unconnected one gets an invitation. */}
                            <form action={p.workshop_id ? sendLoginUrl : inviteContractor}>
                              <input type="hidden" name="id" value={p.id} />
                              <DialogFields columns={1}>
                                <Field label={t("partners.inviteEmail", locale)} htmlFor={`iv_${p.id}`}>
                                  <Input id={`iv_${p.id}`} name="email" type="email" defaultValue={p.email ?? ""} required />
                                </Field>
                              </DialogFields>
                              <DialogActions cancelLabel={cancelLabel}>
                                <SubmitButton variant="primary" leftIcon={<LinkIcon className="text-base" />}>
                                  {loginLabel}
                                </SubmitButton>
                              </DialogActions>
                            </form>
                          </DialogForm>
                        ) : null}

                        {access ? (
                          <PartnerAccessDialog access={access} locale={locale} closeLabel={closeLabel} cancelLabel={cancelLabel} />
                        ) : null}

                        {canEditRow(p) ? (
                          <DialogForm
                            triggerLook="menuItem"
                            trigger={t("common.edit", locale)}
                            title={t("common.edit", locale)}
                            description={p.name}
                            closeLabel={closeLabel}
                          >
                            <form action={updatePartner}>
                              <input type="hidden" name="id" value={p.id} />
                              <DialogFields>
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
                                <div className="sm:col-span-2">
                                  <Field label={t("partners.notes", locale)} htmlFor={`e_notes_${p.id}`}>
                                    <Textarea id={`e_notes_${p.id}`} name="notes" rows={2} defaultValue={p.notes ?? ""} />
                                  </Field>
                                </div>
                              </DialogFields>
                              <DialogActions cancelLabel={cancelLabel}>
                                <SubmitButton variant="primary">{t("common.save", locale)}</SubmitButton>
                              </DialogActions>
                            </form>
                          </DialogForm>
                        ) : null}

                        {access ? (
                          <PartnerDisconnect access={access} locale={locale} closeLabel={closeLabel} />
                        ) : null}

                        {canEditRow(p) ? (
                          <ConfirmDialog
                            action={deletePartner}
                            triggerLook="menuItem"
                            triggerIcon={<TrashIcon />}
                            triggerLabel={t("common.delete", locale)}
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
                            closeLabel={closeLabel}
                          >
                            <input type="hidden" name="id" value={p.id} />
                          </ConfirmDialog>
                        ) : null}
                      </ActionMenu>
                    ) : null}
                  </div>

                  <ContactButtons p={p} locale={locale} />
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {/* Connected through their own request, so not (yet) in the directory above. */}
      {unlistedAccess.length > 0 ? (
        <Card>
          <CardHeader><CardTitle>{t("partners.connectedOthers", locale)}</CardTitle></CardHeader>
          <p className="mb-3 text-sm text-sand-600">{t("partners.connectedOthersHint", locale)}</p>
          <ul className="flex flex-col divide-y divide-sand-100">
            {unlistedAccess.map((a) => (
              <li key={a.workshop_id} className="flex items-start justify-between gap-2 py-2.5 first:pt-0 last:pb-0">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 break-words font-semibold text-sand-900">{a.name}</span>
                    <Badge tone="ok">{t("partners.connected", locale)}</Badge>
                  </div>
                  <PartnerAccessSummary access={a} locale={locale} className="mt-1 text-sm text-sand-600" />
                </div>
                <ActionMenu title={a.name} label={actionsLabel} closeLabel={closeLabel}>
                  <PartnerAccessDialog access={a} locale={locale} closeLabel={closeLabel} cancelLabel={cancelLabel} />
                  <PartnerDisconnect access={a} locale={locale} closeLabel={closeLabel} />
                </ActionMenu>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {/* Suggested partners (RR-curated, global). Once the farm has its own list these
          are a reference shelf, not the screen, so they fold away under a count. */}
      {yours.length > 0 && suggested.length > 0 ? (
        <Disclosure
          summary={t("partners.suggestedCount", locale).replace("{n}", String(suggested.length))}
        >
          {suggestedList}
        </Disclosure>
      ) : (
        <Card>
          <CardHeader><CardTitle>{t("partners.suggested", locale)}</CardTitle></CardHeader>
          {suggested.length === 0 ? (
            <EmptyState title={t("partners.suggestedEmpty", locale)} />
          ) : (
            suggestedList
          )}
        </Card>
      )}
    </PageContainer>
  );
}
