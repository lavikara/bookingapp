import { NextFunction, Request, Response } from "express";
import { pool } from "../db";
import { decodeCursor, encodeCursor, isUuid } from "../validation";
import { bookingFromRow, errorResponse } from "./shared";

export async function listBookings(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const email =
    typeof req.query.email === "string" ? req.query.email.trim().toLowerCase() : "";
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
  const cursorValue =
    typeof req.query.cursor === "string" ? req.query.cursor : undefined;
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
}

export async function getBooking(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
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
}

export async function cancelBooking(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
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
}
