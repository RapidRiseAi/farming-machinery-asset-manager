import assert from "node:assert/strict";
import test from "node:test";
import { sameSupplierUpload, supplierFileHash, validSupplierTotal, type SupplierDocumentReceipt } from "./supplier-document-upload";

const receipt: SupplierDocumentReceipt = {
  id: "capture", farm_id: "farm", workshop_id: "supplier", machine_id: "asset",
  work_request_id: "request", kind: "invoice", source: "uploaded", created_by: "receiver",
  total_cents: 11500, subject: "Repair", issue_date: "2026-10-01", due_date: null,
  upload_path: "farm/capture/document-sha256.pdf", number: "SUPPLIER-105",
};

test("supplied invoices permit no-charge work while quotes require a positive total", () => {
  assert.equal(validSupplierTotal("invoice", 0), true);
  assert.equal(validSupplierTotal("quote", 0), false);
  for (const value of [null, -1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(validSupplierTotal("invoice", value), false);
  }
  assert.equal(validSupplierTotal("invoice", 11500), true);
});

test("only the original upload payload can acknowledge an existing document", () => {
  assert.equal(sameSupplierUpload({ ...receipt }, receipt), true);
  for (const [key, value] of Object.entries({
    id: "another-capture", farm_id: "other-farm", workshop_id: "other-supplier",
    machine_id: "another-asset", work_request_id: "other-request", kind: "quote",
    source: "built", created_by: "other-actor", total_cents: 23000, subject: "Other work",
    issue_date: "2026-09-01", due_date: "2026-11-01", upload_path: "farm/capture/document-other-file.pdf", number: "SUPPLIER-106",
  })) {
    assert.equal(sameSupplierUpload(receipt, { ...receipt, [key]: value }), false, key);
  }
});

test("file receipt hashes repeat for identical bytes and reject a substituted file", async () => {
  const bytes = new TextEncoder().encode("supplier invoice");
  const hash = await supplierFileHash(bytes);
  assert.equal(await supplierFileHash(new Uint8Array(bytes)), hash);
  assert.notEqual(await supplierFileHash(new TextEncoder().encode("changed invoice")), hash);
  assert.match(hash, /^[0-9a-f]{64}$/);
});
