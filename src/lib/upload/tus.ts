/**
 * The smallest TUS 1.0.0 client that does what Supabase's resumable uploads need (creation,
 * PATCH in fixed chunks, HEAD to find where an interrupted upload stopped), written here
 * rather than adding a package (docs/final-dev/PROGRESS-lane-b.md). Supabase: the chunk
 * size "must be set to 6MB (for now)"; a signed upload goes to /upload/resumable/sign with
 * the token in `x-signature`; an upload URL lives up to 24 hours
 * (https://supabase.com/docs/guides/storage/uploads/resumable-uploads).
 *
 * The transport is passed in: XMLHttpRequest in the browser (for progress), a fake in tests.
 */

export type HttpRequest = {
  method: "POST" | "PATCH" | "HEAD" | "PUT";
  url: string;
  headers: Record<string, string>;
  body?: Blob | null;
  onProgress?: (sentBytes: number) => void;
  signal?: AbortSignal;
};
export type HttpResponse = { status: number; header(name: string): string | null };
export type Transport = (request: HttpRequest) => Promise<HttpResponse>;

export class UploadHttpError extends Error {
  constructor(readonly status: number, readonly stage: string) {
    super(`upload ${stage} answered ${status}`);
    this.name = "UploadHttpError";
  }
}

const b64 = (value: string) => {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

export type TusOptions = {
  endpoint: string;
  token: string;
  apiKey: string;
  bucket: string;
  path: string;
  contentType: string;
  chunkBytes: number;
  /** An upload URL from an earlier attempt (this tab or one before a reload), to resume. */
  resumeUrl?: string | null;
  /** Told the upload URL as soon as it exists, so a reload can resume it. */
  onUploadUrl?: (url: string) => void;
  onProgress?: (sentBytes: number, totalBytes: number) => void;
  signal?: AbortSignal;
};

function absolute(location: string, endpoint: string): string {
  return new URL(location, endpoint).toString();
}

/**
 * Sends `file` with TUS, resuming from wherever the server says it got to. Resolves when
 * every byte is stored; rejects on abort (pause) or failure, after which calling again with
 * the same `resumeUrl` carries on.
 */
export async function tusUpload(file: Blob, transport: Transport, options: TusOptions): Promise<void> {
  const base = {
    "Tus-Resumable": "1.0.0",
    "x-signature": options.token,
    apikey: options.apiKey,
  };
  let url = options.resumeUrl ?? null;
  let offset = 0;

  if (url) {
    const head = await transport({ method: "HEAD", url, headers: base, signal: options.signal });
    const at = Number(head.header("Upload-Offset"));
    if (head.status >= 200 && head.status < 300 && Number.isSafeInteger(at) && at >= 0) {
      offset = at;
    } else if (head.status === 404 || head.status === 410 || head.status === 403) {
      url = null; // the earlier upload URL is gone (expired, or its token has); start again
    } else {
      throw new UploadHttpError(head.status, "resume");
    }
  }

  if (!url) {
    const metadata = [
      `bucketName ${b64(options.bucket)}`,
      `objectName ${b64(options.path)}`,
      `contentType ${b64(options.contentType)}`,
      `cacheControl ${b64("3600")}`,
    ].join(",");
    const created = await transport({
      method: "POST", url: options.endpoint, signal: options.signal,
      headers: { ...base, "Upload-Length": String(file.size), "Upload-Metadata": metadata, "x-upsert": "false" },
    });
    const location = created.header("Location");
    if (created.status !== 201 || !location) throw new UploadHttpError(created.status, "create");
    url = absolute(location, options.endpoint);
    options.onUploadUrl?.(url);
    offset = 0;
  }

  options.onProgress?.(offset, file.size);
  while (offset < file.size) {
    const end = Math.min(offset + options.chunkBytes, file.size);
    const from = offset;
    const answer = await transport({
      method: "PATCH", url, body: file.slice(from, end), signal: options.signal,
      headers: { ...base, "Upload-Offset": String(from), "Content-Type": "application/offset+octet-stream" },
      onProgress: (sent) => options.onProgress?.(from + sent, file.size),
    });
    const next = Number(answer.header("Upload-Offset"));
    if (answer.status === 409) {
      // The server holds a different offset (a chunk landed but its answer was lost): ask it.
      const head = await transport({ method: "HEAD", url, headers: base, signal: options.signal });
      const at = Number(head.header("Upload-Offset"));
      if (!Number.isSafeInteger(at)) throw new UploadHttpError(head.status, "resume");
      offset = at;
      continue;
    }
    if (answer.status < 200 || answer.status >= 300 || !Number.isSafeInteger(next) || next <= from) {
      throw new UploadHttpError(answer.status, "chunk");
    }
    offset = next;
    options.onProgress?.(offset, file.size);
  }
}

/** One signed PUT for a small file (Supabase's standard upload, up to 6 MB). */
export async function signedPut(
  file: Blob, transport: Transport,
  options: { signedUrl: string; apiKey: string; contentType: string; onProgress?: (sent: number, total: number) => void; signal?: AbortSignal },
): Promise<void> {
  const answer = await transport({
    method: "PUT", url: options.signedUrl, body: file, signal: options.signal,
    headers: { "content-type": options.contentType, "x-upsert": "false", "cache-control": "max-age=3600", apikey: options.apiKey },
    onProgress: (sent) => options.onProgress?.(sent, file.size),
  });
  // 409 / 400 "already exists": an earlier attempt stored it and lost its answer. The server
  // judges the stored bytes next, so this is not a failure.
  if (answer.status === 409 || answer.status === 400) return;
  if (answer.status < 200 || answer.status >= 300) throw new UploadHttpError(answer.status, "put");
  options.onProgress?.(file.size, file.size);
}

/** XMLHttpRequest as a Transport: the browser's only way to report upload progress. */
export const xhrTransport: Transport = (request) =>
  new Promise<HttpResponse>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(request.method, request.url);
    for (const [name, value] of Object.entries(request.headers)) xhr.setRequestHeader(name, value);
    if (request.onProgress) xhr.upload.onprogress = (event) => request.onProgress?.(event.loaded);
    const abort = () => xhr.abort();
    request.signal?.addEventListener("abort", abort, { once: true });
    xhr.onload = () => {
      request.signal?.removeEventListener("abort", abort);
      resolve({ status: xhr.status, header: (name) => xhr.getResponseHeader(name) });
    };
    xhr.onerror = () => reject(new UploadHttpError(0, "network"));
    xhr.onabort = () => reject(new DOMException("Paused", "AbortError"));
    xhr.ontimeout = () => reject(new UploadHttpError(0, "timeout"));
    xhr.send(request.body ?? null);
  });
