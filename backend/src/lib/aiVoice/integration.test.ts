import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import type { AddressInfo } from "node:net";

process.env.TWENTY_BASE_URL = "https://crm.example.test";
process.env.TWENTY_API_KEY = "test-only-crm-key";
process.env.TWENTY_REQUESTS_PER_MINUTE = "100000";
process.env.TELNYX_API_KEY = "test-only-telnyx-key";
process.env.TELNYX_WEBHOOK_TOKEN = "test-webhook-token";
process.env.AI_VOICE_SECRET = "test-only-voice-secret-with-at-least-32-characters";
process.env.JWT_SECRET = "test-only-jwt-secret-with-at-least-32-characters";
process.env.AI_VOICE_ENABLED = "true";
process.env.AI_VOICE_PUBLIC_URL = "https://dialer.example.test";
process.env.TELNYX_AI_ASSISTANT_ID = "test-assistant";
process.env.TELNYX_CALL_CONTROL_APP_ID = "test-app";
process.env.AGENCY_PHONE_NUMBER = "+442079460123";
process.env.AI_VOICE_TEST_NUMBERS = "+442079460456";
delete process.env.OPENAI_API_KEY;

const voice = await import("./index.js");
const locks = await import("./locks.js");
const { callToken, setupToken } = await import("./config.js");
const { generateToken } = await import("../../middleware/auth.js");
const { default: router } = await import("../../routes/aiCalls/index.js");
const originalFetch = globalThis.fetch;
type Row = { id: string; [key: string]: unknown };
const data = new Map<string, Map<string, Row>>();
const contactId = "11111111-1111-4111-8111-111111111111";
const phoneId = "22222222-2222-4222-8222-222222222222";
const memberId = "33333333-3333-4333-8333-333333333333";
let providerCalls: { path: string; body: Record<string, unknown> }[];
let uncertainDial: boolean;
let bookingRequests: Record<string, unknown>[];

function table(name: string): Map<string, Row> {
  let value = data.get(name);
  if (!value) { value = new Map(); data.set(name, value); }
  return value;
}

beforeEach(() => {
  data.clear();
  providerCalls = [];
  bookingRequests = [];
  uncertainDial = false;
  table("agencyProspects").set(contactId, { id: contactId, name: "Fictional Test Company", phone: "+442079460456", coldCallStatus: "NEW" });
  table("agencyPhones").set(phoneId, { id: phoneId, phoneNumber: process.env.AGENCY_PHONE_NUMBER, state: "ACTIVE" });
  globalThis.fetch = async (request, init) => {
    const url = new URL(typeof request === "string" ? request : request instanceof URL ? request.href : request.url);
    if (url.hostname === "127.0.0.1") return originalFetch(request, init);
    const body: Record<string, unknown> = init?.body ? JSON.parse(String(init.body)) : {};
    if (url.hostname === "api.telnyx.com") {
      providerCalls.push({ path: url.pathname, body });
      return Response.json({ data: url.pathname === "/v2/calls" && !uncertainDial ? { call_control_id: "fake-call-control-id" } : {} });
    }
    if (url.hostname === "booking.fewzen.ai") {
      if (url.pathname === "/api/event") return Response.json({ connected: true, durationMinutes: 30, timezone: "Europe/London", minNoticeHours: 4, maxDaysAhead: 60 });
      if (url.pathname === "/api/availability") return Response.json({ slots: ["2026-11-03T10:00:00.000Z"] });
      if (url.pathname === "/api/book") {
        bookingRequests.push(body);
        return Response.json({
          id: "fake-booking", start: body.start, end: "2026-11-03T10:30:00.000Z",
          meetLink: "https://meet.google.com/test-only",
          manageUrl: "https://booking.fewzen.ai/#manage=private-test-credential",
        }, { status: 201 });
      }
    }
    if (url.hostname !== "crm.example.test") throw new Error(`Unexpected external request in test: ${url.hostname}`);
    if (url.pathname === "/metadata") {
      return Response.json({ data: { objects: { edges: [
        { node: { id: "locks", nameSingular: "agencyVoiceLock", namePlural: "agencyVoiceLocks", fields: { edges: [{ node: { name: "lockKey", type: "TEXT", isActive: true, isUnique: true } }] } } },
        { node: { id: "calls", nameSingular: "agencyCall", namePlural: "agencyCalls", fields: { edges: [{ node: { name: "aiVoiceRequestId", type: "TEXT", isActive: true, isUnique: true } }] } } },
      ] } } });
    }
    const [, , object, id] = url.pathname.split("/");
    const rows = table(object);
    if (init?.method === "POST") {
      if (object === "agencyVoiceLocks" && [...rows.values()].some((row) => row.lockKey && row.lockKey === body.lockKey)) {
        return Response.json({ error: "unique constraint" }, { status: 409 });
      }
      const row = { ...body, id: randomUUID() };
      rows.set(row.id, row);
      return Response.json({ data: row }, { status: 201 });
    }
    if (init?.method === "PATCH") {
      const row = rows.get(id);
      if (!row) return Response.json({ error: "not found" }, { status: 404 });
      Object.assign(row, body);
      return Response.json({ data: row });
    }
    if (init?.method === "DELETE") {
      rows.delete(id);
      return new Response(null, { status: 204 });
    }
    if (id) return rows.has(id) ? Response.json({ data: rows.get(id) }) : Response.json({ error: "not found" }, { status: 404 });
    const filter = url.searchParams.get("filter");
    const match = filter?.match(/^(\w+)\[eq\]:"([^"]+)"$/);
    const found = [...rows.values()].filter((row) => !match || row[match[1]] === match[2]);
    return Response.json({ data: { [object]: found } });
  };
});

