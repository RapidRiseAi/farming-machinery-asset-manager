import { checkEntitlement } from "@/lib/auth";
import { pdfResponse } from "@/lib/pdf/doc";
import { buildCompliancePack } from "@/lib/pdf/packs";
import {
  authorizeFleetPack,
  denialResponse,
  gatherFleetCompliance,
  isDenial,
  packFilename,
} from "@/lib/pdf/pack-data";

export const dynamic = "force-dynamic";

/**
 * The GLOBALG.A.P. / SIZA pack for the whole fleet (FR-13.4).
 *
 * ENTITLEMENT: Professional+ via `advanced_reports`, the same gate the reports surface
 * this is reached from already carries. That is deliberate and it is the only pack that
 * is gated. The reasoning:
 *
 *   * The EVIDENCE is never gated. A per-machine compliance pack
 *     (/api/packs/machine/[id]/compliance) is core on every plan, reachable from machine
 *     detail, and it is the document an auditor actually works through — asset by asset.
 *     An Essential farm that has faithfully captured its licences and services can always
 *     produce them. 0382 promised that uploading your own paperwork stays free forever
 *     and 0492 called a tier "an upgrade, never a repossession"; locking a farm out of
 *     its own compliance record would break both.
 *
 *   * What IS gated is the fleet-wide ROLL-UP: counts by type and status, adherence
 *     ranked worst-first, a cross-fleet expiry table. That is a report. It lives on
 *     /reports beside nine other report families, every one of which is Professional+.
 *     Un-gating one of them and leaving its siblings gated would make the tier arbitrary.
 *
 * Contractors and operators are refused outright — see the note in pack-data.ts. For a
 * contractor the old route would have blended every linked farm into one document under
 * no farm's name, because `currentFarmId` is null for a workshop.
 */
export async function GET() {
  const auth = await authorizeFleetPack();
  if (isDenial(auth)) return denialResponse(auth);

  const gate = await checkEntitlement("advanced_reports", auth.profile);
  if (!gate.allowed) {
    return new Response("Forbidden (upgrade_required)", {
      status: 403,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const input = await gatherFleetCompliance(auth);
  const bytes = await buildCompliancePack(input, auth.profile.lang);
  return pdfResponse(bytes, packFilename("compliance-pack", input.issuer.farmName));
}
