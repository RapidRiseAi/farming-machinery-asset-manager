import Link from "next/link";
import { redirect } from "next/navigation";
import { errorMessage } from "@/lib/errors";
import { homePathFor, requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import {
  farmPermissionState,
  roleHasBaselinePermission,
  USER_PERMISSIONS,
  type UserPermission,
} from "@/lib/permissions";
import { t } from "@/lib/i18n";
import { inviteUser, setUserActive, erasePerson, setUserPermissions } from "./actions";
import { Card } from "@/components/ui/card";
import { Table, Thead, Tbody, Tr, Th, Td } from "@/components/ui/table";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { SubmitButton } from "@/components/ui/submit-button";
import { Flash } from "@/components/ui/flash";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ActionMenu } from "@/components/ui/action-menu";
import { Disclosure } from "@/components/ui/disclosure";
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { menuItemClass } from "@/components/ui/menu-item";
import { ChevronRightIcon, DownloadIcon, KeyIcon, PlusIcon, TrashIcon } from "@/components/ui/icons";
import { DialogActions, DialogFields, DialogForm } from "@/components/ui/dialog-form";
import { roleLabel } from "@/lib/format";

type TeamUser = {
  id: string;
  name: string;
  role: "owner" | "manager" | "mechanic" | "operator";
  email: string | null;
  active: boolean;
  primaryFarmId: string | null;
  isPrimaryMember: boolean;
  grants: ReadonlySet<UserPermission>;
};

/**
 * Something non-empty to name a person by. An already-erased profile has a blank name,
 * and the erase dialog's type-to-confirm must never resolve to the empty string, that
 * would leave the irreversible action unlocked from the moment it opens.
 */
function personLabel(u: TeamUser): string {
  return u.name.trim() || u.email?.trim() || u.id.slice(0, 8);
}

/** Owner first, then down the farm: who runs it before who drives for it. */
const ROLE_ORDER: Record<TeamUser["role"], number> = { owner: 0, manager: 1, mechanic: 2, operator: 3 };

