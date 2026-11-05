import { isIP } from "node:net";

export type NewBookingInput = {
  slot_id: string;
  name: string;
  email: string;
};

export type ValidationResult =
  | { valid: true; value: NewBookingInput }
  | { valid: false; error: string };

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validateNewBooking(body: unknown): ValidationResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { valid: false, error: "request body must be an object" };
  }

  const record = body as Record<string, unknown>;
  if (typeof record.slot_id !== "string" || !record.slot_id.trim()) {
    return { valid: false, error: "slot_id is required" };
  }
  if (typeof record.name !== "string" || !record.name.trim()) {
    return { valid: false, error: "name is required" };
  }
  if (typeof record.email !== "string" || !record.email.trim()) {
    return { valid: false, error: "email is required" };
  }

  const name = record.name.trim();
  const email = record.email.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(email)) {
    return { valid: false, error: "email must be valid" };
  }

  return {
    valid: true,
    value: { slot_id: record.slot_id.trim(), name, email },
  };
}

export function normalizeEmailForAttempt(email: unknown): string | null {
  if (typeof email !== "string" || !email.trim()) return null;
  return email.trim().toLowerCase();
}

export function normalizeIpForAttempt(ip: unknown): string | null {
  if (typeof ip !== "string") return null;
  const normalized = ip.trim().toLowerCase();
  const version = isIP(normalized);
  if (!normalized || version === 0) return null;
  if (version === 4) return normalized;

  const canonical = new URL(`http://[${normalized}]/`).hostname.slice(1, -1);
  if (canonical.startsWith("::ffff:")) {
    const mappedIpv4 = canonical.slice("::ffff:".length);
    if (isIP(mappedIpv4) === 4) return mappedIpv4;
    const mappedWords = mappedIpv4.split(":");
    if (mappedWords.length === 2) {
      const high = Number.parseInt(mappedWords[0], 16);
      const low = Number.parseInt(mappedWords[1], 16);
      return [
        high >> 8,
        high & 255,
        low >> 8,
        low & 255,
      ].join(".");
    }
  }

  return canonical;
}

export type BookingCursor = { createdAt: string; id: string };

export function decodeCursor(value: string): BookingCursor | null {
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    const separator = decoded.indexOf("|");
    if (separator <= 0) return null;
    const createdAt = decoded.slice(0, separator);
    const id = decoded.slice(separator + 1);
    if (!Number.isFinite(Date.parse(createdAt))) return null;
    if (!UUID_PATTERN.test(id)) return null;
    return { createdAt: new Date(createdAt).toISOString(), id };
  } catch {
    return null;
  }
}

export function encodeCursor(cursor: BookingCursor): string {
  return Buffer.from(`${cursor.createdAt}|${cursor.id}`).toString("base64url");
}

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}
