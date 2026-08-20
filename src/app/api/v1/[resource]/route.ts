import {
  authenticateApiRequest,
  insertApiReading,
  isApiResource,
  listApiRows,
  parseIdempotencyKey,
  publicApiErrorResponse,
  publicApiResponse,
  readApiReadingRequest,
  requireApiScope,
} from "@/lib/api-tokens";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteContext = { params: Promise<{ resource: string }> };

export async function GET(request: Request, { params }: RouteContext) {
  const requestId = crypto.randomUUID();
  try {
    const { resource } = await params;
    if (!isApiResource(resource)) {
      return publicApiResponse(
        { error: { code: "not_found", message: "The requested API resource does not exist." }, request_id: requestId },
        requestId,
        404,
      );
    }
    const context = await authenticateApiRequest(request);
    requireApiScope(context, "read");
    const result = await listApiRows(context, resource, new URL(request.url), request.signal);
    return publicApiResponse({ ...result, request_id: requestId }, requestId);
  } catch (error) {
    return publicApiErrorResponse(error, requestId);
  }
}

export async function POST(request: Request, { params }: RouteContext) {
  const requestId = crypto.randomUUID();
  try {
    const { resource } = await params;
    if (!isApiResource(resource)) {
      return publicApiResponse(
        { error: { code: "not_found", message: "The requested API resource does not exist." }, request_id: requestId },
        requestId,
        404,
      );
    }
    if (resource !== "meter-readings") {
      const response = publicApiResponse(
        { error: { code: "method_not_allowed", message: "This resource is read-only." }, request_id: requestId },
        requestId,
        405,
      );
      response.headers.set("Allow", "GET, HEAD");
      return response;
    }
    const context = await authenticateApiRequest(request);
    requireApiScope(context, "write:readings");
    const idempotencyKey = parseIdempotencyKey(request);
    const input = await readApiReadingRequest(request);
    const result = await insertApiReading(context, input, idempotencyKey, request.signal);
    return publicApiResponse(
      { data: result.data, idempotent_replay: result.replayed, request_id: requestId },
      requestId,
      result.replayed ? 200 : 201,
    );
  } catch (error) {
    return publicApiErrorResponse(error, requestId);
  }
}
