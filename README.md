# Clinic booking API

TypeScript/Express booking service with PostgreSQL persistence and a small browser UI. The API follows the [Clinic Booking API assessment contract](https://koyaacademy.com/assessment-api). It implements all five levels: API-key access, validation, concurrency-safe booking and cancellation, idempotency and cursor paging, and per-email attempt throttling.

## Run locally

Requirements: Node.js 20+ and PostgreSQL 14+.

1. Create a PostgreSQL database.
2. Copy `.env.example` to `.env`; set `DATABASE_URL` and a long random `API_KEY`.
3. Install and start:

   ```sh
   npm install
   npm run dev
   ```

4. Open `http://localhost:3000` and enter the API key to load available slots.

On startup the app creates the tables and adds six sample slots once. The sample setup is not repeated after `/reset` empties the schedule.

## API

All API routes require `X-API-Key: <API_KEY>`.

| Method | Path | Purpose |
|---|---|---|
| POST | `/reset` | Replace all slots and clear bookings / attempt and idempotency records |
| GET | `/slots?provider=Dr%20Ade` | List slots with availability |
| POST | `/bookings` | Create a booking; optional `Idempotency-Key` |
| GET | `/bookings/{id}` | Look up a booking |
| DELETE | `/bookings/{id}` | Cancel a confirmed booking |
| GET | `/bookings?email=ada@example.com&limit=10&cursor=...` | Page through a person's bookings |

Booking writes are protected by a partial unique database index, so concurrent requests cannot confirm the same slot. The rate limiter and idempotency results are also persisted in PostgreSQL.

## Deploy

The included `render.yaml` is a Render Blueprint for the web service. Push this project to a Git provider, create a PostgreSQL database (for example on Neon), then create a Render Blueprint from the repository. Set `DATABASE_URL` to the database's SSL connection string and `API_KEY` to a secret value in the Render environment. Open the deployed URL and enter that same key in the page. Do not commit `.env` or expose the secret in frontend code.

The web process listens on Render's `PORT`; database schema initialization runs at startup. Use a persistent PostgreSQL service for data retention.

## Verify

```sh
npm test
```
