import assert from "node:assert/strict";
import type { Server } from "node:http";
import test from "node:test";
import { createApp } from "../src/app";

test("API key protects all routes, including health and unknown paths", async (t) => {
  const apiKey = "unit-test-api-key";
  const server: Server = createApp(apiKey).listen(0, "127.0.0.1");
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  }));
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  async function request(
    path: string,
    apiKeyHeader?: string,
    body?: string,
  ): Promise<Response> {
    const headers = new Headers();
    if (apiKeyHeader) headers.set("X-API-Key", apiKeyHeader);
    if (body !== undefined) headers.set("Content-Type", "application/json");
    return fetch(`${baseUrl}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers,
      body,
    });
  }

  await t.test("rejects absent and incorrect keys on health and API routes", async () => {
    for (const path of [
      "/health",
      "/slots",
      "/reset",
      "/bookings",
      "/bookings/00000000-0000-4000-8000-000000000001",
      "/not-a-route",
    ]) {
      for (const suppliedKey of [undefined, "incorrect-key"]) {
        const response = await request(path, suppliedKey);
        assert.equal(response.status, 401, `${path} with ${suppliedKey ?? "no key"}`);
        assert.deepEqual(await response.json(), {
          error: "missing or invalid API key",
        });
      }
    }
  });

  await t.test("checks credentials before parsing malformed request bodies", async () => {
    const unauthorized = await request("/bookings", undefined, "{invalid");
    assert.equal(unauthorized.status, 401);
    assert.deepEqual(await unauthorized.json(), {
      error: "missing or invalid API key",
    });

    const authorized = await request("/bookings", apiKey, "{invalid");
    assert.equal(authorized.status, 400);
    assert.deepEqual(await authorized.json(), {
      error: "request body must be valid JSON",
    });
  });

  await t.test("accepts the configured key for the health route", async () => {
    const response = await request("/health", apiKey);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok" });
  });
});
