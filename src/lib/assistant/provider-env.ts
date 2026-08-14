import "server-only";

export type AzureSpeechProviderEnv = {
  key: string;
  region: string;
  speechEndpoint: string;
  tokenEndpoint: string;
};

export type AzureSpeechProviderEnvIssue =
  | "missing_key"
  | "invalid_key"
  | "missing_region"
  | "invalid_region"
  | "missing_endpoint"
  | "invalid_endpoint";

/** A deliberately non-sensitive error: callers must not surface environment values. */
export class AzureSpeechProviderEnvError extends Error {
  readonly issue: AzureSpeechProviderEnvIssue;

  constructor(issue: AzureSpeechProviderEnvIssue) {
    super("Azure Speech provider configuration is unavailable.");
    this.name = "AzureSpeechProviderEnvError";
    this.issue = issue;
  }
}

const REGION_PATTERN = /^[a-z0-9]{2,40}$/;
const MIN_KEY_LENGTH = 16;
const MAX_KEY_LENGTH = 256;

/**
 * Read Azure Speech settings lazily at request time so builds do not require secrets.
 * The configured endpoint is validated against the region, but the STS URL is always
 * constructed locally to prevent an environment value from becoming an arbitrary
 * credential-bearing request target.
 */
export function getAzureSpeechProviderEnv(): AzureSpeechProviderEnv {
  const rawKey = process.env.AZURE_SPEECH_KEY;
  if (!rawKey) throw new AzureSpeechProviderEnvError("missing_key");

  const key = rawKey.trim();
  if (
    key.length < MIN_KEY_LENGTH ||
    key.length > MAX_KEY_LENGTH ||
    /\s|[\u0000-\u001f\u007f]/.test(key)
  ) {
    throw new AzureSpeechProviderEnvError("invalid_key");
  }

  const rawRegion = process.env.AZURE_SPEECH_REGION;
  if (!rawRegion) throw new AzureSpeechProviderEnvError("missing_region");

  const region = rawRegion.trim().toLowerCase();
  if (!REGION_PATTERN.test(region)) {
    throw new AzureSpeechProviderEnvError("invalid_region");
  }

  const rawEndpoint = process.env.AZURE_SPEECH_ENDPOINT;
  if (!rawEndpoint) throw new AzureSpeechProviderEnvError("missing_endpoint");

  let endpoint: URL;
  try {
    endpoint = new URL(rawEndpoint.trim());
  } catch {
    throw new AzureSpeechProviderEnvError("invalid_endpoint");
  }

  const expectedHost = `${region}.api.cognitive.microsoft.com`;
  if (
    endpoint.protocol !== "https:" ||
    endpoint.hostname.toLowerCase() !== expectedHost ||
    endpoint.port !== "" ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.pathname !== "/" ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  ) {
    throw new AzureSpeechProviderEnvError("invalid_endpoint");
  }

  return {
    key,
    region,
    speechEndpoint: `https://${expectedHost}/`,
    tokenEndpoint: `https://${expectedHost}/sts/v1.0/issueToken`,
  };
}
