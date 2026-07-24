import { redirect } from "next/navigation";
import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { t } from "@/lib/i18n";
import { inviteUser, setUserActive, erasePerson } from "./actions";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, Thead, Tbody, Tr, Th, Td } from "@/components/ui/table";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/submit-button";
import { Flash } from "@/components/ui/flash";
import { ConfirmForm } from "@/components/confirm-form";

type TeamUser = { id: string; name: string; role: string; email: string | null; active: boolean };

export default async function TeamPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; invited?: string; saved?: string; erased?: string }>;
}) {
  const profile = await requireProfile();
  if (profile.role === "rr_admin") redirect("/admin/farms");
  const locale = profile.language;
  const sp = await searchParams;

  const supabase = await createClient();
  const { data } = await supabase.from("users").select("id, name, role, email, active").order("role");
  const users = (data as TeamUser[] | null) ?? [];
  const canManage = profile.role === "owner" || profile.role === "manager";

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <h1 className="text-2xl font-bold tracking-tight text-sand-900">{t("team.title", locale)}</h1>
      <Flash tone="error" message={sp.error} />
      <Flash tone="success" message={sp.invited ? t("team.invited", locale) : sp.erased ? t("privacy.erased", locale) : sp.saved ? t("ui.saved", locale) : undefined} />

      {canManage && profile.farm_id ? (
        <Card>
          <CardHeader><CardTitle>{t("team.invite", locale)}</CardTitle></CardHeader>
          <form action={inviteUser} className="flex flex-col gap-3">
            <input type="hidden" name="farm_id" value={profile.farm_id} />
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
                {canManage ? <Th /> : null}
              </Tr>
            </Thead>
            <Tbody>
              {users.map((u) => (
                <Tr key={u.id}>
                  <Td className="font-medium text-sand-900">
                    {u.name}
                    {u.id === profile.id ? <span className="ml-1 text-xs text-sand-400">({t("team.you", locale)})</span> : null}
                  </Td>
                  <Td><Badge tone="neutral" className="capitalize">{u.role}</Badge></Td>
                  <Td className="text-sand-500">{u.email ?? "—"}</Td>
                  <Td>{u.active ? <Badge tone="ok">{t("common.yes", locale)}</Badge> : <Badge tone="danger">{t("common.no", locale)}</Badge>}</Td>
                  {canManage ? (
                    <Td className="text-right">
                      <div className="flex flex-wrap items-center justify-end gap-1">
                        <a
                          href={`/team/export?user=${u.id}`}
                          className={buttonVariants({ variant: "ghost", size: "sm" })}
                        >
                          {t("privacy.export", locale)}
                        </a>
                        {u.id !== profile.id ? (
                          <>
                            <form action={setUserActive}>
                              <input type="hidden" name="id" value={u.id} />
                              <input type="hidden" name="active" value={u.active ? "false" : "true"} />
                              <input type="hidden" name="back" value="/team" />
                              <Button type="submit" variant="ghost" size="sm">{u.active ? t("team.deactivate", locale) : t("team.activate", locale)}</Button>
                            </form>
                            <ConfirmForm
                              action={erasePerson}
                              message={t("privacy.eraseConfirm", locale)}
                              label={t("privacy.erase", locale)}
                            >
                              <input type="hidden" name="id" value={u.id} />
                              <input type="hidden" name="back" value="/team" />
                            </ConfirmForm>
                          </>
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
