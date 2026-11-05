import { Request, Response, NextFunction } from "express";
import { PoolClient } from "pg";
import { pool } from "../db";
import { errorResponse, Slot } from "./shared";

export async function resetSlots(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
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
}
