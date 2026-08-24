import { pdfResponse } from "@/lib/pdf/doc";
import { buildSalePack } from "@/lib/pdf/packs";
import {
  authorizeMachinePack,
  denialResponse,
  gatherSale,
  isDenial,
  packFilename,
} from "@/lib/pdf/pack-data";

export const dynamic = "force-dynamic";

/**
 * The pack that goes with a machine changing hands (FR-13.4).
 *
 * UNGATED CORE — with ONE gated section inside it. The lifetime cost / TCO block is the
 * F5 `tco` feature (Professional+) wherever it appears, so on an Essential farm the pack
 * still prints identity, compliance, the full service history, the meter trail and the
 * declared faults, and prints a SENTENCE where the costs would be saying they are a
 * Professional feature. The gate never becomes a silent omission: a cost section that
 * simply vanished would read to a buyer as a machine that has cost nothing.
 *
 * Retired and sold machines are NOT excluded. The fleet compliance figures answer "what
 * is on the farm" and exclude them (Scope 4.1 / C8); this answers "what am I selling",
 * and a machine already marked sold is exactly the one whose pack somebody needs.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await authorizeMachinePack(id);
  if (isDenial(auth)) return denialResponse(auth);

  const input = await gatherSale(auth);
  const bytes = await buildSalePack(input, auth.profile.lang);
  return pdfResponse(bytes, packFilename("sale-pack", auth.machine.name));
}
