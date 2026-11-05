import assert from "node:assert/strict";
import crypto from "node:crypto";
import type { Server } from "node:http";
import test from "node:test";
import { Pool } from "pg";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const apiKey = "integration-test-api-key";
const slots = [
  {
    id: "slot-a",
    provider: "Dr Test",
    start: "2099-01-01T10:00:00.000Z",
    end: "2099-01-01T10:30:00.000Z",
  },
  {
    id: "slot-b",
    provider: "Dr Other",
    start: "2099-01-01T10:30:00.000Z",
    end: "2099-01-01T11:00:00.000Z",
  },
  {
    id: "slot-c",
    provider: "Dr Test",
    start: "2099-01-01T11:00:00.000Z",
    end: "2099-01-01T11:30:00.000Z",
  },
];

type RequestOptions = {
  apiKey?: string | null;
  body?: unknown;
  headers?: Record<string, string>;
  rawBody?: string;
};

type JsonObject = Record<string, unknown>;

test(
  "HTTP API endpoints",
  { skip: testDatabaseUrl ? false : "Set TEST_DATABASE_URL to run PostgreSQL endpoint tests" },
  async (t) => {
    const schema = `booking_test_${crypto.randomUUID().replace(/-/g, "")}`;
    const adminPool = new Pool({
      connectionString: testDatabaseUrl,
      ssl: testDatabaseUrl?.includes("sslmode=require")
        ? { rejectUnauthorized: false }
        : undefined,
    });
    let appPool: Pool | undefined;
    let httpServer: Server | undefined;

    try {
      await adminPool.query(`CREATE SCHEMA "${schema}"`);
      const scopedUrl = new URL(testDatabaseUrl!);
      scopedUrl.searchParams.set("options", `-c search_path=${schema}`);
      process.env.DATABASE_URL = scopedUrl.toString();

      const [{ createApp }, database] = await Promise.all([
        import("../src/app.js"),
        import("../src/db.js"),
      ]);
      appPool = database.pool;
      await database.initializeDatabase();
      const app = createApp(apiKey);
      const server = app.listen(0, "127.0.0.1");
      httpServer = server;
      await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const baseUrl = `http://127.0.0.1:${address.port}`;

      async function request(
        method: string,
        path: string,
        options: RequestOptions = {},
      ): Promise<globalThis.Response> {
        const headers = new Headers(options.headers);
        if (options.apiKey !== null) {
          headers.set("X-API-Key", options.apiKey ?? apiKey);
        }
        headers.set("X-Forwarded-For", headers.get("X-Forwarded-For") ?? "198.51.100.10");
        if (options.body !== undefined) headers.set("Content-Type", "application/json");
        return fetch(`${baseUrl}${path}`, {
          method,
          headers,
          body:
            options.rawBody ??
            (options.body === undefined ? undefined : JSON.stringify(options.body)),
        });
      }

      async function reset(): Promise<void> {
        const response = await request("POST", "/reset", { body: { slots } });
        assert.equal(response.status, 200);
      }

      async function json(response: globalThis.Response): Promise<JsonObject> {
        return response.json() as Promise<JsonObject>;
      }

      await t.test("health endpoint is public and reports healthy", async () => {
        const response = await request("GET", "/health", { apiKey: null });
        assert.equal(response.status, 200);
        assert.deepEqual(await json(response), { status: "ok" });
      });

      await t.test("all API endpoints reject missing and invalid API keys", async () => {
        const calls: Array<[string, string, RequestOptions?]> = [
          ["GET", "/slots"],
          ["POST", "/reset", { body: { slots } }],
          ["POST", "/bookings", { body: {} }],
          ["GET", "/bookings?email=patient@example.com"],
          ["GET", "/bookings/00000000-0000-4000-8000-000000000001"],
          ["DELETE", "/bookings/00000000-0000-4000-8000-000000000001"],
        ];
        for (const [method, path, options] of calls) {
          for (const apiKeyOption of [null, "wrong-api-key"]) {
            const response = await request(method, path, {
              ...options,
              apiKey: apiKeyOption,
            });
            assert.equal(response.status, 401, `${method} ${path}`);
            assert.deepEqual(await json(response), {
              error: "missing or invalid API key",
            });
          }
        }
      });

      await t.test("reset validates schedule, replaces slots, and clears stored state", async () => {
        for (const [body, error] of [
          [{}, "slots must be an array"],
          [{ slots: [null] }, "each slot must be an object"],
          [{ slots: [{ id: "x", provider: "Dr", start: "invalid", end: "invalid" }] },
            "each slot needs a valid id, provider, start, and end"],
          [{ slots: [slots[0], slots[0]] }, "slot ids must be unique"],
        ] as const) {
          const invalid = await request("POST", "/reset", { body });
          assert.equal(invalid.status, 400);
          assert.deepEqual(await json(invalid), { error });
        }

        await reset();
        const created = await request("POST", "/bookings", {
          body: { slot_id: "slot-a", name: "Ada Patient", email: "ada@example.com" },
          headers: { "Idempotency-Key": "cleared-by-reset" },
        });
        assert.equal(created.status, 201);
        const replaced = await request("POST", "/reset", {
          body: { slots: [slots[1]] },
        });
        assert.equal(replaced.status, 200);
        assert.deepEqual(await json(replaced), { message: "slots replaced" });
        const list = await json(await request("GET", "/slots"));
        const listedSlots = list.slots as Array<{ id: string }>;
        assert.deepEqual(listedSlots.map((slot) => slot.id), ["slot-b"]);
        const attempts = await request("POST", "/bookings", {
          body: { slot_id: "slot-b", name: "Ada Patient", email: "ada@example.com" },
          headers: { "Idempotency-Key": "cleared-by-reset" },
        });
        assert.equal(attempts.status, 201);
      });

      await t.test("slot listing returns availability and filters by provider", async () => {
        await reset();
        const booked = await request("POST", "/bookings", {
          body: { slot_id: "slot-a", name: "Ada Patient", email: "ada@example.com" },
        });
        assert.equal(booked.status, 201);
        const all = await json(await request("GET", "/slots"));
        const allSlots = all.slots as Array<{ id: string; available: boolean }>;
        assert.equal(allSlots.length, 3);
        assert.equal(allSlots.find((slot) => slot.id === "slot-a")?.available, false);
        assert.equal(allSlots.find((slot) => slot.id === "slot-b")?.available, true);
        const filtered = await json(await request("GET", "/slots?provider=Dr%20Other"));
        const filteredSlots = filtered.slots as Array<{ id: string }>;
        assert.deepEqual(filteredSlots.map((slot) => slot.id), ["slot-b"]);
      });

      await t.test("booking validates input, JSON, slot existence, and slot time", async () => {
        await reset();
        const invalidInputs: Array<[unknown, string]> = [
          [null, "request body must be an object"],
          [{ slot_id: "", name: "Ada", email: "slot@example.com" }, "slot_id is required"],
          [{ slot_id: "slot-a", name: "", email: "name@example.com" }, "name is required"],
          [{ slot_id: "slot-a", name: "Ada", email: "bad-email" }, "email must be valid"],
        ];
        for (const [body, error] of invalidInputs) {
          const response = await request("POST", "/bookings", { body });
          assert.equal(response.status, 400);
          assert.deepEqual(await json(response), { error });
        }
        const malformedJson = await request("POST", "/bookings", {
          rawBody: "{invalid",
          headers: { "Content-Type": "application/json" },
        });
        assert.equal(malformedJson.status, 400);
        assert.deepEqual(await json(malformedJson), {
          error: "request body must be valid JSON",
        });
        const missingSlot = await request("POST", "/bookings", {
          body: { slot_id: "missing", name: "Ada", email: "missing@example.com" },
        });
        assert.equal(missingSlot.status, 404);
        assert.deepEqual(await json(missingSlot), { error: "slot not found" });
        await adminPool.query(
          `UPDATE "${schema}".slots SET start_at = '2000-01-01T00:00:00Z' WHERE id = 'slot-c'`,
        );
        const elapsedSlot = await request("POST", "/bookings", {
          body: { slot_id: "slot-c", name: "Ada", email: "elapsed@example.com" },
        });
        assert.equal(elapsedSlot.status, 400);
        assert.deepEqual(await json(elapsedSlot), { error: "slot has already started" });
      });

      await t.test("booking creates records and handles idempotency correctly", async () => {
        await reset();
        const body = {
          slot_id: "slot-a",
          name: " Ada Patient ",
          email: " ADA@EXAMPLE.COM ",
        };
        const options = { body, headers: { "Idempotency-Key": "repeat-request-1" } };
        const first = await request("POST", "/bookings", options);
        assert.equal(first.status, 201);
        const firstBooking = await json(first);
        assert.equal(firstBooking.name, "Ada Patient");
        assert.equal(firstBooking.email, "ada@example.com");
        const replay = await request("POST", "/bookings", options);
        assert.equal(replay.status, 201);
        assert.deepEqual(await json(replay), firstBooking);
        const mismatch = await request("POST", "/bookings", {
          ...options,
          body: { ...body, name: "Different patient" },
        });
        assert.equal(mismatch.status, 422);
        assert.deepEqual(await json(mismatch), {
          error: "Idempotency-Key was already used with a different body",
        });
        const overlongKey = await request("POST", "/bookings", {
          body,
          headers: { "Idempotency-Key": "x".repeat(256) },
        });
        assert.equal(overlongKey.status, 400);
      });

      await t.test("concurrent booking requests cannot confirm the same slot twice", async () => {
        await reset();
        const responses = await Promise.all([
          request("POST", "/bookings", {
            body: { slot_id: "slot-a", name: "Patient One", email: "one@example.com" },
            headers: { "X-Forwarded-For": "198.51.100.20" },
          }),
          request("POST", "/bookings", {
            body: { slot_id: "slot-a", name: "Patient Two", email: "two@example.com" },
            headers: { "X-Forwarded-For": "198.51.100.21" },
          }),
        ]);
        assert.deepEqual(
          responses.map((response) => response.status).sort(),
          [201, 409],
        );
      });

      await t.test("booking lookup handles invalid, missing, and existing IDs", async () => {
        await reset();
        const invalid = await request("GET", "/bookings/not-a-uuid");
        assert.equal(invalid.status, 404);
        assert.deepEqual(await json(invalid), { error: "booking not found" });
        const missing = await request(
          "GET",
          "/bookings/00000000-0000-4000-8000-000000000001",
        );
        assert.equal(missing.status, 404);
        assert.deepEqual(await json(missing), { error: "booking not found" });
        const created = await request("POST", "/bookings", {
          body: { slot_id: "slot-a", name: "Ada", email: "ada@example.com" },
        });
        const booking = await json(created);
        assert.equal(typeof booking.id, "string");
        const found = await request("GET", `/bookings/${booking.id}`);
        assert.equal(found.status, 200);
        assert.deepEqual(await json(found), booking);
      });

      await t.test("booking cancellation handles invalid IDs, missing IDs, and repeat cancellation", async () => {
        await reset();
        for (const path of [
          "/bookings/not-a-uuid",
          "/bookings/00000000-0000-4000-8000-000000000001",
        ]) {
          const missing = await request("DELETE", path);
          assert.equal(missing.status, 404);
          assert.deepEqual(await json(missing), { error: "booking not found" });
        }
        const created = await request("POST", "/bookings", {
          body: { slot_id: "slot-a", name: "Ada", email: "ada@example.com" },
        });
        const booking = await json(created);
        assert.equal(typeof booking.id, "string");
        const cancelled = await request("DELETE", `/bookings/${booking.id}`);
        assert.equal(cancelled.status, 200);
        assert.equal((await json(cancelled)).status, "cancelled");
        const repeated = await request("DELETE", `/bookings/${booking.id}`);
        assert.equal(repeated.status, 409);
        assert.deepEqual(await json(repeated), { error: "booking is already cancelled" });
        const slotsAfterCancellation = await json(await request("GET", "/slots"));
        const cancelledSlot = (slotsAfterCancellation.slots as Array<{
          id: string;
          available: boolean;
        }>).find((slot) => slot.id === "slot-a");
        assert.equal(cancelledSlot?.available, true);
      });

      await t.test("booking history validates pagination and pages results", async () => {
        await reset();
        const missingEmail = await request("GET", "/bookings");
        assert.equal(missingEmail.status, 400);
        assert.deepEqual(await json(missingEmail), { error: "email is required" });
        for (const query of ["limit=0", "limit=51", "limit=abc", "cursor=invalid"]) {
          const invalid = await request(
            "GET",
            `/bookings?email=ada%40example.com&${query}`,
          );
          assert.equal(invalid.status, 400, query);
        }
        const email = "page@example.com";
        for (const slot_id of ["slot-a", "slot-b", "slot-c"]) {
          const response = await request("POST", "/bookings", {
            body: { slot_id, name: "Page Patient", email },
            headers: { "X-Forwarded-For": `198.51.100.${30 + slots.findIndex((slot) => slot.id === slot_id)}` },
          });
          assert.equal(response.status, 201);
        }
        const firstPage = await json(
          await request("GET", `/bookings?email=${encodeURIComponent(email)}&limit=2`),
        );
        const firstBookings = firstPage.bookings as JsonObject[];
        assert.equal(firstBookings.length, 2);
        assert.equal(typeof firstPage.next_cursor, "string");
        const secondPage = await json(
          await request(
            "GET",
            `/bookings?email=${encodeURIComponent(email)}&limit=2&cursor=${encodeURIComponent(firstPage.next_cursor as string)}`,
          ),
        );
        const secondBookings = secondPage.bookings as JsonObject[];
        assert.equal(secondBookings.length, 1);
        assert.equal(secondPage.next_cursor, null);
      });

      await t.test("email and IP booking limits return 429 with Retry-After", async () => {
        await reset();
        for (let attempt = 0; attempt < 5; attempt += 1) {
          const response = await request("POST", "/bookings", {
            body: { slot_id: "slot-a", name: "", email: "limited@example.com" },
            headers: { "X-Forwarded-For": `198.51.100.${40 + attempt}` },
          });
          assert.equal(response.status, 400);
        }
        const emailLimited = await request("POST", "/bookings", {
          body: { slot_id: "slot-a", name: "", email: "limited@example.com" },
          headers: { "X-Forwarded-For": "198.51.100.50" },
        });
        assert.equal(emailLimited.status, 429);
        assert.match(emailLimited.headers.get("retry-after") ?? "", /^\d+$/);
        assert.deepEqual(await json(emailLimited), {
          error: "too many booking attempts for this email",
        });

        await reset();
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const response = await request("POST", "/bookings", {
            body: {
              slot_id: "slot-a",
              name: "",
              email: `ip-attempt-${attempt}@example.com`,
            },
            headers: { "X-Forwarded-For": "198.51.100.60" },
          });
          assert.equal(response.status, 400);
        }
        const ipLimited = await request("POST", "/bookings", {
          body: { slot_id: "slot-a", name: "", email: "ip-final@example.com" },
          headers: { "X-Forwarded-For": "198.51.100.60" },
        });
        assert.equal(ipLimited.status, 429);
        assert.match(ipLimited.headers.get("retry-after") ?? "", /^\d+$/);
        assert.deepEqual(await json(ipLimited), {
          error: "too many booking attempts from this IP",
        });
      });
    } finally {
      if (httpServer) {
        await new Promise<void>((resolve, reject) => {
          httpServer?.close((error) => (error ? reject(error) : resolve()));
        });
      }
      if (appPool) await appPool.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await adminPool.end();
    }
  },
);
