import { getProfile } from "@/lib/auth";
import { csvResponse } from "@/app/(app)/reports/data";
import { readingsTemplate } from "@/lib/import-staging";

export const dynamic = "force-dynamic";

/** The readings sheet template for the import review (task B5): headers and two example rows. */
export async function GET() {
  const profile = await getProfile();
  if (!profile || !profile.active) return new Response("Unauthorized", { status: 401 });
  return csvResponse("readings-template.csv", readingsTemplate());
}
