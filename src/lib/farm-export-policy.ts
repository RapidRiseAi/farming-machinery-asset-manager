import { createHash } from "node:crypto";

/** Shared by record and file exports. A stopped account must never export an empty
 * bundle that appears complete, or bypass the owner's retrieval deadline. */
export function exportRefusal(
  role: string | null,
  gate: string | null,
  lifecycle?: { state: string; reason: string | null } | null,
): { error: string; status: number } | null {
  if (!["owner", "manager", "rr_admin"].includes(role ?? "")) {
    return { error: "forbidden", status: 403 };
  }
  if (role === "rr_admin") return null;
  if (gate === "pending") return { error: "farm-not-active", status: 402 };
  if (gate === "ok") return null;
  if (gate !== "suspended" && gate !== "closed") {
    return { error: "export-unavailable", status: 503 };
  }
  if (role !== "owner") return { error: "retrieval-owner-only", status: 403 };
  if (!lifecycle) return { error: "export-unavailable", status: 503 };
  if (lifecycle.state === "closed" && lifecycle.reason !== "rapid_rise") {
    return { error: "retrieval-ended", status: 402 };
  }
  return null;
}

/** Never put a storage key directly in an archive header. The hash preserves
 * uniqueness when different names sanitise to the same portable filename. */
export function exportArchivePath(bucket: string, path: string, farmId: string): string {
  if (!/^[a-z][a-z0-9-]*$/.test(bucket) || ["chat-files", "command-audio"].includes(bucket)) {
    throw new Error("export: excluded bucket");
  }
  if (!path.startsWith(`${farmId}/`) || path.length <= farmId.length + 1) {
    throw new Error("export: wrong scope");
  }
  const basename = path.split(/[\\/]/).pop() ?? "file";
  const name = basename.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/\.+$/g, "").slice(0, 100) || "file";
  const digest = createHash("sha256").update(bucket).update("\0").update(path).digest("hex");
  return `${bucket}/${digest}-${name}`;
}
