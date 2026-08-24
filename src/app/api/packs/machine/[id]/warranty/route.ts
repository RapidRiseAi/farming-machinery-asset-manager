import { pdfResponse } from "@/lib/pdf/doc";
import { buildWarrantyPack } from "@/lib/pdf/packs";
import {
  authorizeMachinePack,
  denialResponse,
  gatherWarranty,
  isDenial,
  packFilename,
} from "@/lib/pdf/pack-data";

export const dynamic = "force-dynamic";

/**
 * The evidence a warranty claim needs (FR-13.4): the terms on file, and proof the
 * service plan was actually adhered to.
 *
 * UNGATED CORE. A warranty claim is refused on a skipped service, so the pack states the
 * standing of EVERY task — including the ones that were never done — rather than
 * printing only the services that were performed, which is the shape that flatters. No
 * money is analysed here, so nothing inside it touches the `tco` gate.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await authorizeMachinePack(id);
  if (isDenial(auth)) return denialResponse(auth);

  const input = await gatherWarranty(auth);
  const bytes = await buildWarrantyPack(input, auth.profile.lang);
  return pdfResponse(bytes, packFilename("warranty-pack", auth.machine.name));
}
