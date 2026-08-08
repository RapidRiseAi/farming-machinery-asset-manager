import { createClient } from "@/lib/supabase/server";
import { t, type Lang } from "@/lib/i18n";
import { createDocument } from "@/app/(app)/documents/actions";
import { NewDocumentForm, type Recipient } from "./new-document-form";

/**
 * "New quote" / "New invoice" for a partner.
 *
 * The customer can now be one of three things (0410), and the third is the one that
 * changes what this product is:
 *
 *   a FleetWise farm       from `workshop_links`, so a partner can only raise a document
 *                          against a farm that has actually connected to them
 *   a client in their book from `partner_clients` — a customer who is not on FleetWise
 *                          at all
 *   a one-time customer    typed straight onto the document, with no record created
 *
 * Before this, `farm_id` was `not null`: a partner could only ever invoice a FleetWise
 * tenant, so "run your business on FleetWise" meant "run the FleetWise slice of it and
 * keep your old system for everyone else" — which means keeping the old system.
 *
 * The lists are fetched here (server component, no client JS for the data); the form
 * itself is a client component because which fields you need depends on which kind of
 * customer you picked, and showing all of them at once is how a form stops being read.
 */
export async function NewDocument({ locale, canBuild }: { locale: Lang; canBuild: boolean }) {
  if (!canBuild) return null;

  const supabase = await createClient();
  const [{ data: linkData }, { data: clientData }] = await Promise.all([
    supabase
      .from("workshop_links")
      .select("farm_id, farms(id, name)")
      .eq("status", "active")
      .is("deleted_at", null),
    supabase
      .from("partner_clients")
      .select("id, name")
      .is("deleted_at", null)
      .order("name"),
  ]);

  // PostgREST types an embedded relation as an array even when it is at most one row.
  const farms: Recipient[] = ((linkData ?? []) as unknown as {
    farms: { id: string; name: string } | { id: string; name: string }[] | null;
  }[])
    .map((l) => (Array.isArray(l.farms) ? (l.farms[0] ?? null) : l.farms))
    .filter((f): f is { id: string; name: string } => !!f)
    .sort((a, b) => a.name.localeCompare(b.name));

  const clients: Recipient[] = ((clientData ?? []) as { id: string; name: string }[]).map((c) => ({
    id: c.id,
    name: c.name,
  }));

  return (
    <NewDocumentForm action={createDocument} farms={farms} clients={clients} locale={locale} />
  );
}
