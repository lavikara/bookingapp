# Clinic Booking Frontend

Standalone Next.js frontend for the clinic booking API. The browser only talks to
the Next.js `/api/backend` route. That server-side route adds `X-API-Key` from
`BACKEND_API_KEY`, so the backend key is never included in browser code or
responses.

## Run locally

1. Copy `.env.example` to `.env.local`.
2. Set `BACKEND_API_KEY` to the same secret configured on the backend. Keep the
   key server-side; do not rename it to a `NEXT_PUBLIC_` variable.
3. Install dependencies and start the frontend:

   ```sh
   npm install
   npm run dev
   ```

4. Open <http://localhost:3000>.

`BACKEND_API_URL` defaults in `.env.example` to the deployed API base URL. It can
be changed to another backend URL without changing the app.

## Deploy separately

Deploy this `frontend` directory as its own Next.js project (for example, as the
Vercel project root). Configure `BACKEND_API_URL` and `BACKEND_API_KEY` as
server-side environment variables in the hosting provider. The frontend server
must be able to make HTTPS requests to the backend.

The proxy allows only `GET /slots`, `GET /bookings` (including booking lookup by
ID), `POST /bookings`, and `DELETE /bookings/{id}` for ordinary frontend
requests. It also forwards `POST /reset` only when the caller explicitly
provides the valid `X-API-Key` header; this destructive admin operation is not
invoked by the patient UI and does not inherit the server-side key implicitly.

When `GET /api/backend/slots` reaches a sleeping backend, the request itself
wakes the Render service. The proxy retries transient network errors and
HTTP 429/502/503/504 responses with backoff for up to about 60 seconds of
scheduled delay, allowing the backend time to start before showing an error.
