import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { availableSlots, bookMeeting, preloadCalendar, remainingWeek, spokenMeetingTime, type BookingInput, type BookingState } from "./booking.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const slot = "2026-11-03T10:00:00.000Z";
const input: BookingInput = { start: slot, name: "Test Attendee", email: "attendee@example.test", timezone: "Europe/London" };
const result = {
  id: "fake-booking", start: slot, end: "2026-11-03T10:30:00.000Z",
  meetLink: null, manageUrl: "https://booking.example.test/#manage=private",
};

test("booking is persisted before side effects and unknown outcomes reuse the exact key and payload", async () => {
  let persisted = "";
  const requests: { key: string; body: string }[] = [];
  globalThis.fetch = async (_url, init) => {
    assert.ok(persisted.includes('"attempt"'));
    requests.push({ key: new Headers(init?.headers).get("Idempotency-Key") || "", body: String(init?.body) });
    if (requests.length === 1) throw new Error("response lost");
    return Response.json(result, { status: 201 });
  };
  let state: BookingState = { slots: [slot] };
  const persist = async () => { persisted = JSON.stringify(state); };
  await assert.rejects(bookMeeting(state, input, persist), /uncertain/);
  state = JSON.parse(persisted) as BookingState;
  assert.deepEqual(await bookMeeting(state, input, persist), result);
  assert.match(requests[0].key, /^[a-f0-9]{64}$/);
  assert.deepEqual(requests[0], requests[1]);
  await assert.rejects(bookMeeting(state, { ...input, email: "other@example.test" }, persist), /original details/);
  assert.equal(requests.length, 2);
});

test("booking refuses fabricated slots, invalid timezones and persistence failures", async () => {
  let sent = 0;
  globalThis.fetch = async () => { sent++; return Response.json(result); };
  await assert.rejects(bookMeeting({}, input, async () => {}), /exact slot/);
  await assert.rejects(bookMeeting({ slots: [slot] }, { ...input, timezone: "Invalid/Zone" }, async () => {}), /actual name/);
  await assert.rejects(bookMeeting({ slots: [slot] }, input, async () => { throw new Error("CRM unavailable"); }), /CRM unavailable/);
  assert.equal(sent, 0);
});

test("confirmed slot conflicts require fresh availability and a new confirmed choice", async () => {
  const state: BookingState = { slots: [slot] };
  const keys: string[] = [];
  globalThis.fetch = async (_url, init) => {
    keys.push(new Headers(init?.headers).get("Idempotency-Key") || "");
    return keys.length === 1
      ? Response.json({ error: "That time is no longer available" }, { status: 409 })
      : Response.json({ ...result, start: "2026-11-03T11:00:00.000Z" }, { status: 201 });
  };
  await assert.rejects(bookMeeting(state, input, async () => {}), /no longer available/);
  assert.deepEqual(state.slots, []);
  const newSlot = "2026-11-03T11:00:00.000Z";
  await assert.rejects(bookMeeting(state, { ...input, start: newSlot }, async () => {}), /exact slot/);
  state.slots = [newSlot];
  await bookMeeting(state, { ...input, start: newSlot }, async () => {});
  assert.notEqual(keys[0], keys[1]);
});

test("generic key conflicts and cancelled bookings never silently create replacements", async () => {
  for (const status of [409, 410, 502, 503, 429]) {
    const state: BookingState = { slots: [slot] };
    globalThis.fetch = async () => Response.json({ error: "Key details conflict" }, { status });
    await assert.rejects(bookMeeting(state, input, async () => {}));
    const key = state.attempt?.key;
    await assert.rejects(bookMeeting(state, { ...input, name: "Different Attendee" }, async () => {}), /original details/);
    assert.equal(state.attempt?.key, key);
  }
});

test("availability uses explicit offsets, checks calendar connection and preserves UTC slots", async () => {
  let connected = false;
  let requests = 0;
  globalThis.fetch = async (url) => {
    requests++;
    return String(url).endsWith("/api/event")
      ? Response.json({ connected, durationMinutes: 30, timezone: "Europe/London", minNoticeHours: 4, maxDaysAhead: 60 })
      : Response.json({ slots: [slot] });
  };
  await assert.rejects(availableSlots("2026-11-03T00:00:00", "2026-11-04T00:00:00"), /explicit-offset/);
  assert.equal(requests, 0);
  await assert.rejects(availableSlots("2026-11-03T00:00:00Z", "2026-11-04T00:00:00Z"), /disconnected/);
  connected = true;
  assert.deepEqual(await availableSlots("2026-11-03T00:00:00Z", "2026-11-04T00:00:00Z"), [slot]);
});

test("preload covers the remaining London week including DST and year boundaries", () => {
  for (const [start, end] of [
    ["2026-10-29T15:00:00Z", "2026-11-02T00:00:00.000Z"],
    ["2026-07-08T12:00:00Z", "2026-07-12T23:00:00.000Z"],
    ["2026-03-28T12:00:00Z", "2026-03-29T23:00:00.000Z"],
    ["2026-10-24T12:00:00Z", "2026-10-26T00:00:00.000Z"],
    ["2026-07-12T23:30:00Z", "2026-07-19T23:00:00.000Z"],
    ["2026-12-31T12:00:00Z", "2027-01-04T00:00:00.000Z"],
  ]) {
    assert.deepEqual(remainingWeek(new Date(start)), { start: new Date(start).toISOString(), end });
  }
});

test("preloaded calendar contains genuine slots and spoken am/pm labels without duplicate metadata reads", async () => {
  const requests: string[] = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    return String(url).endsWith("/api/event")
      ? Response.json({ connected: true, durationMinutes: 30, timezone: "Europe/London", minNoticeHours: 4, maxDaysAhead: 60 })
      : Response.json({ slots: ["2026-10-30T10:00:00.000Z", "2026-10-30T14:30:00.000Z"] });
  };
  const briefing = await preloadCalendar(new Date("2026-10-29T15:00:00Z"));
  assert.equal(requests.length, 2);
  assert.equal(new URL(requests[1]).searchParams.get("end"), "2026-11-02T00:00:00.000Z");
  assert.equal(briefing.timezone, "Europe/London");
  assert.equal(briefing.details.durationMinutes, 30);
  assert.match(briefing.spokenSlots[0].label, /10 am/);
  assert.doesNotMatch(briefing.spokenSlots[0].label, /:00/);
  assert.match(briefing.spokenSlots[1].label, /2:30 pm/);
  assert.match(spokenMeetingTime("2026-07-08T13:00:00Z"), /2 pm.*British Summer Time/);
  assert.match(spokenMeetingTime("2026-10-30T00:00:00Z"), /12 am/);
  assert.match(spokenMeetingTime("2026-10-30T12:00:00Z"), /12 pm/);
});
