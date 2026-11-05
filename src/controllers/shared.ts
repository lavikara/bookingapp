import { PoolClient, QueryResultRow } from "pg";

export type Booking = {
  id: string;
  slot_id: string;
  name: string;
  email: string;
  status: "confirmed" | "cancelled";
  created_at: Date;
};

export type Slot = {
  id: string;
  provider: string;
  start: Date;
  end: Date;
};

export function errorResponse(
  res: import("express").Response,
  status: number,
  error: string,
): void {
  res.status(status).json({ error });
}

export function bookingFromRow(row: QueryResultRow): Booking {
  return {
    id: row.id,
    slot_id: row.slot_id,
    name: row.name,
    email: row.email,
    status: row.status,
    created_at: row.created_at,
  };
}

export async function saveIdempotentResponse(
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
