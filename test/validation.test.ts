import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeCursor,
  encodeCursor,
  normalizeEmailForAttempt,
  validateNewBooking,
} from "../src/validation";

test("booking input trims the name and normalizes email", () => {
  assert.deepEqual(validateNewBooking({
    slot_id: " s1 ",
    name: " Ada Obi ",
    email: " ADA@EXAMPLE.COM ",
  }), {
    valid: true,
    value: { slot_id: "s1", name: "Ada Obi", email: "ada@example.com" },
  });
});

test("booking input rejects missing fields and malformed email", () => {
  assert.equal(validateNewBooking({ slot_id: "s1", name: "Ada", email: "" }).valid, false);
  assert.equal(validateNewBooking({ slot_id: "s1", name: "Ada", email: "not-an-email" }).valid, false);
});

test("email rate-limit key is normalized", () => {
  assert.equal(normalizeEmailForAttempt(" ADA@example.com "), "ada@example.com");
  assert.equal(normalizeEmailForAttempt(null), null);
});

test("booking cursors round-trip and reject malformed values", () => {
  const cursor = {
    createdAt: "2026-11-05T12:30:00.000Z",
    id: "2f1e8a40-7104-4f3a-98e4-dd0f3113ad6f",
  };
  assert.deepEqual(decodeCursor(encodeCursor(cursor)), cursor);
  assert.equal(decodeCursor("not-a-cursor"), null);
});
