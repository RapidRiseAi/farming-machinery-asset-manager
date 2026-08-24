import {
  authenticateApiRequest,
  getApiRow,
  isApiResource,
  publicApiErrorResponse,
  publicApiResponse,
  requireApiScope,
} from "@/lib/api-tokens";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteContext = { params: Promise<{ resource: string; id: string }> };

export async function GET(request: Request, { params }: RouteContext) {
  const requestId = crypto.randomUUID();
  try {
    const { resource, id } = await params;
    if (!isApiResource(resource)) {
      return publicApiResponse(
        { error: { code: "not_found", message: "The requested API resource does not exist." }, request_id: requestId },
        requestId,
        404,
      );
    }
    const context = await authenticateApiRequest(request);
    requireApiScope(context, "read");
    const data = await getApiRow(context, resource, id, request.signal);
    return publicApiResponse({ data, request_id: requestId }, requestId);
  } catch (error) {
    return publicApiErrorResponse(error, requestId);
  }
}
