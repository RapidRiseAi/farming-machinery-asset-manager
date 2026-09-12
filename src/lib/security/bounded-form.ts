/** Enforce actual received bytes, including requests without Content-Length. */
export async function readBoundedFormData(request: Request, maxBytes: number): Promise<FormData> {
  if (Number(request.headers.get("content-length") ?? "0") > maxBytes) throw new RangeError("payload_too_large");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("empty_body");
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new RangeError("payload_too_large");
      }
      chunks.push(new Uint8Array(value));
    }
  } finally {
    reader.releaseLock();
  }
  return new Response(new Blob(chunks), { headers: { "content-type": request.headers.get("content-type") ?? "" } }).formData();
}