afterEach(() => { globalThis.fetch = originalFetch; });
function input() {
  return { requestId: randomUUID(), contactId, contactType: "prospect" as const, permission: "internal_test" as const, consentEvidence: "Internal test authorised by the owner." };
}
function event(callId: string, extra: Record<string, unknown> = {}) {
  return { call_control_id: "fake-call-control-id", client_state: Buffer.from(JSON.stringify({ kind: "ai_voice", callId })).toString("base64"), ...extra };
}

test("one trigger produces one provider call and survives browser-independent answer, booking and hangup", async () => {
  const request = input();
  const started = await voice.startVoiceCall(request, memberId, null);
  assert.equal(started.state, "DIALING");
  assert.deepEqual(await voice.startVoiceCall(request, memberId, null), started);
  assert.equal(providerCalls.length, 1);
  assert.equal(providerCalls[0].body.time_limit_secs, 600);
  assert.equal("record" in providerCalls[0].body, false);
  await voice.handleVoiceEvent("call.answered", event(started.id));
  assert.equal(providerCalls[1].path, "/v2/calls/fake-call-control-id/actions/ai_assistant_start");
  await voice.runVoiceTool(started.id, "availability", { start: "2026-11-03T00:00:00Z", end: "2026-11-04T00:00:00Z" });
  const booked = await voice.runVoiceTool(started.id, "book", {
    start: "2026-11-03T10:00:00.000Z", name: "Fictional Attendee", email: "attendee@example.test", timezone: "Europe/London", confirmed: true,
  });
  assert.equal(JSON.stringify(booked).includes("private-test-credential"), false);
  assert.equal(bookingRequests.length, 1);
  const row = table("agencyCalls").get(started.id)!;
  assert.equal(row.meetingBookingId, "fake-booking");
  assert.equal(row.disposition, "APPOINTMENT_SET");
  assert.equal(String(row.aiVoicePrivateState).includes("private-test-credential"), false);
  await voice.handleVoiceEvent("call.conversation.ended", event(started.id, {
    messages: [{ role: "user", content: "We need help automating customer enquiries." }, { role: "tool", content: "private-tool-data" }],
  }));
  assert.equal(row.transcript, "user: We need help automating customer enquiries.");
  await voice.handleVoiceEvent("call.hangup", event(started.id, { hangup_cause: "normal_clearing" }));
  assert.equal((await voice.getVoiceCall(started.id)).status, "COMPLETED");
  assert.equal(await voice.activeVoiceCall(), null);
  assert.equal(await locks.findLock(`phone:${phoneId}`), null);
  const commands = providerCalls.length;
  await voice.handleVoiceEvent("call.answered", event(started.id));
  await voice.handleVoiceEvent("call.hangup", event(started.id));
  assert.equal(providerCalls.length, commands);
});

