import crypto from "node:crypto";
import { NextFunction, Request, Response } from "express";
import { PoolClient, QueryResultRow } from "pg";
import { pool } from "../db";
import {
  normalizeEmailForAttempt,
  normalizeIpForAttempt,
  validateNewBooking,
} from "../validation";
import {
  bookingFromRow,
  errorResponse,
  saveIdempotentResponse,
} from "./shared";

const IP_BOOKING_ATTEMPT_LIMIT = 20;

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

export async function createBooking(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
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
    const ipLimitExceeded =
      Number(ipCount.rows[0].attempts) > IP_BOOKING_ATTEMPT_LIMIT;
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
}
