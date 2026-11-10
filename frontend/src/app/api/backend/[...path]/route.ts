import { NextRequest, NextResponse } from "next/server";
import { isIP } from "node:net";

const API_PREFIX = "/api/backend";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SLOT_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 10_000, 10_000, 10_000, 10_000];
const SLOT_RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);
const SLOT_RETRY_WINDOW_MS = 60_000;

function retryAfterMs(response: Response, fallback: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (!retryAfter) return fallback;

  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;

  const retryAt = Date.parse(retryAfter);
  return Number.isFinite(retryAt)
    ? Math.max(0, retryAt - Date.now())
    : fallback;
}

async function fetchSlotsWithColdStartRetry(
  destination: URL,
  headers: Headers,
): Promise<Response> {
  const startedAt = Date.now();

  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(destination, {
        method: "GET",
        headers,
        cache: "no-store",
      });
      if (
        !SLOT_RETRYABLE_STATUSES.has(response.status) ||
        attempt >= SLOT_RETRY_DELAYS_MS.length
      ) {
        return response;
      }

      const delay = retryAfterMs(
        response,
        SLOT_RETRY_DELAYS_MS[attempt],
      );
      if (Date.now() - startedAt + delay > SLOT_RETRY_WINDOW_MS) {
        return response;
      }

      await response.body?.cancel();
      await new Promise((resolve) => setTimeout(resolve, delay));
    } catch (error) {
      if (attempt >= SLOT_RETRY_DELAYS_MS.length) throw error;

      const delay = SLOT_RETRY_DELAYS_MS[attempt];
      if (Date.now() - startedAt + delay > SLOT_RETRY_WINDOW_MS) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

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
  const forwardedFor = request.headers.get("x-forwarded-for");
  const clientIp = forwardedFor?.split(",")[0]?.trim();
  if (contentType) headers.set("Content-Type", contentType);
  if (idempotencyKey) headers.set("Idempotency-Key", idempotencyKey);
  if (clientIp && isIP(clientIp)) headers.set("X-Booking-Client-IP", clientIp);

  try {
    const response =
      request.method === "GET" && path === "/slots"
        ? await fetchSlotsWithColdStartRetry(destination, headers)
        : await fetch(destination, {
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
