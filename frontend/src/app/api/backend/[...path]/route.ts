import { NextRequest, NextResponse } from "next/server";

const API_PREFIX = "/api/backend";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isAllowedRequest(path: string, method: string): boolean {
  if (path === "/reset") return method === "POST";
  if (path === "/slots") return method === "GET";
  if (path === "/bookings") return method === "GET" || method === "POST";
  const bookingId = path.match(/^\/bookings\/([^/]+)$/)?.[1];
  return Boolean(bookingId && UUID_PATTERN.test(bookingId) &&
    (method === "GET" || method === "DELETE"));
}

async function proxyRequest(request: NextRequest): Promise<NextResponse> {
  const apiUrl = process.env.BACKEND_API_URL;
  const apiKey = process.env.BACKEND_API_KEY;
  if (!apiUrl || !apiKey) {
    console.error("BACKEND_API_URL and BACKEND_API_KEY must be configured");
    return NextResponse.json({ error: "booking service is not configured" }, { status: 500 });
  }

  const path = new URL(request.url).pathname.slice(API_PREFIX.length);
  if (!isAllowedRequest(path, request.method)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const resetApiKey = path === "/reset" ? request.headers.get("X-API-Key") : null;
  if (path === "/reset" && resetApiKey !== apiKey) {
    return NextResponse.json(
      { error: "missing or invalid API key" },
      { status: 401 },
    );
  }

  let destination: URL;
  try {
    destination = new URL(apiUrl);
  } catch {
    console.error("BACKEND_API_URL must be a valid absolute URL");
    return NextResponse.json({ error: "booking service is not configured" }, { status: 500 });
  }
  destination.pathname = `${destination.pathname.replace(/\/+$/, "")}${path}`;
  destination.search = new URL(request.url).search;

  const headers = new Headers({ "X-API-Key": resetApiKey ?? apiKey });
  const contentType = request.headers.get("content-type");
  const idempotencyKey = request.headers.get("idempotency-key");
  if (contentType) headers.set("Content-Type", contentType);
  if (idempotencyKey) headers.set("Idempotency-Key", idempotencyKey);

  try {
    const response = await fetch(destination, {
      method: request.method,
      headers,
      body: request.method === "POST" ? await request.text() : undefined,
      cache: "no-store",
    });
    const responseHeaders = new Headers();
    const responseType = response.headers.get("content-type");
    const retryAfter = response.headers.get("retry-after");
    if (responseType) responseHeaders.set("content-type", responseType);
    if (retryAfter) responseHeaders.set("retry-after", retryAfter);
    responseHeaders.set("Cache-Control", "no-store");
    return new NextResponse(response.body, {
      status: response.status,
      headers: responseHeaders,
    });
  } catch (error) {
    console.error("Failed to reach the booking API", error);
    return NextResponse.json({ error: "booking service is unavailable" }, { status: 502 });
  }
}

export const GET = proxyRequest;
export const POST = proxyRequest;
export const DELETE = proxyRequest;
