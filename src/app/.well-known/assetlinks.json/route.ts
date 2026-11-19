import { NextResponse } from "next/server";
import { assetLinks } from "@/lib/native/asset-links";

export const dynamic = "force-dynamic";

/** Digital Asset Links for the Android app's App Links (B6). Public, as Android fetches it signed out. */
export function GET() {
  return NextResponse.json(assetLinks(process.env), {
    headers: { "cache-control": "public, max-age=3600" },
  });
}
