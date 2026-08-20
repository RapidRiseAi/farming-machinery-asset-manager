import { redirect } from "next/navigation";
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
import { PageInfoButton } from "@/components/ui/page-info-button";
import { inviteUser, setUserActive, erasePerson, setUserPermission } from "./actions";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, Thead, Tbody, Tr, Th, Td } from "@/components/ui/table";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/submit-button";
import { Flash } from "@/components/ui/flash";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { TrashIcon } from "@/components/ui/icons";
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
 * and the erase dialog's type-to-confirm must never resolve to the empty string — that
 * would leave the irreversible action unlocked from the moment it opens.
 */
function personLabel(u: TeamUser): string {
  return u.name.trim() || u.email?.trim() || u.id.slice(0, 8);
}

export default async function TeamPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; invited?: string; saved?: string; erased?: string; permissionSaved?: string }>;
}) {
  const profile = await requireProfile();
  if (profile.role === "rr_admin") redirect("/admin/farms");
  const locale = profile.lang;
  const sp = await searchParams;

  const permissionState = await farmPermissionState(profile);
  const farmId = permissionState.farmId;
  const canManage = permissionState.role === "owner" || permissionState.role === "manager";
  if (!farmId || !canManage) redirect(`${homePathFor(profile.role)}?denied=1`);

  const supabase = await createClient();
  const [{ data: primaryData }, { data: membershipData }, { data: grantData }] = await Promise.all([
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
  ]);

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
    .sort((a, b) => a.role.localeCompare(b.role) || a.name.localeCompare(b.name));

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="text-2xl font-bold tracking-tight text-sand-900">{t("team.title", locale)}</h1>
          <PageInfoButton infoKey="team" locale={locale} />
        </div>
      <Flash tone="error" message={sp.error} />
      <Flash tone="success" message={sp.invited ? t("team.invited", locale) : sp.erased ? t("privacy.erased", locale) : sp.permissionSaved ? t("permissions.saved", locale) : sp.saved ? t("ui.saved", locale) : undefined} />

      {canManage ? (
        <Card>
          <CardHeader><CardTitle>{t("team.invite", locale)}</CardTitle></CardHeader>
          <form action={inviteUser} className="flex flex-col gap-3">
            <input type="hidden" name="back" value="/team" />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
              <Field label={t("team.language", locale)} htmlFor="inv-lang">
                <Select id="inv-lang" name="language" defaultValue="af">
                  <option value="af">{t("settings.afrikaans", locale)}</option>
                  <option value="en">{t("settings.english", locale)}</option>
                </Select>
              </Field>
            </div>
            <SubmitButton variant="primary" className="self-start">{t("team.inviteBtn", locale)}</SubmitButton>
          </form>
        </Card>
      ) : null}

      <Card flush>
        {users.length === 0 ? (
          <p className="p-4 text-sm text-sand-500">{t("team.empty", locale)}</p>
        ) : (
          <Table>
            <Thead>
              <Tr>
                <Th>{t("team.name", locale)}</Th>
                <Th>{t("team.role", locale)}</Th>
                <Th>{t("team.email", locale)}</Th>
                <Th>{t("team.active", locale)}</Th>
                <Th>{t("permissions.title", locale)}</Th>
                {canManage ? <Th /> : null}
              </Tr>
            </Thead>
            <Tbody>
              {users.map((u) => (
                <Tr key={u.id}>
                  <Td className="font-medium text-sand-900">
                    {u.name}
                    {u.id === profile.id ? <span className="ml-1 text-xs text-sand-400">({t("team.you", locale)})</span> : null}
                    {!u.isPrimaryMember ? (
                      <span className="mt-0.5 block text-xs font-normal text-sand-500">
                        {t("team.secondaryMember", locale)}
                      </span>
                    ) : null}
                  </Td>
                  <Td><Badge tone="neutral">{roleLabel(u.role, locale)}</Badge></Td>
                  <Td className="text-sand-500">{u.email ?? "—"}</Td>
                  <Td>{u.active ? <Badge tone="ok">{t("common.yes", locale)}</Badge> : <Badge tone="danger">{t("common.no", locale)}</Badge>}</Td>
                  <Td>
                    <div className="flex min-w-56 flex-col gap-2 py-1">
                      {USER_PERMISSIONS.map((permission) => {
                        const baseline = roleHasBaselinePermission(u.role, permission);
                        const granted = u.grants.has(permission);
                        return (
                          <div key={permission} className="flex flex-wrap items-center gap-1.5">
                            <span className="text-xs font-medium text-sand-700">
                              {t(`permissions.${permission}`, locale)}
                            </span>
                            {baseline ? (
                              <Badge tone="neutral">{t("permissions.inRole", locale)}</Badge>
                            ) : granted ? (
                              <Badge tone="ok">{t("permissions.extra", locale)}</Badge>
                            ) : null}
                            {!baseline && u.id !== profile.id && u.active ? (
                              <form action={setUserPermission} className="ml-auto">
                                <input type="hidden" name="user_id" value={u.id} />
                                <input type="hidden" name="permission" value={permission} />
                                <input type="hidden" name="enabled" value={granted ? "false" : "true"} />
                                <input type="hidden" name="back" value="/team" />
                                <Button type="submit" variant="ghost" size="sm">
                                  {granted ? t("permissions.remove", locale) : t("permissions.add", locale)}
                                </Button>
                              </form>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  </Td>
                  {canManage ? (
                    <Td className="text-right">
                      <div className="flex flex-wrap items-center justify-end gap-1">
                        <a
                          href={`/team/export?user=${u.id}`}
                          className={buttonVariants({ variant: "ghost", size: "sm" })}
                        >
                          {t("privacy.export", locale)}
                        </a>
                        {u.id !== profile.id && u.isPrimaryMember ? (
                          <>
                            <form action={setUserActive}>
                              <input type="hidden" name="id" value={u.id} />
                              <input type="hidden" name="active" value={u.active ? "false" : "true"} />
                              <input type="hidden" name="back" value="/team" />
                              <Button type="submit" variant="ghost" size="sm">{u.active ? t("team.deactivate", locale) : t("team.activate", locale)}</Button>
                            </form>
                            {/*
                              Audit bug 4: POPIA erasure permanently anonymises a person
                              and bans their login for a hundred years, and it rendered
                              as a ghost link behind a browser confirm(). It now states
                              exactly what happens, points at the reversible option, and
                              will not unlock until their name is typed. `erasePerson`,
                              the guarded RPC and the auth scrub are untouched.
                            */}
                            <ConfirmDialog
                              action={erasePerson}
                              triggerVariant="ghost"
                              triggerSize="sm"
                              triggerIcon={<TrashIcon />}
                              triggerLabel={t("privacy.erase", locale)}
                              triggerClassName="text-status-overdue hover:bg-red-50"
                              title={t("privacy.eraseTitle", locale).replace("{name}", personLabel(u))}
                              intro={t("privacy.eraseIntro", locale).replace("{name}", personLabel(u).split(" ")[0])}
                              consequencesTitle={t("privacy.eraseWhatHappens", locale)}
                              consequences={[
                                t("privacy.eraseEffect1", locale),
                                t("privacy.eraseEffect2", locale),
                                t("privacy.eraseEffect3", locale),
                                t("privacy.retentionNote", locale),
                              ]}
                              typeToConfirm={personLabel(u)}
                              typeToConfirmLabel={t("privacy.eraseTypeLabel", locale).replace("{name}", personLabel(u))}
                              typeToConfirmPlaceholder={t("privacy.eraseTypePlaceholder", locale)}
                              confirmLabel={t("privacy.eraseConfirmCta", locale).replace("{name}", personLabel(u))}
                              cancelLabel={t("privacy.eraseCancel", locale)}
                              closeLabel={t("ui.close", locale)}
                              footnote={t("privacy.eraseReversibleHint", locale)}
                            >
                              <input type="hidden" name="id" value={u.id} />
                              <input type="hidden" name="back" value="/team" />
                            </ConfirmDialog>
                          </>
                        ) : !u.isPrimaryMember ? (
                          <span className="text-xs text-sand-500">{t("team.primaryFarmControls", locale)}</span>
                        ) : null}
                      </div>
                    </Td>
                  ) : null}
                </Tr>
              ))}
            </Tbody>
          </Table>
        )}
      </Card>

      {canManage ? (
        <Card>
          <CardHeader><CardTitle>{t("privacy.title", locale)}</CardTitle></CardHeader>
          <div className="flex flex-col gap-2 text-sm text-sand-600">
            <p>{t("privacy.intro", locale)}</p>
            <p className="text-sand-500">{t("privacy.retentionNote", locale)}</p>
          </div>
        </Card>
      ) : null}
    </div>
  );
}
