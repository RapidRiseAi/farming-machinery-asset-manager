import { NextResponse } from "next/server";
import { getProfile } from "@/lib/auth";
import { getSupabaseEnv } from "@/lib/env";
import { sameOrigin } from "@/lib/security/same-origin";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { beginUpload, parseBeginInput } from "@/lib/upload/server";

export const dynamic = "force-dynamic";

const HEADERS = { "Cache-Control": "private, no-store, max-age=0" } as const;

/**
 * Begin one direct upload (docs/LIMITS.md): reserve it in the person's session, then hand
 * back a signed upload for the exact path the database chose. The file itself never comes
 * here; this request is a few hundred bytes of JSON.
 */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "forbidden" }, { status: 403, headers: HEADERS });
  const profile = await getProfile();
  if (!profile?.active) return NextResponse.json({ error: "forbidden" }, { status: 403, headers: HEADERS });
  const input = parseBeginInput(await request.json().catch(() => null));
  if (!input) return NextResponse.json({ error: "upload-target" }, { status: 400, headers: HEADERS });

  const answer = await beginUpload(await createClient(), createServiceClient(), input, getSupabaseEnv().url);
  if (answer.state === "refused") return NextResponse.json({ error: answer.code }, { status: answer.status, headers: HEADERS });
  return NextResponse.json(answer, { headers: HEADERS });
}
