import "dotenv/config";
import crypto from "node:crypto";
import express, { NextFunction, Request, Response } from "express";
import { PoolClient, QueryResultRow } from "pg";
import { initializeDatabase, pool } from "./db";
import {
  decodeCursor,
  encodeCursor,
  isUuid,
  normalizeEmailForAttempt,
  normalizeIpForAttempt,
  validateNewBooking,
} from "./validation";

type Booking = {
  id: string;
  slot_id: string;
  name: string;
  email: string;
  status: "confirmed" | "cancelled";
  created_at: Date;
};

type Slot = {
  id: string;
  provider: string;
  start: Date;
  end: Date;
};

const app = express();
const apiKey = process.env.API_KEY;
const IP_BOOKING_ATTEMPT_LIMIT = 20;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be configured");
}
if (!apiKey) {
  throw new Error("API_KEY must be configured");
}

app.use(express.json({ limit: "16kb" }));
app.set("trust proxy", 1);

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use((req: Request, res: Response, next: NextFunction) => {
  const isApiRequest =
    req.path === "/slots" ||
    req.path === "/reset" ||
    req.path === "/bookings" ||
    req.path.startsWith("/bookings/");
  if (isApiRequest && req.header("X-API-Key") !== apiKey) {
    res.status(401).json({ error: "missing or invalid API key" });
    return;
  }
  next();
});

function errorResponse(res: Response, status: number, error: string): void {
  res.status(status).json({ error });
}

function bookingFromRow(row: QueryResultRow): Booking {
  return {
    id: row.id,
    slot_id: row.slot_id,
    name: row.name,
    email: row.email,
    status: row.status,
    created_at: row.created_at,
  };
}

function stableBodyHash(body: unknown): string {
  const record =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const canonical = JSON.stringify({
    slot_id: record.slot_id,
    name: record.name,
    email: record.email,
  });
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

async function saveIdempotentResponse(
  client: PoolClient,
  key: string | undefined,
  requestHash: string,
  status: number,
  body: object,
): Promise<void> {
  if (!key) return;
  await client.query(
    `INSERT INTO idempotency_records
       (idempotency_key, request_hash, response_status, response_body)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [key, requestHash, status, JSON.stringify(body)],
  );
}

app.post("/reset", async (req, res, next) => {
  if (!req.body || !Array.isArray(req.body.slots)) {
    errorResponse(res, 400, "slots must be an array");
    return;
  }
  const slots: Slot[] = [];
  const slotIds = new Set<string>();
  for (const candidate of req.body.slots as unknown[]) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      errorResponse(res, 400, "each slot must be an object");
      return;
    }
    const slot = candidate as Record<string, unknown>;
    if (
      typeof slot.id !== "string" ||
      !slot.id.trim() ||
      typeof slot.provider !== "string" ||
      !slot.provider.trim() ||
      typeof slot.start !== "string" ||
      typeof slot.end !== "string" ||
      !Number.isFinite(Date.parse(slot.start)) ||
      !Number.isFinite(Date.parse(slot.end)) ||
      Date.parse(slot.end) <= Date.parse(slot.start)
    ) {
      errorResponse(res, 400, "each slot needs a valid id, provider, start, and end");
      return;
    }
    const id = slot.id.trim();
    if (slotIds.has(id)) {
      errorResponse(res, 400, "slot ids must be unique");
      return;
    }
    slotIds.add(id);
    slots.push({
      id,
      provider: slot.provider.trim(),
      start: new Date(slot.start),
      end: new Date(slot.end),
    });
  }

  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    await client.query("DELETE FROM bookings");
    await client.query("DELETE FROM slots");
    await client.query("DELETE FROM idempotency_records");
    await client.query("DELETE FROM booking_attempts");
    await client.query("DELETE FROM booking_ip_attempts");
    for (const slot of slots) {
      await client.query(
        "INSERT INTO slots (id, provider, start_at, end_at) VALUES ($1, $2, $3, $4)",
        [slot.id, slot.provider, slot.start, slot.end],
      );
    }
    await client.query("COMMIT");
    res.status(200).json({ message: "slots replaced" });
  } catch (error) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("Failed to roll back slot reset", rollbackError);
      }
    }
    next(error);
  } finally {
    client?.release();
  }
});

app.get("/slots", async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT s.id, s.provider, s.start_at AS start, s.end_at AS end,
              (b.id IS NULL) AS available
       FROM slots s
       LEFT JOIN bookings b
         ON b.slot_id = s.id AND b.status = 'confirmed'
       WHERE ($1::text IS NULL OR s.provider = $1)
       ORDER BY s.start_at ASC, s.id ASC`,
      [typeof req.query.provider === "string" ? req.query.provider : null],
    );
    res.json({ slots: result.rows });
  } catch (error) {
    next(error);
  }
});