test("concurrent starts cannot double-dial the agency number", async () => {
  const results = await Promise.allSettled([
    voice.startVoiceCall(input(), memberId, null),
    voice.startVoiceCall(input(), memberId, null),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(providerCalls.filter((call) => call.path === "/v2/calls").length, 1);
  await assert.rejects(locks.acquireLock(`phone:${phoneId}`), /already in use/);
});

test("opt-outs, unlisted internal numbers and human-held numbers cannot be dialled", async () => {
  table("agencyProspects").get(contactId)!.coldCallStatus = "DO_NOT_CONTACT";
  await assert.rejects(voice.startVoiceCall(input(), memberId, null), /opted out/);
  table("agencyProspects").get(contactId)!.coldCallStatus = "NEW";
  table("agencyProspects").get(contactId)!.phone = "+442079460789";
  await assert.rejects(voice.startVoiceCall(input(), memberId, null), /allowlist/);
  table("agencyProspects").get(contactId)!.phone = "+442079460456";
  Object.assign(table("agencyPhones").get(phoneId)!, { claimedByMemberId: memberId, lastHeartbeatAt: new Date().toISOString() });
  await assert.rejects(voice.startVoiceCall(input(), memberId, null), /human dialer/);
  assert.equal(providerCalls.length, 0);
  assert.equal(await locks.findLock("ai-voice"), null);
});

test("uncertain dial initiation holds its reservation until a provider hangup resolves it", async () => {
  uncertainDial = true;
  await assert.rejects(voice.startVoiceCall(input(), memberId, null), /uncertain/);
  const active = await voice.activeVoiceCall();
  assert.equal(active?.state, "UNKNOWN");
  assert.ok(await locks.findLock(`phone:${phoneId}`));
  await assert.rejects(voice.startVoiceCall(input(), memberId, null), /already in use/);
  assert.ok(active);
  await voice.handleVoiceEvent("call.hangup", event(active.id, { hangup_cause: "no_answer" }));
  assert.equal((await voice.getVoiceCall(active.id)).status, "NO_ANSWER");
  assert.equal(await voice.activeVoiceCall(), null);
});

test("opt-out tool persists suppression before ending the call", async () => {
  const call = await voice.startVoiceCall(input(), memberId, null);
  await voice.handleVoiceEvent("call.answered", event(call.id));
  await voice.runVoiceTool(call.id, "opt_out", {});
  assert.equal(table("agencyProspects").get(contactId)!.outboundState, "OPTED_OUT");
  assert.equal(table("agencyCalls").get(call.id)!.disposition, "DNC");
  assert.ok(providerCalls.some((command) => command.path.endsWith("/hangup")));
  await assert.rejects(voice.startVoiceCall(input(), memberId, null), /opted out/);
});

test("HTTP tools reject forged or cross-call credentials; operator routes require login", async () => {
  const call = await voice.startVoiceCall(input(), memberId, null);
  await voice.handleVoiceEvent("call.answered", event(call.id));
  const app = express();
  app.use(express.json());
  app.use("/api/ai-calls", router);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const address = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}/api/ai-calls`;
    assert.equal((await fetch(`${base}/config`)).status, 401);
    assert.equal((await fetch(`${base}/setup`, { method: "POST" })).status, 401);
    assert.equal((await fetch(`${base}/setup`, { method: "POST", headers: { Authorization: `Bearer ${setupToken()}` } })).status, 409);
    const headers = { "Content-Type": "application/json", "X-AI-Call-Id": call.id, Authorization: "Bearer invalid" };
    assert.equal((await fetch(`${base}/tools/meeting_details`, { method: "POST", headers, body: "{}" })).status, 401);
    headers.Authorization = `Bearer ${callToken(randomUUID())}`;
    assert.equal((await fetch(`${base}/tools/meeting_details`, { method: "POST", headers, body: "{}" })).status, 401);
    headers.Authorization = `Bearer ${callToken(call.id)}`;
    assert.equal((await fetch(`${base}/tools/meeting_details`, { method: "POST", headers, body: "{}" })).status, 200);
    const token = generateToken({ userId: "test-user" });
    assert.equal((await fetch(base, { method: "POST", headers: { Authorization: `Bearer ${token}` } })).status, 401);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
