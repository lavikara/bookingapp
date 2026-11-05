import { Request, Response, NextFunction } from "express";
import { pool } from "../db";

export async function listSlots(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
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
}
