/** Immutable receipt fields for a supplied-document upload. The storage path includes
 * the SHA-256 of the file, so an uncertain retry cannot silently substitute evidence. */
export type SupplierDocumentReceipt = {
  id: string; farm_id: string; workshop_id: string; machine_id: string | null;
  work_request_id: string | null; kind: string; source: string; created_by: string;
  total_cents: number; subject: string | null; issue_date: string; due_date: string | null;
  upload_path: string; number: string;
};

export function sameSupplierUpload(saved: SupplierDocumentReceipt, submitted: SupplierDocumentReceipt): boolean {
  return (Object.keys(submitted) as (keyof SupplierDocumentReceipt)[]).every((key) => saved[key] === submitted[key]);
}

export function validSupplierTotal(kind: "quote" | "invoice", total: number | null): total is number {
  return total != null && Number.isSafeInteger(total) && (kind === "invoice" ? total >= 0 : total > 0);
}

export async function supplierFileHash(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