app.post("/bookings", async (req, res, next) => {
  const idemKey = req.header("Idempotency-Key") || undefined;
  if (idemKey && idemKey.length > 255) {
    errorResponse(res, 400, "Idempotency-Key must be 255 characters or fewer");
    return;
  }

  const requestHash = stableBodyHash(req.body);
  const emailForLimit = normalizeEmailForAttempt(
    req.body && typeof req.body === "object"
      ? (req.body as Record<string, unknown>).email
      : null,
  );
  const ipForLimit = normalizeIpForAttempt(
    req.header("X-Booking-Client-IP") ?? req.ip,
  );
  if (!ipForLimit) {
    errorResponse(res, 500, "unable to determine request IP address");
    return;
  }
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    if (idemKey) {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `idem:${idemKey}`,
      ]);
      const previous = await client.query<{
        request_hash: string;
        response_status: number;
        response_body: object;
      }>(
        `SELECT request_hash, response_status, response_body
         FROM idempotency_records WHERE idempotency_key = $1`,
        [idemKey],
      );
      if (previous.rowCount) {
        await client.query("COMMIT");
        const stored = previous.rows[0];
        if (stored.request_hash !== requestHash) {
          errorResponse(res, 422, "Idempotency-Key was already used with a different body");
        } else {
          res.status(stored.response_status).json(stored.response_body);
        }
        return;
      }
    }

    await client.query(
      "DELETE FROM booking_ip_attempts WHERE attempted_at < clock_timestamp() - interval '60 seconds'",
    );
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `attempt-ip:${ipForLimit}`,
    ]);
    await client.query(
      "INSERT INTO booking_ip_attempts (ip_address) VALUES ($1)",
      [ipForLimit],
    );
    const ipCount = await client.query<{
      attempts: string;
      retry_after: number | null;
    }>(
      `SELECT COUNT(*)::text AS attempts,
              GREATEST(1, CEIL(EXTRACT(EPOCH FROM
                (MIN(attempted_at) + interval '60 seconds' - clock_timestamp())
              )))::integer AS retry_after
       FROM booking_ip_attempts
       WHERE ip_address = $1 AND attempted_at >= clock_timestamp() - interval '60 seconds'`,
      [ipForLimit],
    );
    const ipLimitExceeded = Number(ipCount.rows[0].attempts) > IP_BOOKING_ATTEMPT_LIMIT;
    const ipRetryAfter = ipCount.rows[0].retry_after ?? 1;

    let emailLimitExceeded = false;
    let emailRetryAfter = 1;
    if (emailForLimit) {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `attempt:${emailForLimit}`,
      ]);
      await client.query(
        "DELETE FROM booking_attempts WHERE email = $1 AND attempted_at < clock_timestamp() - interval '60 seconds'",
        [emailForLimit],
      );
      await client.query(
        "INSERT INTO booking_attempts (email) VALUES ($1)",
        [emailForLimit],
      );
      const count = await client.query<{
        attempts: string;
        retry_after: number | null;
      }>(
        `SELECT COUNT(*)::text AS attempts,
                GREATEST(1, CEIL(EXTRACT(EPOCH FROM
                  (MIN(attempted_at) + interval '60 seconds' - clock_timestamp())
                )))::integer AS retry_after
         FROM booking_attempts
         WHERE email = $1 AND attempted_at >= clock_timestamp() - interval '60 seconds'`,
        [emailForLimit],
      );
      emailLimitExceeded = Number(count.rows[0].attempts) > 5;
      emailRetryAfter = count.rows[0].retry_after ?? 1;
    }

    if (emailLimitExceeded || ipLimitExceeded) {
      await client.query("COMMIT");
      res.setHeader(
        "Retry-After",
        String(emailLimitExceeded ? emailRetryAfter : ipRetryAfter),
      );
      errorResponse(
        res,
        429,
        emailLimitExceeded
          ? "too many booking attempts for this email"
          : "too many booking attempts from this IP",
      );
      return;
    }

    const validation = validateNewBooking(req.body);
    if (!validation.valid) {
      const body = { error: validation.error };
      await saveIdempotentResponse(client, idemKey, requestHash, 400, body);
      await client.query("COMMIT");
      res.status(400).json(body);
      return;
    }

    const { slot_id, name, email } = validation.value;
    const slotResult = await client.query<{ start_at: Date }>(
      "SELECT start_at FROM slots WHERE id = $1",
      [slot_id],
    );
    if (!slotResult.rowCount) {
      const body = { error: "slot not found" };
      await saveIdempotentResponse(client, idemKey, requestHash, 404, body);
      await client.query("COMMIT");
      res.status(404).json(body);
      return;
    }
    if (new Date(slotResult.rows[0].start_at).getTime() <= Date.now()) {
      const body = { error: "slot has already started" };
      await saveIdempotentResponse(client, idemKey, requestHash, 400, body);
      await client.query("COMMIT");
      res.status(400).json(body);
      return;
    }

    const id = crypto.randomUUID();
    const inserted = await client.query<QueryResultRow>(
      `INSERT INTO bookings (id, slot_id, name, email, status)
       VALUES ($1, $2, $3, $4, 'confirmed')
       ON CONFLICT (slot_id) WHERE status = 'confirmed' DO NOTHING
       RETURNING id, slot_id, name, email, status, created_at`,
      [id, slot_id, name, email],
    );
    if (!inserted.rowCount) {
      const body = { error: "slot is already booked" };
      await saveIdempotentResponse(client, idemKey, requestHash, 409, body);
      await client.query("COMMIT");
      res.status(409).json(body);
      return;
    }

    const booking = bookingFromRow(inserted.rows[0]);
    await saveIdempotentResponse(client, idemKey, requestHash, 201, booking);
    await client.query("COMMIT");
    res.status(201).json(booking);
  } catch (error) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("Failed to roll back booking request", rollbackError);
      }
    }
    next(error);
  } finally {
    client?.release();
  }
});

