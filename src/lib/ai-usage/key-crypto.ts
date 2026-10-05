import "server-only";
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

/**
 * A farm's own OpenAI key, sealed at rest.
 *
 * AES-256-GCM with a random 96-bit IV. The key comes from `AI_KEY_SECRET` (32 bytes,
 * base64), a Vercel Sensitive variable: never in the repo, which is public, and never in
 * the browser. The farm id is bound in as additional authenticated data, so a ciphertext
 * copied onto another farm's row does not open there. Stored as
 * `v2.<secret id>.<iv>.<tag>.<ciphertext>` in base64url, so the scheme can change later
 * without guessing what an old value is.
 *
 * The secret id (a short HMAC of a constant under the secret, which says nothing about the
 * secret itself) tells a value sealed under ANOTHER secret (a Preview deployment, a local
 * copy, a rotation not yet re-sealed: all sharing one database) from a damaged one. Only
 * a damaged value is the farm's to fix; the wrong secret is this deployment's.
 */
const VERSION = "v2";

/** Thrown when a value was sealed under a different AI_KEY_SECRET than this deployment's. */
export class KeySecretMismatch extends Error {
  constructor() {
    super("This value was sealed under a different AI_KEY_SECRET.");
    this.name = "KeySecretMismatch";
  }
}

function secretId(key: Buffer): string {
  return createHmac("sha256", key).update("fleetwise:ai-key-secret-id").digest("base64url").slice(0, 10);
}

function secretKey(raw: string | undefined): Buffer {
  const key = raw ? Buffer.from(raw, "base64") : Buffer.alloc(0);
  if (key.length !== 32) throw new Error("AI_KEY_SECRET must be 32 bytes, base64 encoded.");
  return key;
}

/**
 * Whether the sealing secret is set at all. A missing secret is the platform's
 * misconfiguration, not a farm's broken key: callers fail closed rather than treat every
 * linked key as broken (and pause, or bill on ours, every farm that linked one).
 */
export function keySecretConfigured(secret = process.env.AI_KEY_SECRET): boolean {
  return Boolean(secret) && Buffer.from(String(secret), "base64").length === 32;
}

export function sealFarmKey(plaintext: string, farmId: string, secret = process.env.AI_KEY_SECRET): string {
  const key = secretKey(secret);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(farmId, "utf8"));
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [VERSION, secretId(key), iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), data.toString("base64url")].join(".");
}

/**
 * Throws KeySecretMismatch when the value was sealed under another secret, and a plain
 * error on a wrong farm or any change to the stored value.
 */
export function openFarmKey(sealed: string, farmId: string, secret = process.env.AI_KEY_SECRET): string {
  const key = secretKey(secret);
  const [version, id, iv, tag, data, extra] = sealed.split(".");
  if (version !== VERSION || !id || !iv || !tag || !data || extra !== undefined) throw new Error("Unrecognised sealed key.");
  if (id !== secretId(key)) throw new KeySecretMismatch();
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAAD(Buffer.from(farmId, "utf8"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
}

/** The last four characters, which is all a person is ever shown of a saved key. */
export function keyHint(plaintext: string): string {
  return plaintext.trim().slice(-4);
}

/** An OpenAI secret key's shape (`sk-...`, including project keys), checked before any network call. */
export function looksLikeOpenAiKey(value: string): boolean {
  return /^sk-[A-Za-z0-9_-]{20,}$/.test(value.trim());
}
