import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyDownload, filenameFromDisposition, filenameFromHref, type DownloadResponse } from "./download";

const file = (over: Partial<DownloadResponse> = {}): DownloadResponse => ({
  ok: true,
  status: 200,
  redirected: false,
  url: "https://app.example/api/statements/pdf?party=x",
  contentType: "application/pdf",
  ...over,
});

test("a file is a file", () => {
  assert.equal(classifyDownload(file()), null);
  assert.equal(classifyDownload(file({ contentType: "text/csv; charset=utf-8" })), null);
  assert.equal(classifyDownload(file({ contentType: null })), null);
});

test("an expired session that lands on the login page is 'signed out', not a file", () => {
  assert.equal(
    classifyDownload(file({ redirected: true, url: "https://app.example/login?next=%2Freports", contentType: "text/html" })),
    "signed-out",
  );
  assert.equal(classifyDownload(file({ redirected: true, url: "https://app.example/mfa/verify", contentType: "text/html" })), "signed-out");
  assert.equal(classifyDownload(file({ ok: false, status: 401, contentType: "application/json" })), "signed-out");
});

test("statuses map to their own reasons", () => {
  assert.equal(classifyDownload(file({ ok: false, status: 403 })), "not-allowed");
  assert.equal(classifyDownload(file({ ok: false, status: 404 })), "not-found");
  assert.equal(classifyDownload(file({ ok: false, status: 429 })), "busy");
  assert.equal(classifyDownload(file({ ok: false, status: 500 })), "failed");
  assert.equal(classifyDownload(file({ ok: false, status: 503 })), "failed");
});

test("a page instead of a file is a failure even with a 200", () => {
  assert.equal(classifyDownload(file({ contentType: "text/html; charset=utf-8" })), "failed");
  // Redirected somewhere that is not a sign-in page: still not the file, and not a guess.
  assert.equal(classifyDownload(file({ redirected: true, url: "https://app.example/dashboard", contentType: "text/html" })), "failed");
});

test("the server's file name, plain and RFC 6266 forms", () => {
  assert.equal(filenameFromDisposition('attachment; filename="fleetwise-reports.xlsx"', "x"), "fleetwise-reports.xlsx");
  assert.equal(filenameFromDisposition("attachment; filename=cost.csv", "x"), "cost.csv");
  assert.equal(
    filenameFromDisposition(`attachment; filename="fallback.pdf"; filename*=UTF-8''Sk%C3%B6n%20Boerdery.pdf`, "x"),
    "Skön Boerdery.pdf",
  );
});

test("a file name cannot carry a path or characters a file system rejects", () => {
  assert.equal(filenameFromDisposition('attachment; filename="../../etc/passwd"', "x"), "etc-passwd");
  assert.equal(filenameFromDisposition('attachment; filename="a:b*c?.csv"', "x"), "a-b-c-.csv");
  assert.equal(filenameFromDisposition('attachment; filename=""', "report.pdf"), "report.pdf");
  assert.equal(filenameFromDisposition(null, ""), "download");
  // Malformed percent-encoding falls back to the plain name rather than throwing.
  assert.equal(filenameFromDisposition(`attachment; filename="ok.csv"; filename*=UTF-8''%E0%A4%A`, "x"), "ok.csv");
});

test("a name from the link when the server gave none", () => {
  assert.equal(filenameFromHref("/reports/cost.csv?from=2026-01-01"), "cost.csv");
  assert.equal(filenameFromHref("/api/billing/invoice/abc/receipt.pdf"), "receipt.pdf");
  assert.equal(filenameFromHref("/"), "download");
});
