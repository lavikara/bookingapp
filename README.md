# Clinic booking API

TypeScript/Express booking API with PostgreSQL persistence. The API follows the [Clinic Booking API assessment contract](https://koyaacademy.com/assessment-api). It implements all five levels: API-key access, validation, concurrency-safe booking and cancellation, idempotency and cursor paging, and per-email and per-IP attempt throttling.

## Run locally

Requirements: Node.js 20+ and PostgreSQL 14+.

1. Create a PostgreSQL database.
2. Copy `.env.example` to `.env`; set `DATABASE_URL` and a long random `API_KEY`.
3. Install and start:

   ```sh
   npm install
   npm run dev
   ```

4. The API listens at `http://localhost:3000`; `GET /health` is its unauthenticated health check. To run the separate patient frontend, follow [`frontend/README.md`](./frontend/README.md) and set its `BACKEND_API_URL` to `http://localhost:3000`.

On startup the app creates the tables and adds six sample slots once. The sample setup is not repeated after `/reset` empties the schedule.

## Backend structure

- `src/server.ts` configures Express, middleware, startup, and shutdown.
- `src/routes/apiRoutes.ts` maps API paths to controller handlers.
- `src/controllers/` contains the reset, slot, and booking request handlers.
- `src/controllers/shared.ts` holds response and booking-row helpers shared by controllers.

## Separate Next.js frontend

The standalone Next.js patient frontend is in [`frontend/`](./frontend/). It uses
a server-side proxy to call this API, so the API key is not exposed to browser
code. See [`frontend/README.md`](./frontend/README.md) for local setup and
separate deployment instructions. Set `BACKEND_API_URL` and `BACKEND_API_KEY`
in the frontend hosting environment; do not use a `NEXT_PUBLIC_` prefix for the
key.

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

Booking writes are protected by a partial unique database index, so concurrent requests cannot confirm the same slot. Booking attempts are limited to 5 per email and 20 per client IP in a rolling 60-second window; both limits and idempotency results are persisted in PostgreSQL. The API trusts one proxy hop for direct requests from Render, and the Next.js proxy forwards the client IP observed by its Render ingress.

## Deploy

The included `render.yaml` is a Render Blueprint for the API and the separate Next.js frontend. Push this project to a Git provider, create a PostgreSQL database (for example on Neon), then create or sync a Render Blueprint from the repository. Set `DATABASE_URL` to the database's SSL connection string and `API_KEY` to a secret value in the API service environment. Set `BACKEND_API_URL` and `BACKEND_API_KEY` in the frontend service environment. Do not commit `.env` files or expose the secret in frontend code.

The web process listens on Render's `PORT`; database schema initialization runs at startup. Use a persistent PostgreSQL service for data retention.

## Verify

```sh
npm test
```

`npm test` always runs the validation unit tests and also runs the HTTP endpoint
suite when `TEST_DATABASE_URL` is set. The endpoint suite creates a temporary
PostgreSQL schema and drops it afterward; use a database account with permission
to create schemas. To run only those tests, use `npm run test:integration`.
