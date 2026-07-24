import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { t } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n";
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
import { PhoneIcon, ChatIcon, MailIcon, LinkIcon } from "@/components/ui/icons";
import { CopyField } from "./copy-field";
import {
  createPartner,
  updatePartner,
  deletePartner,
  adoptSuggested,
  inviteContractor,
  sendLoginUrl,
} from "./actions";

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
  loginUrl?: string;
  linkerror?: string;
  pid?: string;
};

/** Provider-free quick-contact button row (tel / wa.me / mailto). */
function ContactButtons({ p, locale }: { p: Partner; locale: Locale }) {
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
function KindSelect({ locale, value }: { locale: Locale; value?: string }) {
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
  const locale = profile.language;

  const isAdmin = profile.role === "rr_admin";
  const canManage = profile.role === "owner" || profile.role === "manager";
  const canInvite = canManage; // owner/manager connect contractors to their farm

  const supabase = await createClient();
  const { data } = await supabase
    .from("partners")
    .select("id, farm_id, name, kind, phone, whatsapp, email, area, is_suggested, workshop_id, notes")
    .is("deleted_at", null)
    .order("name", { ascending: true });
  const all = (data as Partner[] | null) ?? [];
  const yours = all.filter((p) => p.farm_id != null);
  const suggested = all.filter((p) => p.farm_id == null);

  // A row is editable when it is a farm row the user manages, or a global row and the
  // user is RR admin. (RLS also enforces this on write.)
  const canEditRow = (p: Partner) => (p.farm_id == null ? isAdmin : canManage);

  // Freshly-issued login URL to hand to a contractor (from invite / send-login).
  const loginUrl = sp.loginUrl ?? null;
  const loginPartner = sp.pid ? all.find((p) => p.id === sp.pid) : undefined;
  const loginMsg = t("contact.loginMsg", locale);
  const loginShareText = loginUrl ? `${loginMsg} ${loginUrl}` : "";

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-sand-900">{t("partners.title", locale)}</h1>
        <p className="mt-0.5 text-sm text-sand-500">{t("partners.subtitle", locale)}</p>
      </div>

      <Flash tone="error" message={sp.error} />
      <Flash tone="error" message={sp.linkerror} />
      <Flash tone="success" message={sp.saved ? t("ui.saved", locale) : undefined} />
      <Flash tone="success" message={sp.connected ? t("partners.connectedFlash", locale) : undefined} />

      {/* Freshly generated login URL */}
      {loginUrl ? (
        <Card className="border-brand-200 bg-brand-50/40">
          <CardHeader>
            <CardTitle>
              {t("partners.loginUrlTitle", locale)}
              {loginPartner ? <span className="text-sand-500"> — {loginPartner.name}</span> : null}
            </CardTitle>
          </CardHeader>
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
          </div>
        </Card>
      ) : null}

      {/* Add a partner (owner/manager for their farm; RR admin for the global catalogue) */}
      {canManage || isAdmin ? (
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
            hint={canManage ? t("partners.yoursEmptyHint", locale) : undefined}
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
                    <form action={deletePartner} className="mt-1">
                      <input type="hidden" name="id" value={p.id} />
                      <button className="text-xs text-status-overdue">{t("common.delete", locale)}</button>
                    </form>
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
                {canManage ? (
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
                    <form action={deletePartner} className="mt-1">
                      <input type="hidden" name="id" value={p.id} />
                      <button className="text-xs text-status-overdue">{t("common.delete", locale)}</button>
                    </form>
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