app.get("/bookings", async (req, res, next) => {
  const email = typeof req.query.email === "string" ? req.query.email.trim().toLowerCase() : "";
  if (!email) {
    errorResponse(res, 400, "email is required");
    return;
  }
  const limitValue = req.query.limit === undefined ? "10" : String(req.query.limit);
  if (!/^\d+$/.test(limitValue) || Number(limitValue) < 1 || Number(limitValue) > 50) {
    errorResponse(res, 400, "limit must be between 1 and 50");
    return;
  }
  const limit = Number(limitValue);
  const cursorValue = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
  const cursor = cursorValue ? decodeCursor(cursorValue) : null;
  if (cursorValue && !cursor) {
    errorResponse(res, 400, "cursor is invalid");
    return;
  }

  try {
    const result = cursor
      ? await pool.query(
          `SELECT id, slot_id, name, email, status, created_at
           FROM bookings
           WHERE email = $1 AND (created_at, id) > ($2::timestamptz, $3::uuid)
           ORDER BY created_at ASC, id ASC
           LIMIT $4`,
          [email, cursor.createdAt, cursor.id, limit + 1],
        )
      : await pool.query(
          `SELECT id, slot_id, name, email, status, created_at
           FROM bookings WHERE email = $1
           ORDER BY created_at ASC, id ASC
           LIMIT $2`,
          [email, limit + 1],
        );

    const hasMore = result.rows.length > limit;
    const pageRows = result.rows.slice(0, limit);
    const bookings = pageRows.map(bookingFromRow);
    const last = pageRows[pageRows.length - 1];
    res.json({
      bookings,
      next_cursor:
        hasMore && last
          ? encodeCursor({
              createdAt: new Date(last.created_at).toISOString(),
              id: last.id,
            })
          : null,
    });
  } catch (error) {
    next(error);
  }
});

app.get("/bookings/:id", async (req, res, next) => {
  if (!isUuid(req.params.id)) {
    errorResponse(res, 404, "booking not found");
    return;
  }
  try {
    const result = await pool.query(
      `SELECT id, slot_id, name, email, status, created_at
       FROM bookings WHERE id = $1`,
      [req.params.id],
    );
    if (!result.rowCount) {
      errorResponse(res, 404, "booking not found");
      return;
    }
    res.json(bookingFromRow(result.rows[0]));
  } catch (error) {
    next(error);
  }
});

app.delete("/bookings/:id", async (req, res, next) => {
  if (!isUuid(req.params.id)) {
    errorResponse(res, 404, "booking not found");
    return;
  }
  try {
    const result = await pool.query(
      `UPDATE bookings
       SET status = 'cancelled'
       WHERE id = $1 AND status = 'confirmed'
       RETURNING id, slot_id, name, email, status, created_at`,
      [req.params.id],
    );
    if (result.rowCount) {
      res.json(bookingFromRow(result.rows[0]));
      return;
    }
    const existing = await pool.query<{ status: string }>(
      "SELECT status FROM bookings WHERE id = $1",
      [req.params.id],
    );
    if (!existing.rowCount) {
      errorResponse(res, 404, "booking not found");
      return;
    }
    errorResponse(res, 409, "booking is already cancelled");
  } catch (error) {
    next(error);
  }
});

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof SyntaxError && "body" in error) {
    errorResponse(res, 400, "request body must be valid JSON");
    return;
  }
  console.error("Request failed", error);
  errorResponse(res, 500, "internal server error");
});

let httpServer: ReturnType<typeof app.listen> | undefined;

async function start(): Promise<void> {
  await initializeDatabase();
  const port = Number(process.env.PORT ?? 3000);
  httpServer = app.listen(port, "0.0.0.0", () => {
    console.log(`Clinic booking app listening on port ${port}`);
  });
}

void start().catch((error: unknown) => {
  console.error("Failed to start clinic booking app", error);
  process.exitCode = 1;
});

function shutdown(): void {
  if (!httpServer) {
    void pool.end();
    return;
  }
  httpServer.close((error) => {
    if (error) {
      console.error("Failed to close HTTP server", error);
      process.exitCode = 1;
    }
    void pool.end().catch((poolError: unknown) => {
      console.error("Failed to close database pool", poolError);
      process.exitCode = 1;
    });
  });
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
