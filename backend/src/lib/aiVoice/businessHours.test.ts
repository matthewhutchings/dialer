import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { businessHours } from "./businessHours.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("London working hours are 9 am inclusive to 5 pm exclusive, weekdays, including BST", async () => {
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return Response.json({ "england-and-wales": { events: [
      { date: "2026-01-01" }, { date: "2026-04-03" }, { date: "2026-04-06" },
      { date: "2026-05-04" }, { date: "2026-05-25" }, { date: "2026-08-31" },
      { date: "2026-12-25" }, { date: "2026-12-28" }, { date: "2027-01-01" },
    ] } });
  };
  for (const [date, expected] of [
    ["2026-10-29T08:59:59Z", false], ["2026-10-29T09:00:00Z", true],
    ["2026-10-29T16:59:59Z", true], ["2026-10-29T17:00:00Z", false],
    ["2026-07-08T07:59:59Z", false], ["2026-07-08T08:00:00Z", true],
    ["2026-07-08T16:00:00Z", false], ["2026-10-31T12:00:00Z", false],
    ["2026-11-01T12:00:00Z", false], ["2026-12-25T10:00:00Z", false],
    ["2026-12-28T10:00:00Z", false], ["2026-08-31T10:00:00Z", false],
    ["2026-04-03T10:00:00Z", false], ["2026-04-06T10:00:00Z", false],
  ] as const) {
    assert.equal((await businessHours(new Date(date))).open, expected, date);
  }
  assert.equal(requests, 1);
  await assert.rejects(businessHours(new Date("2035-02-01T10:00:00Z")), /does not cover this year/);
});

test("expired, unavailable and malformed bank-holiday data never allow a transfer", async (t) => {
  t.mock.method(Date, "now", () => originalNow + 2 * 86_400_000);
  for (const body of [null, {}, { "england-and-wales": { events: [] } }, { "england-and-wales": { events: [{ date: "bad" }] } }]) {
    globalThis.fetch = async () => Response.json(body);
    await assert.rejects(businessHours(new Date("2026-10-29T10:00:00Z")), /invalid/);
  }
  globalThis.fetch = async () => Response.json({}, { status: 503 });
  await assert.rejects(businessHours(new Date("2026-10-29T10:00:00Z")), /unavailable/);
});

const originalNow = Date.now();
