import { createClient } from "@/lib/supabase/server";
import { t, type Lang } from "@/lib/i18n";
import { createDocument } from "@/app/(app)/documents/actions";
import { SelectField, TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { PlusIcon } from "@/components/ui/icons";

/**
 * "New quote" / "New invoice" for a partner — a disclosure rather than a route, because
 * starting one is three choices and a name, and a page transition for that is friction on
 * a phone in a workshop.
 *
 * The customer list comes from `workshop_links` through RLS, so a partner can only ever
 * raise a document against a farm that has actually connected to them. Server component:
 * no client JS, and the bundle stays flat.
 */
export async function NewDocument({ locale, canBuild }: { locale: Lang; canBuild: boolean }) {
  if (!canBuild) return null;

  const supabase = await createClient();
  const { data } = await supabase
    .from("workshop_links")
    .select("farm_id, farms(id, name)")
    .eq("status", "active")
    .is("deleted_at", null);

  // PostgREST types an embedded relation as an array even when it is at most one row.
  const farms = ((data ?? []) as unknown as {
    farm_id: string;
    farms: { id: string; name: string } | { id: string; name: string }[] | null;
  }[])
    .map((l) => (Array.isArray(l.farms) ? (l.farms[0] ?? null) : l.farms))
    .filter((f): f is { id: string; name: string } => !!f)
    .sort((a, b) => a.name.localeCompare(b.name));

  if (farms.length === 0) return null;

  return (
    <details className="ml-auto">
      <summary className="focus-ring inline-flex min-h-[48px] cursor-pointer list-none items-center gap-2 rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700 sm:min-h-[40px] [&::-webkit-details-marker]:hidden">
        <PlusIcon /> {t("doc.new", locale)}
      </summary>
      <form action={createDocument} className="mt-3 flex flex-col gap-3 rounded-xl border border-sand-200 bg-white p-4 shadow-soft">
        <SelectField name="kind" label={t("doc.newKind", locale)} defaultValue="quote">
          <option value="quote">{t("doc.kindQuote", locale)}</option>
          <option value="invoice">{t("doc.kindInvoice", locale)}</option>
        </SelectField>
        <SelectField name="farm_id" label={t("doc.newCustomer", locale)} required>
          {farms.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </SelectField>
        <TextField
          name="subject"
          label={t("doc.newSubject", locale)}
          hint={t("doc.newSubjectHint", locale)}
        />
        <SubmitButton>{t("doc.newCreate", locale)}</SubmitButton>
      </form>
    </details>
  );
}
