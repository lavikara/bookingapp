import { Pool } from "pg";

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("sslmode=require")
    ? { rejectUnauthorized: false }
    : undefined,
});

export async function initializeDatabase(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS slots (
      id text PRIMARY KEY,
      provider text NOT NULL,
      start_at timestamptz NOT NULL,
      end_at timestamptz NOT NULL,
      CHECK (end_at > start_at)
    );

    CREATE TABLE IF NOT EXISTS bookings (
      id uuid PRIMARY KEY,
      slot_id text NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
      name text NOT NULL,
      email text NOT NULL,
      status text NOT NULL CHECK (status IN ('confirmed', 'cancelled')),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS bookings_one_confirmed_per_slot
      ON bookings(slot_id) WHERE status = 'confirmed';
    CREATE INDEX IF NOT EXISTS bookings_email_created_idx
      ON bookings(email, created_at, id);

    CREATE TABLE IF NOT EXISTS idempotency_records (
      idempotency_key text PRIMARY KEY,
      request_hash text NOT NULL,
      response_status integer NOT NULL,
      response_body jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp()
    );

    CREATE TABLE IF NOT EXISTS booking_attempts (
      email text NOT NULL,
      attempted_at timestamptz NOT NULL DEFAULT clock_timestamp()
    );
    CREATE INDEX IF NOT EXISTS booking_attempts_email_time_idx
      ON booking_attempts(email, attempted_at);

    CREATE TABLE IF NOT EXISTS booking_ip_attempts (
      ip_address text NOT NULL,
      attempted_at timestamptz NOT NULL DEFAULT clock_timestamp()
    );
    CREATE INDEX IF NOT EXISTS booking_ip_attempts_address_time_idx
      ON booking_ip_attempts(ip_address, attempted_at);
    CREATE INDEX IF NOT EXISTS booking_ip_attempts_expiry_idx
      ON booking_ip_attempts(attempted_at);

    CREATE TABLE IF NOT EXISTS app_meta (
      key text PRIMARY KEY,
      value text NOT NULL
    );
  `);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO app_meta (key, value) VALUES ('sample_slots_seeded', 'false') ON CONFLICT (key) DO NOTHING",
    );
    const result = await client.query<{ value: string }>(
      "SELECT value FROM app_meta WHERE key = 'sample_slots_seeded' FOR UPDATE",
    );
    if (result.rows[0]?.value === "false") {
      const start = new Date();
      start.setUTCDate(start.getUTCDate() + 1);
      start.setUTCHours(9, 0, 0, 0);
      for (let index = 0; index < 6; index += 1) {
        const slotStart = new Date(start.getTime() + index * 30 * 60_000);
        const slotEnd = new Date(slotStart.getTime() + 30 * 60_000);
        await client.query(
          `INSERT INTO slots (id, provider, start_at, end_at)
           VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
          [
            `s${index + 1}`,
            index < 3 ? "Dr Ade" : "Dr Okafor",
            slotStart,
            slotEnd,
          ],
        );
      }
      await client.query(
        "UPDATE app_meta SET value = 'true' WHERE key = 'sample_slots_seeded'",
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
