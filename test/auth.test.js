"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { hashPassword, verifyPassword, tokenHash, validISODate } = require("../lib/auth");

test("password hashes are salted and verify only the matching password", async () => {
  const first = await hashPassword("correct horse battery staple");
  const second = await hashPassword("correct horse battery staple");

  assert.notEqual(first, second);
  assert.equal(await verifyPassword("correct horse battery staple", first), true);
  assert.equal(await verifyPassword("incorrect password", first), false);
  assert.equal(await verifyPassword("anything", "invalid"), false);
});

test("invitation tokens can be stored as one-way stable hashes", () => {
  const token = "one-time-secret";
  assert.equal(tokenHash(token), tokenHash(token));
  assert.notEqual(tokenHash(token), tokenHash("another-secret"));
  assert.match(tokenHash(token), /^[a-f0-9]{64}$/);
});

test("date validation rejects impossible calendar dates", () => {
  assert.equal(validISODate("2024-02-29"), true);
  assert.equal(validISODate("2025-02-29"), false);
  assert.equal(validISODate("2025-02-31"), false);
  assert.equal(validISODate("not-a-date"), false);
});