export default async function TeamPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; invited?: string; saved?: string; erased?: string; permissionSaved?: string }>;
}) {
  const profile = await requireProfile();
  if (profile.role === "rr_admin") redirect("/admin/farms");
  const locale = profile.lang;
  const closeLabel = t("ui.close", locale);
  const cancelLabel = t("common.cancel", locale);
  const sp = await searchParams;

  const permissionState = await farmPermissionState(profile);
  const farmId = permissionState.farmId;
  const canManage = permissionState.role === "owner" || permissionState.role === "manager";
  if (!farmId || !canManage) redirect(`${homePathFor(profile.role)}?denied=1`);

  const supabase = await createClient();
  const [{ data: primaryData }, { data: membershipData }, { data: grantData }, { data: farmData }] = await Promise.all([
    supabase
      .from("users")
      .select("id")
      .eq("farm_id", farmId)
      .is("deleted_at", null),
    supabase
      .from("user_farm_memberships")
      .select("user_id, role, active")
      .eq("farm_id", farmId)
      .is("deleted_at", null),
    supabase
      .from("user_permission_grants")
      .select("user_id, permission")
      .eq("farm_id", farmId)
      .is("deleted_at", null),
    supabase.from("farms").select("settings").eq("id", farmId).maybeSingle(),
  ]);

  // The farm's "language for new people" (/settings). Read the way lib/settings.ts
  // stores it: anything but "en" is Afrikaans, which is also what /settings shows unset.
  const farmSettings = ((farmData as { settings?: Record<string, unknown> } | null)?.settings ?? {});
  const inviteLanguage = farmSettings.default_language === "en" ? "en" : "af";

  const primaryIds = new Set(((primaryData ?? []) as { id: string }[]).map((row) => row.id));
  const memberships = (membershipData ?? []) as {
    user_id: string;
    role: TeamUser["role"];
    active: boolean;
  }[];
  const membershipByUser = new Map(memberships.map((row) => [row.user_id, row]));
  const candidateIds = [...new Set([...primaryIds, ...memberships.map((row) => row.user_id)])];

  /*
   * `users.farm_id` is only the PRIMARY farm. Its RLS policy cannot expose a person whose
   * primary farm is elsewhere merely because this farm has a membership row for them.
   * First derive the exact IDs through RLS above, then use the server credential only for
   * those IDs. This is a bounded join, never a cross-tenant directory scan.
   */
  const service = createServiceClient();
  const { data: profileData } = candidateIds.length
    ? await service
        .from("users")
        .select("id, farm_id, name, role, email, active")
        .in("id", candidateIds)
        .is("deleted_at", null)
    : { data: [] };

  const grantsByUser = new Map<string, Set<UserPermission>>();
  for (const row of (grantData ?? []) as { user_id: string; permission: unknown }[]) {
    if (!(USER_PERMISSIONS as readonly unknown[]).includes(row.permission)) continue;
    const set = grantsByUser.get(row.user_id) ?? new Set<UserPermission>();
    set.add(row.permission as UserPermission);
    grantsByUser.set(row.user_id, set);
  }

  const users = ((profileData ?? []) as {
    id: string;
    farm_id: string | null;
    name: string;
    role: TeamUser["role"];
    email: string | null;
    active: boolean;
  }[])
    .map((row): TeamUser | null => {
      const membership = membershipByUser.get(row.id);
      const isPrimaryMember = row.farm_id === farmId;
      const selectedRole = membership?.active
        ? membership.role
        : isPrimaryMember
          ? row.role
          : membership?.role;
      if (!selectedRole) return null;
      return {
        id: row.id,
        name: row.name,
        role: selectedRole,
        email: row.email,
        active: row.active && (isPrimaryMember || Boolean(membership?.active)),
        primaryFarmId: row.farm_id,
        isPrimaryMember,
        grants: grantsByUser.get(row.id) ?? new Set<UserPermission>(),
      };
    })
    .filter((row): row is TeamUser => row != null)
    .sort((a, b) => (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9) || a.name.localeCompare(b.name));

  const success = sp.invited
    ? t("team.invited", locale)
    : sp.erased
      ? t("privacy.erased", locale)
      : sp.permissionSaved
        ? t("permissions.saved", locale)
        : sp.saved === "deactivated"
          ? t("team.deactivatedFlash", locale)
          : sp.saved === "activated"
            ? t("team.activatedFlash", locale)
            : sp.saved
              ? t("ui.saved", locale)
              : undefined;

  // Inviting somebody is a card of four fields that was open on a page whose job is
  // to show you who is on the farm and what they may do.
  const invite = canManage ? (
    <DialogForm
      trigger={t("team.invite", locale)}
      triggerIcon={<PlusIcon />}
      title={t("team.invite", locale)}
      closeLabel={closeLabel}
    >
      <form action={inviteUser}>
        <input type="hidden" name="back" value="/team" />
        <DialogFields>
          <Field label={t("team.name", locale)} htmlFor="inv-name" required>
            <Input id="inv-name" name="name" required />
          </Field>
          <Field label={t("team.email", locale)} htmlFor="inv-email" required>
            <Input id="inv-email" name="email" type="email" required />
          </Field>
          <Field label={t("team.role", locale)} htmlFor="inv-role">
            <Select id="inv-role" name="role" defaultValue="operator">
              <option value="manager">{t("team.roleManager", locale)}</option>
              <option value="mechanic">{t("team.roleMechanic", locale)}</option>
              <option value="operator">{t("team.roleOperator", locale)}</option>
            </Select>
          </Field>
          <Field label={t("team.language", locale)} htmlFor="inv-lang" hint={t("team.inviteLanguageHint", locale)}>
            <Select id="inv-lang" name="language" defaultValue={inviteLanguage}>
              <option value="af">{t("settings.afrikaans", locale)}</option>
              <option value="en">{t("settings.english", locale)}</option>
            </Select>
          </Field>
        </DialogFields>
        <DialogActions cancelLabel={cancelLabel}>
          <SubmitButton variant="primary">{t("team.inviteBtn", locale)}</SubmitButton>
        </DialogActions>
      </form>
    </DialogForm>
  ) : null;

  return (
    <PageContainer>
      <PageHeader
        title={t("team.title", locale)}
        lead={t("team.subtitle", locale)}
        infoKey="team"
        locale={locale}
        actions={invite}
      />
      <Flash tone="error" message={errorMessage(sp.error, locale)} />
      <Flash tone="success" message={success} />

      {/* Two different questions about the same people: who may sign in (this page), and
          who may legally drive (that one). Linked rather than merged because a farm opens
          them on different days, one when somebody joins, the other when a truck is being
          loaded or an AARTO notice lands. */}
      <Link
        href="/team/licences"
        className="focus-ring flex min-h-[48px] items-center justify-between gap-3 rounded-2xl border border-sand-200 bg-surface p-4 shadow-xs sm:p-5"
      >
        <span className="min-w-0">
          <span className="block font-semibold text-ink">{t("credentials.teamLink", locale)}</span>
          <span className="mt-0.5 block text-sm text-sand-600">
            {t("credentials.teamLinkHint", locale)}
          </span>
        </span>
        <ChevronRightIcon className="shrink-0 text-sand-400" />
      </Link>

      {/*
        One row per person: who they are and their role. Only the exceptions are said
        (an extra permission, a login that is off), because "Active: Yes" on every row and
        three permission lines under every name told the reader nothing they needed. What
        a person may do, export, turning a login off and erasure are behind the row's own
        actions, titled with the person.
      */}
      <Card flush>
        {users.length === 0 ? (
          <p className="p-4 text-sm text-sand-500">{t("team.empty", locale)}</p>
        ) : (
          <Table stacked>
            <Thead>
              <Tr>
                <Th>{t("team.name", locale)}</Th>
                <Th>{t("team.role", locale)}</Th>
                <Th>{t("team.email", locale)}</Th>
                {canManage ? <Th /> : null}
              </Tr>
            </Thead>
            <Tbody>
              {users.map((u) => {
                const label = personLabel(u);
                const isMe = u.id === profile.id;
                const extras = USER_PERMISSIONS.filter(
                  (permission) => u.grants.has(permission) && !roleHasBaselinePermission(u.role, permission),
                );
                return (
                  <Tr key={u.id}>
                    <Td label={t("team.name", locale)} className="font-medium text-sand-900">
                      <span className="break-words">{u.name}</span>
                      {isMe ? <span className="ml-1 text-xs font-normal text-sand-500">({t("team.you", locale)})</span> : null}
                      {!u.active ? (
                        <StatusBadge
                          label={t("team.deactivated", locale)}
                          tone="neutral"
                          shape="square"
                          className="ml-2 align-middle"
                        />
                      ) : null}
                      {!u.isPrimaryMember ? (
                        <span className="mt-0.5 block text-xs font-normal text-sand-500">
                          {t("team.secondaryMember", locale)}
                        </span>
                      ) : null}
                      {extras.length > 0 ? (
                        <span className="mt-0.5 block text-xs font-normal text-sand-600">
                          {t("permissions.extraList", locale).replace(
                            "{list}",
                            extras.map((permission) => t(`permissions.${permission}`, locale)).join(", "),
                          )}
                        </span>
                      ) : null}
                    </Td>
                    <Td label={t("team.role", locale)}><Badge tone="neutral">{roleLabel(u.role, locale)}</Badge></Td>
                    <Td label={t("team.email", locale)} className="break-all text-sand-500">{u.email ?? "-"}</Td>
                    {canManage ? (
                      <Td className="text-right">
                        <ActionMenu title={label} label={t("common.actions", locale)} closeLabel={closeLabel}>
                          {!isMe && u.active ? (
                            <DialogForm
                              triggerLook="menuItem"
                              trigger={t("permissions.menuItem", locale)}
                              triggerIcon={<KeyIcon className="text-base" />}
                              title={t("permissions.dialogTitle", locale).replace("{name}", label)}
                              description={t("permissions.dialogHint", locale)}
                              closeLabel={closeLabel}
                              size="md"
                            >
                              <form action={setUserPermissions}>
                                <input type="hidden" name="user_id" value={u.id} />
                                <input type="hidden" name="back" value="/team" />
                                <DialogFields columns={1} className="gap-1">
                                  {USER_PERMISSIONS.map((permission) => {
                                    const baseline = roleHasBaselinePermission(u.role, permission);
                                    return (
                                      <Checkbox
                                        key={permission}
                                        id={`perm_${u.id}_${permission}`}
                                        name={permission}
                                        defaultChecked={baseline || u.grants.has(permission)}
                                        disabled={baseline}
                                        label={t(`permissions.${permission}`, locale)}
                                        hint={baseline ? t("permissions.inRole", locale) : undefined}
                                      />
                                    );
                                  })}
                                </DialogFields>
                                <DialogActions cancelLabel={cancelLabel}>
                                  <SubmitButton variant="primary">{t("permissions.save", locale)}</SubmitButton>
                                </DialogActions>
                              </form>
                            </DialogForm>
                          ) : null}

                          <a href={`/team/export?user=${u.id}`} className={menuItemClass()}>
                            <DownloadIcon className="shrink-0 text-base" />
                            {t("privacy.export", locale)}
                          </a>

                          {!isMe && u.isPrimaryMember ? (
                            <ConfirmDialog
                              action={setUserActive}
                              triggerLook="menuItem"
                              triggerLabel={u.active ? t("team.deactivate", locale) : t("team.activate", locale)}
                              title={(u.active ? t("team.deactivateTitle", locale) : t("team.activateTitle", locale)).replace("{name}", label)}
                              intro={u.active ? t("team.deactivateBody", locale) : t("team.activateBody", locale)}
                              footnote={u.active ? t("team.deactivateFootnote", locale) : undefined}
                              confirmLabel={u.active ? t("team.deactivate", locale) : t("team.activate", locale)}
                              cancelLabel={cancelLabel}
                              closeLabel={closeLabel}
                              tone={u.active ? "danger" : "brand"}
                            >
                              <input type="hidden" name="id" value={u.id} />
                              <input type="hidden" name="active" value={u.active ? "false" : "true"} />
                              <input type="hidden" name="back" value="/team" />
                            </ConfirmDialog>
                          ) : null}

                          {/*
                            Audit bug 4: POPIA erasure permanently anonymises a person
                            and bans their login for a hundred years, and it rendered
                            as a ghost link behind a browser confirm(). It now states
                            exactly what happens, points at the reversible option, and
                            will not unlock until their name is typed. `erasePerson`,
                            the guarded RPC and the auth scrub are untouched.
                          */}
                          {!isMe && u.isPrimaryMember ? (
                            <ConfirmDialog
                              action={erasePerson}
                              triggerLook="menuItem"
                              triggerIcon={<TrashIcon />}
                              triggerLabel={t("privacy.erase", locale)}
                              title={t("privacy.eraseTitle", locale).replace("{name}", label)}
                              intro={t("privacy.eraseIntro", locale).replace("{name}", label.split(" ")[0])}
                              consequencesTitle={t("privacy.eraseWhatHappens", locale)}
                              consequences={[
                                t("privacy.eraseEffect1", locale),
                                t("privacy.eraseEffect2", locale),
                                t("privacy.eraseEffect3", locale),
                                t("privacy.retentionNote", locale),
                              ]}
                              typeToConfirm={label}
                              typeToConfirmLabel={t("privacy.eraseTypeLabel", locale).replace("{name}", label)}
                              typeToConfirmPlaceholder={t("privacy.eraseTypePlaceholder", locale)}
                              confirmLabel={t("privacy.eraseConfirmCta", locale).replace("{name}", label)}
                              cancelLabel={t("privacy.eraseCancel", locale)}
                              closeLabel={closeLabel}
                              footnote={t("privacy.eraseReversibleHint", locale)}
                            >
                              <input type="hidden" name="id" value={u.id} />
                              <input type="hidden" name="back" value="/team" />
                            </ConfirmDialog>
                          ) : null}

                          {!u.isPrimaryMember ? (
                            <p className="px-1 pt-1 text-sm text-sand-500">{t("team.primaryFarmControls", locale)}</p>
                          ) : null}
                        </ActionMenu>
                      </Td>
                    ) : null}
                  </Tr>
                );
              })}
            </Tbody>
          </Table>
        )}
      </Card>

      {canManage ? (
        <Disclosure summary={t("privacy.title", locale)}>
          <div className="flex flex-col gap-2 text-sm text-sand-600">
            <p>{t("privacy.intro", locale)}</p>
            <p className="text-sand-500">{t("privacy.retentionNote", locale)}</p>
          </div>
        </Disclosure>
      ) : null}
    </PageContainer>
  );
}
