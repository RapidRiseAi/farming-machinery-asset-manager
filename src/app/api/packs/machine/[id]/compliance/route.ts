import { pdfResponse } from "@/lib/pdf/doc";
import { buildCompliancePack } from "@/lib/pdf/packs";
import {
  authorizeMachinePack,
  denialResponse,
  gatherMachineCompliance,
  isDenial,
  packFilename,
} from "@/lib/pdf/pack-data";

export const dynamic = "force-dynamic";

/**
 * One vehicle's GLOBALG.A.P. / SIZA compliance record (FR-13.4).
 *
 * UNGATED CORE, on every plan. This is the farm's own record of one asset handed back in
 * the shape a third party demands — not analysis, not a roll-up. Gating it would mean an
 * Essential farm that has captured every licence and every service cannot produce them
 * for an auditor, which turns a subscription tier into a barrier to the farm's own
 * compliance. The fleet-wide roll-up is the gated one; see fleet-compliance/route.ts.
 *
 * Status is irrelevant here: you named this machine, so a retired or sold one still gets
 * its pack. The status is printed on the face of the document.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await authorizeMachinePack(id);
  if (isDenial(auth)) return denialResponse(auth);

  const input = await gatherMachineCompliance(auth);
  const bytes = await buildCompliancePack(input, auth.profile.lang);
  return pdfResponse(bytes, packFilename("compliance-pack", auth.machine.name));
}
