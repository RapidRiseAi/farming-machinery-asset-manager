import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { t } from "@/lib/i18n";
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import {
  DialogForm,
  DialogFields,
  DialogActions,
} from "@/components/ui/dialog-form";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { SubmitButton } from "@/components/ui/submit-button";
import { ConnectionForm, type Connection } from "./connection-form";
import { linkDevice } from "./actions";
export default async function DriverIntegrations({
  searchParams,
}: {
  searchParams: Promise<{ farm?: string; error?: string; saved?: string }>;
}) {
  const profile = await requireRole(["rr_admin"]);
  const locale = profile.lang;
  const sp = await searchParams;
  const db = await createClient();
  const farms = await db
    .from("farms")
    .select("id,name")
    .is("deleted_at", null)
    .order("name");
  if (farms.error) throw new Error("Farm list unavailable");
  const farm = farms.data?.find((f) => f.id === sp.farm);
  const [connections, links, machines, people] = farm
    ? await Promise.all([
        db
          .from("driver_connections")
          .select("id,name,kind,active,quote_reference")
          .eq("farm_id", farm.id),
        db
          .from("driver_device_links")
          .select("id,connection_id,external_id,machine_id,driver_id")
          .eq("farm_id", farm.id),
        db
          .from("machines")
          .select("id,name")
          .eq("farm_id", farm.id)
          .is("deleted_at", null),
        db.rpc("driving_people", { p_farm: farm.id }),
      ])
    : [
        { data: [], error: null },
        { data: [], error: null },
        { data: [], error: null },
        { data: [], error: null },
      ];
  if ([connections, links, machines, people].some((r) => r.error))
    throw new Error("Connections unavailable");
  const drivers = (people.data ?? []) as { id: string; name: string }[];
  return (
    <PageContainer>
      <PageHeader
        title={t("driving.integrations", locale)}
        lead={t("driving.staffHint", locale)}
      />
      <form method="get" className="flex flex-wrap items-end gap-3">
        <Field label={t("driving.farm", locale)} htmlFor="integration-farm">
          <Select
            id="integration-farm"
            name="farm"
            defaultValue={farm?.id ?? ""}
            required
          >
            <option value="">{t("driving.choose", locale)}</option>
            {farms.data?.map((f) => (
              <option value={f.id} key={f.id}>
                {f.name}
              </option>
            ))}
          </Select>
        </Field>
        <SubmitButton>{t("driving.choose", locale)}</SubmitButton>
      </form>
      {sp.error && <p role="alert">{t("driving.connectionError", locale)}</p>}
      {sp.saved && <p role="status">{t("driving.saved", locale)}</p>}
      {farm && (
        <>
          <h2 className="text-xl font-semibold">{farm.name}</h2>
          <DialogForm
            trigger={t("driving.addConnection", locale)}
            title={t("driving.addConnection", locale)}
            closeLabel={t("ui.close", locale)}
          >
            <ConnectionForm farm={farm.id} locale={locale} />
          </DialogForm>
          {(connections.data as Connection[]).map((c) => (
            <section
              className="flex flex-col gap-3 rounded-xl border border-sand-200 p-4"
              key={c.id}
            >
              <h3 className="text-lg font-semibold">
                {c.name} ·{" "}
                {t(c.active ? "driving.enabled" : "driving.awaiting", locale)}
              </h3>
              <p>
                {t("driving.quote", locale)}: {c.quote_reference ?? "-"}
              </p>
              <DialogForm
                trigger={t("driving.configure", locale)}
                title={c.name}
                closeLabel={t("ui.close", locale)}
              >
                <ConnectionForm farm={farm.id} connection={c} locale={locale} />
              </DialogForm>
              <DialogForm
                trigger={t("driving.link", locale)}
                title={t("driving.link", locale)}
                closeLabel={t("ui.close", locale)}
              >
                <form action={linkDevice}>
                  <DialogFields>
                    <input type="hidden" name="farm" value={farm.id} />
                    <input type="hidden" name="connection" value={c.id} />
                    <Field
                      label={t("driving.externalId", locale)}
                      htmlFor={`${c.id}-external`}
                    >
                      <Input
                        id={`${c.id}-external`}
                        name="external"
                        required
                        maxLength={200}
                      />
                    </Field>
                    <p>{t("driving.linkHint", locale)}</p>
                    <Field
                      label={t("driving.vehicle", locale)}
                      htmlFor={`${c.id}-machine`}
                    >
                      <Select id={`${c.id}-machine`} name="machine">
                        <option value="">{t("driving.choose", locale)}</option>
                        {machines.data?.map((m) => (
                          <option value={m.id} key={m.id}>
                            {m.name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field
                      label={t("driving.driver", locale)}
                      htmlFor={`${c.id}-driver`}
                    >
                      <Select id={`${c.id}-driver`} name="driver">
                        <option value="">{t("driving.choose", locale)}</option>
                        {drivers.map((d) => (
                          <option value={d.id} key={d.id}>
                            {d.name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  </DialogFields>
                  <DialogActions cancelLabel={t("common.cancel", locale)}>
                    <SubmitButton>{t("common.save", locale)}</SubmitButton>
                  </DialogActions>
                </form>
              </DialogForm>
              {links.data
                ?.filter((l) => l.connection_id === c.id)
                .map((l) => (
                  <p key={l.id} className="break-words">
                    {l.external_id} →{" "}
                    {l.machine_id
                      ? machines.data?.find((m) => m.id === l.machine_id)?.name
                      : drivers.find((d) => d.id === l.driver_id)?.name}
                  </p>
                ))}
            </section>
          ))}
        </>
      )}
    </PageContainer>
  );
}
