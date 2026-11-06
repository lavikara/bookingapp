"use client";

import { useCallback, useEffect, useState } from "react";
import type { SubmitEvent } from "react";

type Slot = {
  id: string;
  provider: string;
  start: string;
  end: string;
  available: boolean;
};

type Booking = {
  id: string;
  slot_id: string;
  name: string;
  email: string;
  status: "confirmed" | "cancelled";
  created_at: string;
};

type BookingPage = {
  bookings: Booking[];
  next_cursor: string | null;
};

async function apiRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api/backend${path}`, {
    ...options,
    headers: {
      ...(options?.body ? { "Content-Type": "application/json" } : {}),
      ...(options?.headers ?? {}),
    },
    cache: "no-store",
  });
  const result: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      result && typeof result === "object" && "error" in result &&
      typeof result.error === "string"
        ? result.error
        : `Request failed (${response.status})`;
    throw new Error(message);
  }
  return result as T;
}

function formatTime(date: string): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(date));
}

function fetchSlots(): Promise<{ slots: Slot[] }> {
  return apiRequest<{ slots: Slot[] }>("/slots");
}

export default function Home() {
  const [slots, setSlots] = useState<Slot[]>([]);
  const [selectedSlot, setSelectedSlot] = useState<Slot | null>(null);
  const [loadingSlots, setLoadingSlots] = useState(true);
  const [notice, setNotice] = useState("");
  const [bookingId, setBookingId] = useState("");
  const [foundBooking, setFoundBooking] = useState<Booking | null>(null);
  const [patientEmail, setPatientEmail] = useState("");
  const [bookingPage, setBookingPage] = useState<BookingPage | null>(null);
  const [bookingLoading, setBookingLoading] = useState(false);

  const loadSlots = useCallback(async () => {
    setLoadingSlots(true);
    try {
      const result = await fetchSlots();
      setSlots(result.slots);
      setNotice("");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Unable to load appointments.");
    } finally {
      setLoadingSlots(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    fetchSlots()
      .then((result) => {
        if (active) {
          setSlots(result.slots);
          setNotice("");
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setNotice(error instanceof Error ? error.message : "Unable to load appointments.");
        }
      })
      .finally(() => {
        if (active) setLoadingSlots(false);
      });
    return () => {
      active = false;
    };
  }, []);

  async function submitBooking(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedSlot) return;
    const formData = new FormData(event.currentTarget);
    const form = event.currentTarget;
    const name = String(formData.get("name") ?? "");
    const email = String(formData.get("email") ?? "");
    try {
      const booking = await apiRequest<Booking>("/bookings", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ slot_id: selectedSlot.id, name, email }),
      });
      setBookingId(booking.id);
      setFoundBooking(booking);
      setPatientEmail(email);
      setBookingPage(null);
      setSelectedSlot(null);
      setNotice("Appointment confirmed. Save your booking ID to look it up later.");
      form.reset();
      await loadSlots();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Unable to book this appointment.");
    }
  }

  async function lookupBooking(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const id = bookingId.trim();
    if (!id) return;
    try {
      const booking = await apiRequest<Booking>(`/bookings/${encodeURIComponent(id)}`);
      setFoundBooking(booking);
      setNotice("");
    } catch (error) {
      setFoundBooking(null);
      setNotice(error instanceof Error ? error.message : "Unable to find that booking.");
    }
  }

  async function cancelBooking(booking: Booking) {
    try {
      const cancelled = await apiRequest<Booking>(
        `/bookings/${encodeURIComponent(booking.id)}`,
        { method: "DELETE" },
      );
      setFoundBooking(cancelled);
      setBookingPage((current) => current && ({
        ...current,
        bookings: current.bookings.map((item) => item.id === cancelled.id ? cancelled : item),
      }));
      setNotice("Your appointment has been cancelled.");
      await loadSlots();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Unable to cancel this booking.");
    }
  }

  async function loadPatientBookings(cursor?: string) {
    const email = patientEmail.trim();
    if (!email) return;
    setBookingLoading(true);
    try {
      const query = new URLSearchParams({ email, limit: "10" });
      if (cursor) query.set("cursor", cursor);
      const page = await apiRequest<BookingPage>(`/bookings?${query.toString()}`);
      setBookingPage(page);
      setNotice("");
    } catch (error) {
      setBookingPage(null);
      setNotice(error instanceof Error ? error.message : "Unable to load your bookings.");
    } finally {
      setBookingLoading(false);
    }
  }

  const availableSlots = slots.filter((slot) => slot.available);
  const foundBookingSlot = foundBooking
    ? slots.find((slot) => slot.id === foundBooking.slot_id)
    : undefined;

  return (
    <main className="shell">
      <header className="hero">
        <p className="eyebrow">PATIENT PORTAL</p>
        <h1>Book an appointment</h1>
        <p className="intro">Browse available clinic times and reserve the one that works for you.</p>
      </header>

      <div className="section-heading">
        <div>
          <p className="eyebrow">THE SCHEDULE</p>
          <h2>Available appointments</h2>
        </div>
        <button className="button-secondary" type="button" onClick={() => void loadSlots()} disabled={loadingSlots}>
          {loadingSlots ? "Loading…" : "Refresh"}
        </button>
      </div>

      {notice && <p className="notice" role="status" aria-live="polite">{notice}</p>}

      <section className="slot-grid" aria-live="polite">
        {loadingSlots ? (
          <p className="empty">Loading appointment times…</p>
        ) : availableSlots.length ? (
          availableSlots.map((slot) => (
            <article className="slot-card" key={slot.id}>
              <p className="provider">{slot.provider}</p>
              <h3>{formatTime(slot.start)}</h3>
              <p className="time">
                {formatTime(slot.start)} – {new Intl.DateTimeFormat(undefined, {
                  hour: "numeric",
                  minute: "2-digit",
                }).format(new Date(slot.end))}
              </p>
              <button type="button" onClick={() => setSelectedSlot(slot)}>Choose this time</button>
            </article>
          ))
        ) : (
          <p className="empty">There are no available appointments right now. Please check again soon.</p>
        )}
      </section>

      {selectedSlot && (
        <section className="panel booking-panel" aria-labelledby="booking-heading">
          <div>
            <p className="eyebrow">RESERVE YOUR TIME</p>
            <h2 id="booking-heading">Complete your booking</h2>
            <p className="hint">{selectedSlot.provider} · {formatTime(selectedSlot.start)}</p>
          </div>
          <form className="booking-form" onSubmit={submitBooking}>
            <label htmlFor="patient-name">Full name</label>
            <input id="patient-name" name="name" autoComplete="name" required maxLength={120} />
            <label htmlFor="patient-email">Email address</label>
            <input
              id="patient-email"
              name="email"
              type="email"
              autoComplete="email"
              required
              maxLength={254}
              defaultValue={patientEmail}
            />
            <div className="form-actions">
              <button type="submit">Confirm appointment</button>
              <button className="button-secondary" type="button" onClick={() => setSelectedSlot(null)}>Close</button>
            </div>
          </form>
        </section>
      )}

      {foundBooking && (
        <section className="panel confirmation" aria-live="polite">
          <h2>{foundBooking.status === "confirmed" ? "Booking details" : "Booking cancelled"}</h2>
          <p>Status: {foundBooking.status}</p>
          <p>{foundBooking.name} · {foundBooking.email}</p>
          {foundBookingSlot && (
            <p>{foundBookingSlot.provider} · {formatTime(foundBookingSlot.start)}</p>
          )}
          <p className="booking-id">Booking ID: {foundBooking.id}</p>
          {foundBooking.status === "confirmed" && (
            <button className="button-secondary" type="button" onClick={() => void cancelBooking(foundBooking)}>
              Cancel booking
            </button>
          )}
        </section>
      )}

      <section className="section lookup-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">ALREADY BOOKED?</p>
            <h2>Find a booking</h2>
          </div>
        </div>
        <form className="inline-form" onSubmit={lookupBooking}>
          <label className="sr-only" htmlFor="booking-id">Booking ID</label>
          <input
            id="booking-id"
            value={bookingId}
            onChange={(event) => setBookingId(event.target.value)}
            placeholder="Enter your booking ID"
            required
          />
          <button type="submit">Look up</button>
        </form>
      </section>

      <section className="section lookup-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">BOOKING HISTORY</p>
            <h2>Your bookings</h2>
          </div>
        </div>
        <form
          className="inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            void loadPatientBookings();
          }}
        >
          <label className="sr-only" htmlFor="patient-bookings-email">Email address</label>
          <input
            id="patient-bookings-email"
            type="email"
            value={patientEmail}
            onChange={(event) => setPatientEmail(event.target.value)}
            placeholder="Enter your booking email"
            required
          />
          <button type="submit" disabled={bookingLoading}>
            {bookingLoading ? "Loading…" : "Show bookings"}
          </button>
        </form>
        {bookingPage && (
          <div className="booking-list" aria-live="polite">
            {bookingPage.bookings.length ? bookingPage.bookings.map((booking) => (
              <article className="lookup-booking" key={booking.id}>
                <p><strong>{booking.status}</strong> · {booking.name}</p>
                <p>Booking ID: {booking.id}</p>
                {booking.status === "confirmed" && (
                  <button className="button-secondary" type="button" onClick={() => void cancelBooking(booking)}>
                    Cancel booking
                  </button>
                )}
              </article>
            )) : <p className="empty">No bookings found for that email.</p>}
            {bookingPage.next_cursor && (
              <button
                className="button-secondary"
                type="button"
                disabled={bookingLoading}
                onClick={(event) => {
                  event.preventDefault();
                  void loadPatientBookings(bookingPage.next_cursor ?? undefined);
                }}
              >
                Next page
              </button>
            )}
          </div>
        )}
      </section>

      <footer>Clinic appointments · Your details are used only to manage your booking.</footer>
    </main>
  );
}
