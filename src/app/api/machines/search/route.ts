import { NextResponse } from "next/server";
import { getProfile, currentFarmId } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { sanitiseFilterTerm } from "@/lib/search-filter";

export const dynamic = "force-dynamic";

/**
 * Machine lookup for the command palette.
 *
 * Typing a nickname or a registration and landing on the machine is the thing a
 * person in a workshop actually wants; walking a twenty-one row nav to
 * /machines and then filtering is not.
 *
 * Reads through the REQUEST-SCOPED client, so row-level security is the access
 * control. A service client here would quietly remove the only rule that makes
 * this endpoint safe, and it would not be obvious from the call site.
 */

export type MachineHit = {
  id: string;
  name: string;
  make: string | null;
  model: string | null;
  reg_no: string | null;
  status: string | null;
};

export async function GET(request: Request) {
  // Signed in, and on a farm. Without this an unauthenticated request would
  // simply get an empty list, which is safe but tells a caller nothing.
  const profile = await getProfile();
  if (!profile) return NextResponse.json({ machines: [] }, { status: 401 });

  const q = sanitiseFilterTerm(new URL(request.url).searchParams.get("q") ?? "");
  // Two characters is the point where the result set stops being the whole
  // fleet. Below it, answering with nothing is cheaper than answering with
  // everything and is what the palette wants anyway.
  if (q.length < 2) return NextResponse.json({ machines: [] });

  const supabase = await createClient();
  const farmId = await currentFarmId();

  let query = supabase
    .from("machines")
    .select("id, name, make, model, reg_no, status")
    .is("deleted_at", null)
    // Scoped to the farm the shell is currently showing. RLS already limits
    // this to farms the person may reach; this narrows it to the one they are
    // actually looking at, so a second farm's machines cannot appear under a
    // sidebar that is describing the first.
    .or(`name.ilike.%${q}%,make.ilike.%${q}%,model.ilike.%${q}%,reg_no.ilike.%${q}%,serial_no.ilike.%${q}%`)
    .order("name")
    .limit(8);
  if (farmId) query = query.eq("farm_id", farmId);

  const { data, error } = await query;
  if (error) {
    // An empty list, not a 500: a search box that breaks the page when the
    // database hiccups is worse than one that finds nothing for a moment.
    return NextResponse.json({ machines: [] });
  }

  return NextResponse.json({ machines: (data ?? []) as MachineHit[] });
}
