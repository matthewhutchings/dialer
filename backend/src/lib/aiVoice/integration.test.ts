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
const { callToken, setupToken, decryptState, encryptState } = await import("./config.js");
const { ASSISTANT_INSTRUCTIONS } = await import("./assistant.js");
const { readAgentProfile, saveAgentProfile } = await import("./profile.js");
const settingsApi = await import("./settings.js");
const automation = await import("./automation.js");
const { SCHEMA_OBJECTS } = await import("../twenty/schema/manifest.js");
const { mapCall } = await import("../../routes/calls/helpers/mapCall.js");
const inbound = await import("./inbound.js");
type VoiceBriefing = import("./context.js").VoiceBriefing;
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
let contactReads: number;
let refreshContact: Partial<Row> | undefined;
let failedObject: string | undefined;
let providerStatus: Record<string, unknown>;
let statusFailure: number | undefined;
let hangupError: string | undefined;
let bookingGate: Promise<void> | undefined;
let speakFails: boolean;
let calendarFails: boolean;
let uncertainTransfer: boolean;
let lostTaskResponse: boolean;

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
  contactReads = 0;
  refreshContact = undefined;
  failedObject = undefined;
  providerStatus = { call_control_id: "fake-call-control-id", is_alive: true };
  statusFailure = undefined;
  hangupError = undefined;
  bookingGate = undefined;
  speakFails = false;
  calendarFails = false;
  uncertainTransfer = false;
  lostTaskResponse = false;
  process.env.AI_VOICE_ENABLED = "true";
  process.env.AI_AUTOMATION_CRON_SECRET = "test-only-scheduler-secret-at-least-32-characters";
  process.env.AI_VOICE_INBOUND_ENABLED = "false";
  process.env.TELNYX_INBOUND_AI_ASSISTANT_ID = "test-inbound-assistant";
  process.env.TELNYX_INBOUND_NUMBER = process.env.AGENCY_PHONE_NUMBER;
  process.env.TELNYX_FALLBACK_PHONE = "+447700900123";
  process.env.TELNYX_HOLD_AUDIO_URL = "https://dialer.example.test/hold.mp3";
  table("agencyProspects").set(contactId, { id: contactId, name: "Fictional Test Company", phone: "+442079460456", coldCallStatus: "NEW" });
  table("agencyPhones").set(phoneId, { id: phoneId, phoneNumber: process.env.AGENCY_PHONE_NUMBER, state: "ACTIVE" });
  globalThis.fetch = async (request, init) => {
    const url = new URL(typeof request === "string" ? request : request instanceof URL ? request.href : request.url);
    if (url.hostname === "127.0.0.1") return originalFetch(request, init);
    const body: Record<string, unknown> = init?.body ? JSON.parse(String(init.body)) : {};
    if (url.hostname === "api.telnyx.com") {
      if ((!init?.method || init.method === "GET") && url.pathname === "/v2/calls/fake-call-control-id") {
        return statusFailure ? Response.json({ errors: [{ code: "test-status-error" }] }, { status: statusFailure }) : Response.json({ data: providerStatus });
      }
      if ((!init?.method || init.method === "GET") && url.pathname.startsWith("/v2/calls/")) {
        return Response.json({ data: { ...providerStatus, call_control_id: decodeURIComponent(url.pathname.slice("/v2/calls/".length)) } });
      }
      providerCalls.push({ path: url.pathname, body });
      if (url.pathname.endsWith("/actions/speak") && speakFails) {
        return Response.json({ errors: [{ code: "test-speech-error" }] }, { status: 422 });
      }
      if (url.pathname.endsWith("/actions/hangup") && hangupError) {
        return Response.json({ errors: [{ code: hangupError, title: "Test provider rejection" }] }, { status: 422 });
      }
      const transfer = url.pathname === "/v2/calls" && body.to === process.env.TELNYX_FALLBACK_PHONE;
      return Response.json({ data: url.pathname === "/v2/calls" && !uncertainDial && !(transfer && uncertainTransfer)
        ? { call_control_id: transfer ? "transfer-leg-id" : "fake-call-control-id" } : {} });
    }
    if (url.hostname === "www.gov.uk") return Response.json({ "england-and-wales": { events: [{ date: "2026-12-25" }, { date: "2026-12-28" }, { date: "2027-01-01" }] } });
    if (url.hostname === "booking.fewzen.ai") {
      if (calendarFails) return Response.json({ error: "calendar unavailable" }, { status: 503 });
      if (url.pathname === "/api/event") return Response.json({ connected: true, durationMinutes: 30, timezone: "Europe/London", minNoticeHours: 4, maxDaysAhead: 60 });
      if (url.pathname === "/api/availability") return Response.json({ slots: ["2026-11-03T10:00:00.000Z"] });
      if (url.pathname === "/api/book") {
        bookingRequests.push(body);
        if (bookingGate) await bookingGate;
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
        { node: { id: "phones", nameSingular: "agencyPhone", namePlural: "agencyPhones", fields: { edges: ["aiAgentName", "aiAgentSettings", "aiAutomationRun"].map((name) => ({ node: { name, type: name === "aiAgentName" ? "TEXT" : "RAW_JSON", isActive: true } })) } } },
        { node: { id: "queue", nameSingular: "agencyAiQueueEntry", namePlural: "agencyAiQueueEntries", fields: { edges: SCHEMA_OBJECTS.find((object) => object.nameSingular === "agencyAiQueueEntry")!.fields.map((field) => ({ node: { name: field.name, type: field.type, isActive: true } })) } } },
      ] } } });
    }
    const [, , object, id] = url.pathname.split("/");
    const rows = table(object);
    if (object === failedObject) return Response.json({ error: "CRM context unavailable" }, { status: 403 });
    if (init?.method === "POST") {
      if (object === "agencyVoiceLocks" && [...rows.values()].some((row) => row.lockKey && row.lockKey === body.lockKey)) {
        return Response.json({ error: "unique constraint" }, { status: 409 });
      }
      const row = { ...body, createdAt: new Date(Date.now()).toISOString(), id: typeof body.id === "string" ? body.id : randomUUID() };
      rows.set(row.id, row);
      if (object === "tasks" && lostTaskResponse) {
        lostTaskResponse = false;
        return Response.json({ error: "Task saved but response lost" }, { status: 503 });
      }
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
    if (id) {
      if (object === "agencyProspects" && id === contactId && ++contactReads === 2 && refreshContact) {
        Object.assign(rows.get(id)!, refreshContact);
      }
      return rows.has(id) ? Response.json({ data: rows.get(id) }) : Response.json({ error: "not found" }, { status: 404 });
    }
    const filter = url.searchParams.get("filter");
    const conditions = [...(filter || "").matchAll(/(\w+)\[(eq|gte|gt)\]:"([^"]+)"/g)];
    const ids = filter?.match(/^id\[in\]:\[([^\]]+)\]$/)?.[1].split(",");
    const found = [...rows.values()].filter((row) => conditions.every(([, key, op, value]) =>
      op === "eq" ? row[key] === value : op === "gte" ? String(row[key] || "") >= value : String(row[key] || "") > value) && (!ids || ids.includes(row.id)));
    if (url.searchParams.get("orderBy") === "createdAt[DescNullsLast]") {
      found.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    }
    if (url.searchParams.get("orderBy") === "id[AscNullsFirst]") found.sort((a, b) => a.id.localeCompare(b.id));
    return Response.json({ data: { [object]: found.slice(0, Number(url.searchParams.get("limit")) || found.length) } });
  };
});

afterEach(() => { globalThis.fetch = originalFetch; });
function autoSettings(overrides: Partial<import("@dialer/shared").AiAgentSettings> = {}) {
  const settings = { ...settingsApi.defaultAgentSettings(), goalMode: "calls" as const, ...overrides };
  table("agencyPhones").get(phoneId)!.aiAgentSettings = settings;
  return settings;
}
async function approve(overrides: Partial<import("@dialer/shared").AiCallInput> = {}) {
  return automation.approveQueue({ ...input(), ...overrides }, { id: memberId, name: "Test Operator" }, null);
}
function input() {
  return { requestId: randomUUID(), contactId, contactType: "prospect" as const, permission: "internal_test" as const, consentEvidence: "Internal test authorised by the owner." };
}
function event(callId: string, extra: Record<string, unknown> = {}) {
  return { call_control_id: "fake-call-control-id", client_state: Buffer.from(JSON.stringify({ kind: "ai_voice", callId })).toString("base64"), ...extra };
}

function assistantStart() {
  const payload = providerCalls.find((call) => call.path.endsWith("/actions/ai_assistant_start"))!.body;
  const assistant = payload.assistant as { instructions: string; dynamic_variables: Record<string, string> };
  return { payload, assistant, briefing: JSON.parse(assistant.dynamic_variables.crm_context) as VoiceBriefing };
}

test("shared agent controls persist independently, validate one goal mode and retain deployment kill switches", async () => {
  process.env.AI_VOICE_INBOUND_ENABLED = "true";
  const controls = autoSettings({ goalMode: "bookings", dailyBookingGoal: 10, inboundGuidance: "Discuss automation.", outboundGuidance: "Ask about reporting.", paused: true });
  assert.deepEqual(await settingsApi.saveAgentSettings(controls, null), controls);
  assert.deepEqual(await settingsApi.readAgentSettings(), controls);
  await assert.rejects(settingsApi.saveAgentSettings({ ...controls, goalMode: "both" }, null), /one goal mode/);
  await assert.rejects(settingsApi.saveAgentSettings({ ...controls, dailyCallGoal: 0 }, null), /whole-number/);
  await assert.rejects(settingsApi.saveAgentSettings({ ...controls, dailyBookingGoal: 10.5 }, null), /whole-number/);
  await assert.rejects(settingsApi.saveAgentSettings({ ...controls, outboundGuidance: "x".repeat(8001) }, null), /guidance/);
  process.env.AI_VOICE_ENABLED = "false";
  await assert.rejects(settingsApi.saveAgentSettings(controls, null), /deployment configuration/);
  table("agencyPhones").get(phoneId)!.aiAgentSettings = { goalMode: "bookings" };
  await assert.rejects(settingsApi.readAgentSettings(), /valid switches/);
});

test("outbound off blocks manual calls without disabling inbound, and workspace guidance cannot replace fixed instructions", async () => {
  process.env.AI_VOICE_INBOUND_ENABLED = "true";
  autoSettings({ outboundEnabled: false, inboundEnabled: true });
  await assert.rejects(voice.startVoiceCall(input(), memberId, null), /switched off/);
  assert.equal(await inbound.inboundAiEnabled(), true);
  autoSettings({ outboundGuidance: "Prioritise reporting workflows.", inboundEnabled: false });
  assert.equal(await inbound.inboundAiEnabled(), false);
  const call = await voice.startVoiceCall(input(), memberId, null);
  await voice.handleVoiceEvent("call.answered", event(call.id));
  assert.ok(assistantStart().assistant.instructions.startsWith(ASSISTANT_INSTRUCTIONS));
  assert.match(assistantStart().assistant.instructions, /Prioritise reporting workflows/);
  assert.match(assistantStart().assistant.instructions, /never overrides/);
});

test("queue approval is idempotent, permission-bound, audited and never dials immediately", async () => {
  const request = input();
  const first = await approve(request);
  const repeated = await approve(request);
  assert.equal(first.id, request.requestId);
  assert.equal(repeated.id, first.id);
  assert.equal(first.phone, "+442079460456");
  assert.equal(first.approvedByMemberId, memberId);
  assert.equal(first.state, "QUEUED");
  assert.equal(providerCalls.length, 0);
  await assert.rejects(approve({ ...request, consentEvidence: "Different permission record." }), /different contact or permission/);
  await assert.rejects(approve(), /already has a queued/);
  await assert.rejects(approve({ consentEvidence: "" }), /permission record/);
  await automation.cancelQueue(first.id);
  assert.equal((await automation.runAutomation()).status, "goal_off");
  assert.equal(providerCalls.length, 0);
});

test("automatic calling starts when queue and goal are configured and concurrent ticks cannot duplicate a call", async (t) => {
  t.mock.method(Date, "now", () => Date.parse("2026-10-29T12:00:00Z"));
  autoSettings();
  const entry = await approve();
  const results = await Promise.allSettled([automation.runAutomation(), automation.runAutomation()]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(providerCalls.filter((call) => call.path === "/v2/calls").length, 1);
  assert.equal(providerCalls.find((call) => call.path === "/v2/calls")!.body.command_id, entry.id);
  assert.equal((await automation.runAutomation()).status, "call_active");
  const row = table("agencyAiQueueEntries").get(entry.id)!;
  assert.equal(row.state, "STARTING");
  assert.ok(row.callId);
  const stored = table("agencyCalls").get(String(row.callId))!;
  assert.equal(stored.createdByMemberId, memberId);
  assert.equal((stored.createdBy as { name: string }).name, "Test Operator");
  const view = await automation.automationView();
  assert.equal(view.calls, 1);
  assert.equal(view.queue.length, 1);
});

test("call mode stops at the exact daily threshold and retains pending entries for the next UK day", async (t) => {
  const clock = t.mock.method(Date, "now", () => Date.parse("2026-10-29T12:00:00Z"));
  autoSettings({ dailyCallGoal: 1 });
  const first = await approve();
  const otherId = randomUUID();
  table("agencyProspects").set(otherId, { ...table("agencyProspects").get(contactId)!, id: otherId, name: "Other Approved Company" });
  const next = await approve({ contactId: otherId });
  table("agencyAiQueueEntries").get(next.id)!.createdAt = "2026-10-29T12:00:01.000Z";
  await automation.runAutomation();
  const callId = String(table("agencyAiQueueEntries").get(first.id)!.callId);
  await voice.handleVoiceEvent("call.hangup", event(callId, { hangup_cause: "no_answer" }));
  assert.equal((await automation.runAutomation()).status, "goal_reached");
  assert.equal(table("agencyAiQueueEntries").get(first.id)!.state, "COMPLETE");
  assert.equal(table("agencyAiQueueEntries").get(next.id)!.state, "QUEUED");
  assert.equal(providerCalls.filter((call) => call.path === "/v2/calls").length, 1);
  clock.mock.restore();
  t.mock.method(Date, "now", () => Date.parse("2026-10-30T12:00:00Z"));
  assert.equal((await automation.runAutomation()).status, "call_started");
  assert.equal(providerCalls.filter((call) => call.path === "/v2/calls").length, 2);
});

test("booking mode ignores the call target and stops only on confirmed outbound conversions", async (t) => {
  t.mock.method(Date, "now", () => Date.parse("2026-10-29T12:00:00Z"));
  autoSettings({ goalMode: "bookings", dailyCallGoal: 1, dailyBookingGoal: 1 });
  const entry = await approve();
  await automation.runAutomation();
  const callId = String(table("agencyAiQueueEntries").get(entry.id)!.callId);
  await voice.handleVoiceEvent("call.answered", event(callId));
  const details = { start: "2026-11-03T10:00:00.000Z", name: "Test Attendee", email: "attendee@example.test", timezone: "Europe/London", confirmed: true };
  await voice.runVoiceTool(callId, "book", details);
  await voice.runVoiceTool(callId, "book", details);
  const state = decryptState<import("./index.js").PrivateState>(String(table("agencyCalls").get(callId)!.aiVoicePrivateState));
  assert.equal(state.bookingConfirmedAt, "2026-10-29T12:00:00.000Z");
  assert.equal(bookingRequests.length, 2);
  assert.deepEqual(bookingRequests[0], bookingRequests[1]);
  await voice.handleVoiceEvent("call.hangup", event(callId));
  assert.equal((await automation.runAutomation()).status, "goal_reached");
  assert.equal((await automation.automationView()).bookings, 1);
  assert.equal((await automation.automationView()).calls, 1);
});

test("booking mode continues beyond call target until booking goal, while pause and master off prevent future launches", async (t) => {
  t.mock.method(Date, "now", () => Date.parse("2026-10-29T12:00:00Z"));
  autoSettings({ goalMode: "bookings", dailyCallGoal: 1 });
  const first = await approve();
  const otherId = randomUUID();
  table("agencyProspects").set(otherId, { ...table("agencyProspects").get(contactId)!, id: otherId });
  const second = await approve({ contactId: otherId });
  table("agencyAiQueueEntries").get(second.id)!.createdAt = "2026-10-29T12:00:01.000Z";
  await automation.runAutomation();
  await voice.handleVoiceEvent("call.hangup", event(String(table("agencyAiQueueEntries").get(first.id)!.callId)));
  autoSettings({ goalMode: "bookings", paused: true });
  assert.equal((await automation.runAutomation()).status, "paused");
  autoSettings({ goalMode: "bookings", outboundEnabled: false });
  assert.equal((await automation.runAutomation()).status, "disabled");
  autoSettings({ goalMode: "bookings", dailyCallGoal: 1 });
  assert.equal((await automation.runAutomation()).status, "call_started");
  assert.equal(table("agencyAiQueueEntries").get(second.id)!.state, "STARTING");
});

test("automation respects UK hours, DST and bank holidays without consuming approved entries", async (t) => {
  autoSettings();
  const entry = await approve();
  for (const date of ["2026-10-29T17:00:00Z", "2026-10-31T12:00:00Z", "2026-12-25T10:00:00Z", "2026-07-07T07:59:00Z", "2026-07-07T16:00:00Z"]) {
    const clock = t.mock.method(Date, "now", () => Date.parse(date));
    assert.equal((await automation.runAutomation()).status, "outside_hours");
    assert.equal(table("agencyAiQueueEntries").get(entry.id)!.state, "QUEUED");
    clock.mock.restore();
  }
  assert.equal(providerCalls.length, 0);
});

test("changed numbers and new opt-outs are blocked at automatic dispatch", async (t) => {
  t.mock.method(Date, "now", () => Date.parse("2026-10-29T12:00:00Z"));
  autoSettings();
  const entry = await approve({ permission: "consented" });
  table("agencyProspects").get(contactId)!.phone = "+442079460999";
  assert.equal((await automation.runAutomation()).status, "attempt_failed");
  assert.match(String(table("agencyAiQueueEntries").get(entry.id)!.error), /phone changed/i);
  assert.equal(providerCalls.length, 0);
  table("agencyProspects").get(contactId)!.phone = "+442079460456";
  const retry = await automation.retryQueue(entry.id, randomUUID(), { id: memberId, name: "Test Operator" }, null);
  table("agencyProspects").get(contactId)!.outboundState = "OPTED_OUT";
  assert.equal((await automation.runAutomation()).status, "attempt_failed");
  assert.match(String(table("agencyAiQueueEntries").get(retry.id)!.error), /opted out/);
  assert.equal(providerCalls.length, 0);
});

test("changed-number failures allow a new approval only after reviewing fresh permission on the contact", async (t) => {
  t.mock.method(Date, "now", () => Date.parse("2026-10-29T12:00:00Z"));
  autoSettings();
  const first = await approve({ permission: "consented" });
  table("agencyProspects").get(contactId)!.phone = "+442079460999";
  await automation.runAutomation();
  await assert.rejects(automation.retryQueue(first.id, randomUUID(), { id: memberId, name: "Test Operator" }, null), /phone changed/i);
  const reviewed = await approve({ permission: "consented", consentEvidence: "Reviewed new number and received fresh AI calling permission today." });
  assert.equal(reviewed.phone, "+442079460999");
  assert.equal(reviewed.state, "QUEUED");
});

test("pause changes made during calendar preparation are checked before the provider dial", async (t) => {
  t.mock.method(Date, "now", () => Date.parse("2026-10-29T12:00:00Z"));
  autoSettings();
  await approve();
  const fetch = globalThis.fetch;
  globalThis.fetch = async (request, init) => {
    const url = new URL(String(request));
    if (url.hostname === "booking.fewzen.ai" && url.pathname === "/api/availability") autoSettings({ paused: true });
    return fetch(request, init);
  };
  assert.equal((await automation.runAutomation()).status, "attempt_failed");
  assert.equal(providerCalls.filter((call) => call.path === "/v2/calls").length, 0);
  assert.equal(await locks.findLock("ai-voice"), null);
});

test("unavailable holiday checking fails closed and surfaces an operational error without consuming an approval", async (t) => {
  t.mock.method(Date, "now", () => Date.parse("2027-01-04T12:00:00Z"));
  autoSettings();
  const entry = await approve();
  const fetch = globalThis.fetch;
  globalThis.fetch = async (request, init) => {
    if (new URL(String(request)).hostname === "www.gov.uk") return Response.json({ error: "unavailable" }, { status: 503 });
    return fetch(request, init);
  };
  await assert.rejects(automation.runAutomation(), /holiday checking is unavailable/);
  assert.equal(table("agencyAiQueueEntries").get(entry.id)!.state, "QUEUED");
  assert.equal((table("agencyPhones").get(phoneId)!.aiAutomationRun as { status: string }).status, "error");
  assert.equal(providerCalls.length, 0);
});

test("failed preparation never counts as a call and requires explicit retry; retry requests remain idempotent", async (t) => {
  t.mock.method(Date, "now", () => Date.parse("2026-10-29T12:00:00Z"));
  autoSettings();
  const entry = await approve();
  calendarFails = true;
  assert.equal((await automation.runAutomation()).status, "attempt_failed");
  assert.equal((await automation.automationView()).calls, 0);
  assert.equal((await automation.runAutomation()).status, "queue_empty");
  assert.equal(await locks.findLock("ai-voice"), null);
  calendarFails = false;
  const requestId = randomUUID();
  const retry = await automation.retryQueue(entry.id, requestId, { id: memberId, name: "Test Operator" }, null);
  assert.equal((await automation.retryQueue(entry.id, requestId, { id: memberId, name: "Test Operator" }, null)).id, retry.id);
  assert.equal((await automation.runAutomation()).status, "call_started");
  assert.equal(providerCalls.filter((call) => call.path === "/v2/calls").length, 1);
});

test("uncertain autonomous calls retain reservations and never automatically redial", async (t) => {
  t.mock.method(Date, "now", () => Date.parse("2026-10-29T12:00:00Z"));
  autoSettings();
  const entry = await approve();
  uncertainDial = true;
  assert.equal((await automation.runAutomation()).status, "recovery_required");
  assert.equal(table("agencyAiQueueEntries").get(entry.id)!.state, "UNCERTAIN");
  assert.equal((await automation.runAutomation()).status, "call_active");
  assert.equal((await automation.automationView()).calls, 1);
  await assert.rejects(automation.retryQueue(entry.id, randomUUID(), { id: memberId, name: "Test Operator" }, null), /finished attempt/);
  assert.equal(providerCalls.filter((call) => call.path === "/v2/calls").length, 1);
});

test("cancelled entries never dial; interrupted workers with no call require explicit approval rather than retrying", async (t) => {
  t.mock.method(Date, "now", () => Date.parse("2026-10-29T12:00:00Z"));
  autoSettings();
  const first = await approve();
  await automation.cancelQueue(first.id);
  assert.equal((await automation.runAutomation()).status, "queue_empty");
  const next = await approve();
  table("agencyAiQueueEntries").get(next.id)!.state = "STARTING";
  assert.equal((await automation.runAutomation()).status, "queue_empty");
  assert.equal(table("agencyAiQueueEntries").get(next.id)!.state, "FAILED");
  assert.equal(providerCalls.length, 0);
});

test("human-held caller numbers are never used by automatic calling", async (t) => {
  t.mock.method(Date, "now", () => Date.parse("2026-10-29T12:00:00Z"));
  autoSettings();
  const entry = await approve();
  Object.assign(table("agencyPhones").get(phoneId)!, { claimedByMemberId: memberId, lastHeartbeatAt: new Date().toISOString() });
  assert.equal((await automation.runAutomation()).status, "number_busy");
  assert.equal(table("agencyAiQueueEntries").get(entry.id)!.state, "QUEUED");
  assert.equal(providerCalls.length, 0);
  assert.equal((await automation.automationView()).calls, 0);
});

test("stalled scheduler recovery never clears live AI reservations or permits early lock stealing", async (t) => {
  const now = Date.parse("2026-10-29T12:00:00Z");
  t.mock.method(Date, "now", () => now);
  const lock = await locks.acquireLock("ai-automation");
  table("agencyPhones").get(phoneId)!.aiAutomationRun = { checkedAt: new Date(now - 60_000).toISOString(), status: "checking", detail: "Checking" };
  await assert.rejects(automation.recoverAutomation(), /15 minutes/);
  table("agencyPhones").get(phoneId)!.aiAutomationRun = { checkedAt: new Date(now - 16 * 60_000).toISOString(), status: "checking", detail: "Checking" };
  await assert.rejects(automation.recoverAutomation(), /15 minutes/);
  table("agencyVoiceLocks").get(lock.id)!.createdAt = new Date(now - 16 * 60_000).toISOString();
  const callLock = await locks.acquireLock("ai-voice", randomUUID());
  await assert.rejects(automation.recoverAutomation(), /no active/);
  await locks.releaseLock(callLock);
  await automation.recoverAutomation();
  assert.equal(await locks.findLock("ai-automation"), null);
  assert.equal(table("agencyVoiceLocks").get(lock.id)!.lockKey, null);
});

test("daily metrics use London midnight and confirmation time, excluding inbound, human and legacy un-timestamped bookings", async () => {
  const started = await voice.startVoiceCall(input(), memberId, null);
  const template = await voice.getVoiceCall(started.id);
  const booking = {
    key: "test-key", input: { start: "2026-07-10T09:00:00Z", name: "Test", email: "test@example.test", timezone: "Europe/London" },
    result: { id: "confirmed-booking", start: "2026-07-10T09:00:00Z", end: "2026-07-10T09:30:00Z", meetLink: null, manageUrl: "https://booking.example.test/manage" },
  };
  const confirmedState = encryptState({ company: "Test", script: "", attempt: booking, bookingConfirmedAt: "2026-07-07T23:01:00Z" });
  const midnight = new Date("2026-07-07T23:05:00Z"); // 12:05 am BST on 8 July.
  const calls = [
    { ...template, startedAt: "2026-07-07T23:01:00Z", aiVoiceState: "ENDED", aiVoicePrivateState: confirmedState },
    { ...template, startedAt: "2026-07-07T22:59:00Z", aiVoiceState: "ENDED", aiVoicePrivateState: encryptState({ company: "Test", script: "", attempt: booking, bookingConfirmedAt: "2026-07-07T22:59:30Z" }) },
    { ...template, startedAt: "2026-07-07T23:01:00Z", aiVoiceState: "FAILED" },
    { ...template, direction: "INBOUND", startedAt: "2026-07-07T23:01:00Z", aiVoicePrivateState: confirmedState },
    { ...template, aiVoiceRequestId: "", startedAt: "2026-07-07T23:01:00Z" },
    { ...template, startedAt: "2026-07-07T23:01:00Z", aiVoiceState: "ENDED", meetingAt: "2026-07-08T10:00:00Z", meetingBookingId: "legacy", aiVoicePrivateState: encryptState({ company: "Test", script: "", attempt: booking }) },
  ];
  assert.deepEqual(automation.dailyProgress(calls, autoSettings({ goalMode: "bookings", dailyBookingGoal: 1 }), midnight), {
    day: "2026-07-08", calls: 2, bookings: 1, target: 1, goalReached: true,
  });
  assert.equal(automation.londonDay(new Date("2026-12-31T23:59:00Z")), "2026-12-31");
  assert.equal(automation.londonDay(new Date("2027-01-01T00:00:00Z")), "2027-01-01");
});

test("daily goal counting walks more than one CRM page without dropping its filter or overshooting", async (t) => {
  t.mock.method(Date, "now", () => Date.parse("2026-10-29T12:00:00Z"));
  autoSettings({ dailyCallGoal: 205 });
  const started = await voice.startVoiceCall(input(), memberId, null);
  await voice.handleVoiceEvent("call.hangup", event(started.id));
  const template = table("agencyCalls").get(started.id)!;
  for (let i = 0; i < 204; i++) {
    const id = randomUUID();
    table("agencyCalls").set(id, { ...template, id, aiVoiceRequestId: randomUUID() });
  }
  const historicalId = randomUUID();
  table("agencyCalls").set(historicalId, { ...template, id: historicalId, startedAt: "2026-10-28T10:00:00Z" });
  await approve();
  assert.equal((await automation.runAutomation()).status, "goal_reached");
  assert.equal((await automation.automationView()).calls, 205);
  assert.equal(providerCalls.filter((call) => call.path === "/v2/calls").length, 1);
});

test("answered call receives a fresh, bounded CRM briefing, relevant history and a named greeting", async () => {
  const personId = randomUUID();
  const campaignId = randomUUID();
  Object.assign(table("agencyProspects").get(contactId)!, {
    name: "Fictional Test Company", niche: "Engineering", website: "https://example.test",
    city: "London", email: "office@example.test", notes: "Old requirement",
    campaignIdId: campaignId, apiKey: "raw-contact-secret",
  });
  refreshContact = { notes: "Automate customer enquiries. " + "x".repeat(3000) };
  table("agencyCampaigns").set(campaignId, { id: campaignId, name: "AI discovery" });
  table("agencyScripts").set(randomUUID(), { id: randomUUID(), campaignIdId: campaignId, scriptData: "Discuss technology support. " + "s".repeat(9000) });
  table("agencyPeople").set(personId, {
    id: personId, prospectId: contactId, name: "Jamie Example", jobTitle: "Director",
    phones: { primaryPhoneNumber: "2079460456", primaryPhoneCallingCode: "44" },
    emails: { primaryEmail: "jamie@example.test" }, avatarUrl: "private-person-attachment",
  });
  const unrelatedId = randomUUID();
  table("agencyPeople").set(unrelatedId, { id: unrelatedId, prospectId: unrelatedId, name: "Unrelated person sentinel" });
  for (let i = 0; i < 7; i++) {
    const id = randomUUID();
    table("notes").set(id, { id, title: `Requirement ${i}`, createdAt: `2026-10-${10 + i}T10:00:00Z`, bodyV2: { markdown: `Recorded requirement ${i}. ![diagram](https://private.example.test/signed?token=attachment-secret) ` + "n".repeat(1800) } });
    table("noteTargets").set(id, { id, noteId: id, targetAgencyProspectId: contactId, createdAt: `2026-10-${10 + i}T10:00:00Z` });
  }
  table("notes").set(unrelatedId, { id: unrelatedId, title: "Unrelated note sentinel", bodyV2: { markdown: "Do not send this" } });
  for (let i = 0; i < 5; i++) {
    const id = randomUUID();
    table("agencyCalls").set(id, {
      id, agencyProspectId: contactId, createdAt: `2026-10-${10 + i}T10:00:00Z`,
      aiSummary: `Previous discussion ${i}. ` + "h".repeat(1200), notes: "Previous notes",
      disposition: "CALL_BACK", meetingAt: "2026-11-03T10:00:00Z", meetingStatus: "BOOKED",
      transcript: "raw-transcript-secret", meetingManageUrl: "private-booking-secret",
    });
  }
  table("agencyCalls").set(unrelatedId, { id: unrelatedId, agencyProspectId: unrelatedId, createdAt: "2026-10-28T10:00:00Z", aiSummary: "Unrelated call sentinel" });
  const started = await voice.startVoiceCall(input(), memberId, null);
  const stored = table("agencyCalls").get(started.id)!;
  assert.equal(String(stored.aiVoicePrivateState).includes("Jamie Example"), false);
  const snapshot = decryptState<{ briefing: VoiceBriefing }>(String(stored.aiVoicePrivateState));
  assert.match(snapshot.briefing.recordNotes!, /^Automate customer enquiries/);
  await voice.handleVoiceEvent("call.answered", event(started.id));
  const { payload, assistant, briefing } = assistantStart();
  assert.equal(assistant.instructions, ASSISTANT_INSTRUCTIONS);
  assert.match(payload.greeting as string, /AI assistant.*Jamie Example at Fictional Test Company/);
  assert.deepEqual(briefing.contact, { name: "Jamie Example", role: "Director", email: "jamie@example.test", identity: "expected_person_unverified" });
  assert.equal(briefing.company.industry, "Engineering");
  assert.equal(briefing.company.city, "London");
  assert.equal(briefing.campaign, "AI discovery");
  assert.equal(briefing.recordNotes?.length, 2000);
  assert.equal(briefing.linkedNotes.length, 5);
  assert.equal(briefing.linkedNotes[0].title, "Requirement 6");
  assert.ok(briefing.linkedNotes.every((note) => note.body.length <= 1200));
  assert.equal(briefing.previousCalls.length, 3);
  assert.match(briefing.previousCalls[0].summary!, /^Previous discussion 4/);
  assert.ok(briefing.previousCalls.every((call) => call.summary!.length <= 1000));
  assert.equal(briefing.previousCalls[0].meetingStatus, "BOOKED");
  assert.equal(assistant.dynamic_variables.campaign_script.length, 8000);
  assert.ok(assistant.dynamic_variables.crm_context.length < 15000);
  const sent = JSON.stringify(payload);
  for (const excluded of ["Unrelated", "raw-contact-secret", "raw-transcript-secret", "private-booking-secret", "attachment-secret", "private-person-attachment", "Old requirement"]) {
    assert.equal(sent.includes(excluded), false, excluded);
  }
});

test("lead name, company and linked person's role/email remain separate", async () => {
  const personId = randomUUID();
  table("agencyLeads").set(contactId, {
    id: contactId, name: "Taylor Example", company: "Example Engineering",
    phone: { primaryPhoneCallingCode: "44", primaryPhoneNumber: "2079460456" },
    personId, note: "Wants to automate appointment reminders",
  });
  table("agencyPeople").set(personId, {
    id: personId, name: "Taylor Example", jobTitle: "Operations manager",
    emails: { primaryEmail: "taylor@example.test" },
  });
  const started = await voice.startVoiceCall({ ...input(), contactType: "lead" }, memberId, null);
  await voice.handleVoiceEvent("call.answered", event(started.id));
  const { payload, briefing } = assistantStart();
  assert.equal(briefing.company.name, "Example Engineering");
  assert.equal(briefing.contact.name, "Taylor Example");
  assert.equal(briefing.contact.email, "taylor@example.test");
  assert.equal(briefing.contact.role, "Operations manager");
  assert.match(briefing.recordNotes!, /appointment reminders/);
  assert.match(payload.greeting as string, /Taylor Example at Example Engineering/);
});

test("a company/shared number never turns the business name or first employee into the recipient", async () => {
  for (const name of ["First Employee", "Second Employee"]) {
    const id = randomUUID();
    table("agencyPeople").set(id, { id, prospectId: contactId, name, emails: { primaryEmail: `${id}@example.test` } });
  }
  const started = await voice.startVoiceCall(input(), memberId, null);
  await voice.handleVoiceEvent("call.answered", event(started.id));
  const { payload, briefing } = assistantStart();
  assert.equal(briefing.contact.name, null);
  assert.equal(briefing.contact.email, null);
  assert.equal(briefing.contact.identity, "company_number_person_unknown");
  assert.match(payload.greeting as string, /Have I reached Fictional Test Company/);
  assert.doesNotMatch(payload.greeting as string, /Employee|Am I speaking with/);
});

test("CRM briefing errors block dialing and release reservations", async () => {
  failedObject = "noteTargets";
  await assert.rejects(voice.startVoiceCall(input(), memberId, null));
  assert.equal(providerCalls.length, 0);
  assert.equal(await locks.findLock("ai-voice"), null);
  assert.equal(await locks.findLock(`phone:${phoneId}`), null);
});

test("a changed number requires new authorisation before any provider call", async () => {
  refreshContact = { phone: "+442079460789" };
  await assert.rejects(voice.startVoiceCall(input(), memberId, null), /phone number changed/);
  assert.equal(providerCalls.length, 0);
  assert.equal(await locks.findLock("ai-voice"), null);
});

test("calls created with legacy encrypted state still answer without inventing personal details", async () => {
  const started = await voice.startVoiceCall(input(), memberId, null);
  table("agencyCalls").get(started.id)!.aiVoicePrivateState = encryptState({ company: "Legacy Company", script: "" });
  await voice.handleVoiceEvent("call.answered", event(started.id));
  const { payload, assistant } = assistantStart();
  assert.equal(assistant.instructions, ASSISTANT_INSTRUCTIONS);
  assert.deepEqual(JSON.parse(assistant.dynamic_variables.crm_context), { company: { name: "Legacy Company" } });
  assert.match(payload.greeting as string, /AI assistant/);
  assert.doesNotMatch(payload.greeting as string, /Am I speaking with/);
});

test("hangup finalizes and releases the number even when event and transcript locks are stalled", async () => {
  const started = await voice.startVoiceCall(input(), memberId, null);
  await voice.handleVoiceEvent("call.answered", event(started.id));
  await locks.acquireLock(`event:${started.id}`);
  await locks.acquireLock(`transcript:${started.id}`);
  assert.equal(await voice.handleVoiceEvent("call.playback.ended", event(started.id)), true);
  await voice.handleVoiceEvent("call.hangup", event(started.id, { end_time: new Date().toISOString(), hangup_cause: "normal_clearing" }));
  assert.equal((await voice.getVoiceCall(started.id)).aiVoiceState, "ENDED");
  assert.equal(await voice.activeVoiceCall(), null);
  assert.equal(await locks.findLock(`phone:${phoneId}`), null);
});

test("status polling recovers a missing hangup using exact provider end time and duration", async () => {
  const started = await voice.startVoiceCall(input(), memberId, null);
  await voice.handleVoiceEvent("call.answered", event(started.id));
  await locks.acquireLock(`event:${started.id}`);
  providerStatus = { ...providerStatus, is_alive: false, end_time: "2026-10-29T14:22:04Z", call_duration: 37 };
  assert.equal(await voice.activeVoiceCall(), null);
  const ended = await voice.getVoiceCall(started.id);
  assert.equal(ended.endedAt, "2026-10-29T14:22:04Z");
  assert.equal(ended.durationSeconds, 37);
  assert.equal(ended.status, "COMPLETED");
  assert.equal(await voice.activeVoiceCall(), null);
  assert.equal(await locks.findLock(`phone:${phoneId}`), null);
  await voice.handleVoiceEvent("call.hangup", event(started.id, { end_time: "2026-10-29T14:23:00Z" }));
  assert.equal((await voice.getVoiceCall(started.id)).endedAt, ended.endedAt);
});

test("stop reconciles Telnyx already-ended code 90018 instead of waiting forever", async () => {
  const started = await voice.startVoiceCall(input(), memberId, null);
  hangupError = "90018";
  providerStatus = { ...providerStatus, is_alive: false, end_time: new Date().toISOString() };
  assert.equal((await voice.stopVoiceCall(await voice.getVoiceCall(started.id))).aiVoiceState, "ENDED");
  assert.equal(await voice.activeVoiceCall(), null);
});

test("already-ended command evidence can release an expired status record without fabricating timing", async () => {
  const started = await voice.startVoiceCall(input(), memberId, null);
  hangupError = "90018";
  statusFailure = 404;
  const ended = await voice.stopVoiceCall(await voice.getVoiceCall(started.id));
  assert.equal(ended.aiVoiceState, "ENDED");
  assert.match(ended.aiVoiceError!, /exact end time is unavailable/);
  assert.equal(ended.endedAt, undefined);
  assert.equal(ended.durationSeconds, undefined);
  assert.equal(await locks.findLock("ai-voice"), null);
});

test("live, incomplete, mismatched and unavailable provider statuses never free a reservation", async () => {
  const started = await voice.startVoiceCall(input(), memberId, null);
  const call = await voice.getVoiceCall(started.id);
  assert.equal((await voice.stopVoiceCall(call)).aiVoiceState, "DIALING");
  providerStatus = { ...providerStatus, is_alive: false };
  assert.equal((await voice.reconcileVoiceCall(call)).aiVoiceState, "DIALING");
  providerStatus = { call_control_id: "different-call", is_alive: false, end_time: new Date().toISOString() };
  await assert.rejects(voice.reconcileVoiceCall(call), /valid status/);
  statusFailure = 403;
  await assert.rejects(voice.reconcileVoiceCall(call));
  statusFailure = undefined;
  hangupError = "90000";
  await assert.rejects(voice.stopVoiceCall(call));
  assert.ok(await locks.findLock("ai-voice"));
  assert.ok(await locks.findLock(`phone:${phoneId}`));
});

test("an interrupted terminal cleanup is recovered on the next status reconciliation", async () => {
  const started = await voice.startVoiceCall(input(), memberId, null);
  table("agencyCalls").get(started.id)!.aiVoiceState = "ENDED";
  assert.ok(await locks.findLock("ai-voice"));
  await voice.reconcileVoiceCall(await voice.getVoiceCall(started.id));
  assert.equal(await locks.findLock("ai-voice"), null);
  assert.equal(await locks.findLock(`phone:${phoneId}`), null);
});

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
  await voice.runVoiceTool(started.id, "availability", { start: "2026-11-03T00:00:00Z", end: "2026-11-04T00:00:00Z", timezone: "Europe/London" });
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
    assert.equal((await fetch(`${base}/profile`)).status, 401);
    for (const path of ["/settings", "/automation"]) assert.equal((await fetch(`${base}${path}`)).status, 401);
    for (const path of ["/settings", "/queue", "/automation/recover"]) {
      assert.equal((await fetch(`${base}${path}`, { method: path === "/settings" ? "PUT" : "POST" })).status, 401);
    }
    assert.equal((await fetch(`${base}/automation/run`, { method: "POST" })).status, 401);
    assert.equal((await fetch(`${base}/automation/run`, { method: "POST", headers: { Authorization: "Bearer wrong-scheduler-credential" } })).status, 401);
    assert.equal((await fetch(`${base}/profile`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Test AI" }) })).status, 401);
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
    assert.equal((await fetch(`${base}/profile`, { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ name: "Test AI" }) })).status, 401);
    const memberToken = generateToken({ userId: "test-user", workspaceMemberId: memberId });
    const operatorHeaders = { Authorization: `Bearer ${memberToken}` };
    assert.equal((await fetch(`${base}/automation/run`, { method: "POST", headers: operatorHeaders })).status, 401);
    const schedulerResponse = await fetch(`${base}/automation/run`, { method: "POST", headers: { Authorization: `Bearer ${process.env.AI_AUTOMATION_CRON_SECRET}` } });
    assert.equal(schedulerResponse.status, 200);
    assert.equal((await schedulerResponse.json() as { status: string }).status, "call_active");
    const liveStop = await fetch(`${base}/${call.id}/stop`, { method: "POST", headers: operatorHeaders });
    assert.equal(liveStop.status, 200);
    const liveResult = await liveStop.json() as { stopping: boolean; call: { active: boolean } };
    assert.equal(liveResult.stopping, true);
    assert.equal(liveResult.call.active, true);
    providerStatus = { ...providerStatus, is_alive: false, end_time: new Date().toISOString(), call_duration: 37 };
    const status = await fetch(`${base}/${call.id}`, { headers: operatorHeaders });
    assert.equal(status.status, 200);
    assert.equal((await status.json() as { state: string }).state, "ENDED");
    const endedStop = await fetch(`${base}/${call.id}/stop`, { method: "POST", headers: operatorHeaders });
    assert.equal(endedStop.status, 200);
    const endedResult = await endedStop.json() as { stopping: boolean; call: { active: boolean } };
    assert.equal(endedResult.stopping, false);
    assert.equal(endedResult.call.active, false);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("parallel and repeated cleanup retain released audit rows without deleting or touching a new owner", async () => {
  const lock = await locks.acquireLock("ai-voice", "first-owner");
  await Promise.all([locks.releaseOwnedLock("ai-voice", "first-owner"), locks.releaseOwnedLock("ai-voice", "first-owner")]);
  assert.equal(table("agencyVoiceLocks").get(lock.id)!.lockKey, null);
  const next = await locks.acquireLock("ai-voice", "next-owner");
  await locks.releaseLock(lock);
  await locks.releaseOwnedLock("ai-voice", "first-owner");
  assert.equal((await locks.findLock("ai-voice"))!.id, next.id);
  failedObject = "agencyVoiceLocks";
  await assert.rejects(locks.releaseLock(next), /update/);
});

test("calendar metadata remains available during a pending booking while other writes stay excluded", async () => {
  const call = await voice.startVoiceCall(input(), memberId, null);
  await voice.handleVoiceEvent("call.answered", event(call.id));
  const range = { start: "2026-11-03T00:00:00Z", end: "2026-11-04T00:00:00Z" };
  await assert.rejects(voice.runVoiceTool(call.id, "availability", { ...range, timezone: "Invalid/Zone" }), /timezone/);
  await voice.runVoiceTool(call.id, "availability", { ...range, timezone: "Europe/London" });
  const details = { start: "2026-11-03T10:00:00.000Z", name: "Test Attendee", email: "attendee@example.test", timezone: "Europe/London", confirmed: true };
  await assert.rejects(voice.runVoiceTool(call.id, "book", { ...details, timezone: "America/New_York" }), /timezone changed/);
  let release!: () => void;
  bookingGate = new Promise<void>((resolve) => { release = resolve; });
  const pending = voice.runVoiceTool(call.id, "book", details);
  try {
    while (!bookingRequests.length) await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal((await voice.runVoiceTool(call.id, "meeting_details", {}) as { connected: boolean }).connected, true);
    await assert.rejects(voice.runVoiceTool(call.id, "end", {}), /already in use/);
    await assert.rejects(voice.runVoiceTool(call.id, "book", details), /already in use/);
  } finally {
    release();
    await pending;
  }
  assert.equal(await locks.findLock(`tool:${call.id}`), null);
  assert.equal(bookingRequests.length, 1);
});

test("booked calls speak the persisted confirmation and hang up only after its matching speech ends", async () => {
  const call = await voice.startVoiceCall(input(), memberId, null);
  await voice.handleVoiceEvent("call.answered", event(call.id));
  await voice.runVoiceTool(call.id, "availability", { start: "2026-11-03T00:00:00Z", end: "2026-11-04T00:00:00Z", timezone: "Europe/London" });
  await voice.runVoiceTool(call.id, "book", {
    start: "2026-11-03T10:00:00.000Z", name: "Test Attendee", email: "attendee@example.test", timezone: "Europe/London", confirmed: true,
  });
  speakFails = true;
  await assert.rejects(voice.runVoiceTool(call.id, "end", {}));
  assert.match((await voice.getVoiceCall(call.id)).aiVoiceError!, /spoken confirmation failed/);
  assert.equal(providerCalls.some((call) => call.path.endsWith("/actions/hangup")), false);
  speakFails = false;
  await voice.runVoiceTool(call.id, "end", {});
  assert.equal((await voice.getVoiceCall(call.id)).aiVoiceError, "");
  const speech = providerCalls.filter((call) => call.path.endsWith("/actions/speak")).at(-1)!;
  assert.match(String(speech.body.payload), /Tuesday, 3 November 2026.*10 am.*Greenwich Mean Time.*Matthew/);
  assert.doesNotMatch(String(speech.body.payload), /:00/);
  assert.ok(providerCalls.some((call) => call.path.endsWith("/actions/ai_assistant_stop")));
  assert.equal(providerCalls.some((call) => call.path.endsWith("/actions/hangup")), false);
  await voice.handleVoiceEvent("call.speak.ended", event(call.id));
  assert.equal(providerCalls.some((call) => call.path.endsWith("/actions/hangup")), false);
  await locks.acquireLock(`event:${call.id}`);
  await voice.handleVoiceEvent("call.speak.ended", event(call.id, { client_state: speech.body.client_state }));
  assert.ok(providerCalls.some((call) => call.path.endsWith("/actions/hangup")));
  providerStatus = { ...providerStatus, is_alive: false, end_time: new Date().toISOString() };
  await voice.handleVoiceEvent("call.speak.ended", event(call.id, { client_state: speech.body.client_state }));
  assert.equal(await voice.activeVoiceCall(), null);
});

test("unbooked end remains immediate and unverified confirmation events cannot terminate a live call", async () => {
  const call = await voice.startVoiceCall(input(), memberId, null);
  await voice.handleVoiceEvent("call.answered", event(call.id));
  await assert.rejects(voice.handleVoiceEvent("call.speak.ended", event(call.id, {
    client_state: Buffer.from(JSON.stringify({ kind: "ai_voice", callId: call.id, purpose: "booking_confirmation" })).toString("base64"),
  })), /No verified booking/);
  await voice.runVoiceTool(call.id, "end", {});
  assert.equal(providerCalls.some((call) => call.path.endsWith("/actions/speak")), false);
  assert.ok(providerCalls.some((call) => call.path.endsWith("/actions/hangup")));
});

test("shared AI profile is validated and persisted without overwriting human call attribution", async () => {
  assert.deepEqual(await readAgentProfile(), { name: "Fewzen AI" });
  for (const name of ["", " ", "x".repeat(81), "bad\nname"]) {
    await assert.rejects(saveAgentProfile({ name }, null), /agent name/);
  }
  assert.deepEqual(await saveAgentProfile({ name: "  Discovery Scout  " }, null), { name: "Discovery Scout" });
  assert.deepEqual(await readAgentProfile(), { name: "Discovery Scout" });
  const call = await voice.startVoiceCall(input(), memberId, null);
  const mapped = mapCall(await voice.getVoiceCall(call.id));
  assert.equal(mapped.isAiVoice, true);
  assert.equal(mapped.createdByMemberId, memberId);
  assert.equal(mapCall({ id: "human-call", createdByMemberId: memberId }).isAiVoice, false);
  await saveAgentProfile({ name: "Renamed Scout" }, null);
  assert.equal((await voice.getVoiceCall(call.id)).createdByMemberId, memberId);
  failedObject = "agencyPhones";
  await assert.rejects(readAgentProfile(), /403/);
});

test("calendar is fetched before dialing, survives the answer webhook and permits direct UK booking", async () => {
  const call = await voice.startVoiceCall(input(), memberId, null);
  const state = decryptState<{ calendar: { timezone: string; slots: string[]; spokenSlots: { label: string }[] }; slots: string[] }>((await voice.getVoiceCall(call.id)).aiVoicePrivateState);
  assert.equal(state.calendar.timezone, "Europe/London");
  assert.deepEqual(state.slots, state.calendar.slots);
  await voice.handleVoiceEvent("call.answered", event(call.id));
  assert.deepEqual(JSON.parse(assistantStart().assistant.dynamic_variables.calendar_context), state.calendar);
  await voice.runVoiceTool(call.id, "book", {
    start: state.slots[0], name: "Test Attendee", email: "attendee@example.test", confirmed: true,
  });
  assert.equal(bookingRequests[0].timezone, "Europe/London");
});

test("pre-call calendar failures are explicit, prevent dialing and release reservations", async () => {
  calendarFails = true;
  await assert.rejects(voice.startVoiceCall(input(), memberId, null), /Booking service returned 503/);
  assert.equal(providerCalls.length, 0);
  assert.equal(await locks.findLock("ai-voice"), null);
  assert.equal(await locks.findLock(`phone:${phoneId}`), null);
});

async function incoming() {
  process.env.AI_VOICE_INBOUND_ENABLED = "true";
  const payload = { call_control_id: "incoming-provider-id", direction: "incoming", from: "+447700900999", to: process.env.TELNYX_INBOUND_NUMBER };
  await inbound.handleInboundVoiceEvent("call.initiated", payload);
  const call = [...table("agencyCalls").values()][0];
  const answered = { ...payload, client_state: Buffer.from(JSON.stringify({ kind: "ai_voice", callId: call.id })).toString("base64") };
  await voice.handleVoiceEvent("call.answered", answered);
  return { call: await voice.getVoiceCall(call.id), payload, answered };
}

function transferEvent(eventType: string, extra: Record<string, unknown> = {}) {
  const dial = providerCalls.filter((call) => call.path === "/v2/calls" && call.body.to === process.env.TELNYX_FALLBACK_PHONE).at(-1)!;
  return inbound.handleInboundVoiceEvent(eventType, { call_control_id: "transfer-leg-id", client_state: dial.body.client_state, ...extra });
}

test("inbound routing is opt-in and answers one AI call without taking outbound number reservations", async () => {
  const payload = { call_control_id: "incoming-provider-id", direction: "incoming", from: "anonymous", to: process.env.TELNYX_INBOUND_NUMBER };
  assert.equal(await inbound.handleInboundVoiceEvent("call.initiated", payload), false);
  const { call, payload: first, answered } = await incoming();
  await inbound.handleInboundVoiceEvent("call.initiated", first);
  await voice.handleVoiceEvent("call.answered", answered);
  assert.equal(table("agencyCalls").size, 1);
  assert.equal(call.direction, "INBOUND");
  assert.equal(call.aiVoicePermission, "inbound_requested");
  assert.equal(await locks.findLock("ai-voice"), null);
  assert.equal(await locks.findLock(`phone:${phoneId}`), null);
  const starts = providerCalls.filter((call) => call.path.endsWith("/actions/ai_assistant_start"));
  assert.equal(starts.length, 1);
  assert.equal((starts[0].body.assistant as { id: string }).id, "test-inbound-assistant");
  assert.match(String(starts[0].body.greeting), /reached Fewzen.*AI assistant.*leave Matthew a message/);
  assert.equal(providerCalls.some((call) => call.path === "/v2/calls"), false);
  assert.equal(await inbound.handleInboundVoiceEvent("call.initiated", { ...first, to: "+442079469999" }), false);
});

test("inbound reception remains available with an explicit warning when calendar preload fails", async () => {
  calendarFails = true;
  const { call } = await incoming();
  assert.equal(call.aiVoiceState, "ACTIVE");
  assert.match(call.aiVoiceError!, /without calendar preload/);
  assert.equal(assistantStart().assistant.dynamic_variables.calendar_context, "null");
});

test("inbound messages need consent, persist on the call and create exactly one linked task", async () => {
  const { call } = await incoming();
  const message = { name: "Test Caller", company: "Example", contact: "caller@example.test", message: "Please discuss automating our invoicing.", confirmed: true };
  await assert.rejects(inbound.runInboundTool(call.id, "leave_message", { ...message, confirmed: false }), /agree/);
  await assert.rejects(inbound.runInboundTool(call.id, "leave_message", { ...message, contact: "" }), /contact/);
  assert.deepEqual(await inbound.runInboundTool(call.id, "leave_message", message), { messageSaved: true, followUpCreated: true });
  await inbound.runInboundTool(call.id, "leave_message", message);
  assert.equal(table("tasks").size, 1);
  assert.equal(table("taskTargets").size, 1);
  assert.match((await voice.getVoiceCall(call.id)).notes!, /Test Caller.*Example[\s\S]*caller@example.test[\s\S]*invoicing/);
  await assert.rejects(inbound.runInboundTool(call.id, "leave_message", { ...message, message: "Replacement" }), /already been saved/);
});

test("message task failures are explicit and retry the original saved message", async () => {
  const { call } = await incoming();
  const message = { name: "Test Caller", contact: "+447700900999", message: "Please call back.", confirmed: true };
  failedObject = "tasks";
  await assert.rejects(inbound.runInboundTool(call.id, "leave_message", message));
  assert.match((await voice.getVoiceCall(call.id)).notes!, /Please call back/);
  failedObject = undefined;
  await inbound.runInboundTool(call.id, "leave_message", message);
  assert.equal(table("tasks").size, 1);
});

test("lost task responses recover without duplicates or reusing an unrelated analysis task", async () => {
  const { call } = await incoming();
  const oldTask = randomUUID();
  table("tasks").set(oldTask, { id: oldTask, title: "Unrelated analysis task" });
  table("taskTargets").set("old-target", { id: "old-target", taskId: oldTask, targetAgencyCallId: call.id });
  const message = { name: "Test Caller", contact: "caller@example.test", message: "Please discuss AI.", confirmed: true };
  lostTaskResponse = true;
  await assert.rejects(inbound.runInboundTool(call.id, "leave_message", message));
  assert.equal(table("tasks").size, 2);
  failedObject = "taskTargets";
  await assert.rejects(inbound.runInboundTool(call.id, "leave_message", message));
  assert.equal(table("tasks").size, 2);
  failedObject = undefined;
  await inbound.runInboundTool(call.id, "leave_message", message);
  assert.equal(table("tasks").size, 2);
  assert.equal(table("taskTargets").size, 2);
});

test("outbound conversations cannot invoke inbound message or handoff tools", async () => {
  const call = await voice.startVoiceCall(input(), memberId, null);
  await voice.handleVoiceEvent("call.answered", event(call.id));
  await assert.rejects(inbound.runInboundTool(call.id, "transfer_status", {}), /inbound AI conversation/);
  await assert.rejects(inbound.runInboundTool(call.id, "leave_message", {}), /inbound AI conversation/);
});

test("live handoff is denied outside hours, on holidays and without caller agreement", async (t) => {
  const { call } = await incoming();
  await assert.rejects(inbound.runInboundTool(call.id, "connect_matthew", {}), /agree/);
  for (const date of ["2026-10-29T17:00:00Z", "2026-10-31T12:00:00Z", "2026-12-25T10:00:00Z"]) {
    const clock = t.mock.method(Date, "now", () => Date.parse(date));
    const result = await inbound.runInboundTool(call.id, "connect_matthew", { confirmed: true }) as { connecting: boolean; open: boolean };
    assert.equal(result.connecting, false);
    assert.equal(result.open, false);
    clock.mock.restore();
  }
  assert.equal(providerCalls.some((call) => call.path === "/v2/calls"), false);
});

test("handoff dials only the private configured number and bridges only after Matthew presses 1", async (t) => {
  const { call } = await incoming();
  t.mock.method(Date, "now", () => Date.parse("2026-10-29T10:00:00Z"));
  assert.equal((await inbound.runInboundTool(call.id, "transfer_status", {}) as { open: boolean }).open, true);
  await inbound.runInboundTool(call.id, "connect_matthew", { confirmed: true, destination: "+12025550123" });
  await inbound.runInboundTool(call.id, "connect_matthew", { confirmed: true });
  const dials = providerCalls.filter((call) => call.path === "/v2/calls");
  assert.equal(dials.length, 1);
  assert.equal(dials[0].body.to, process.env.TELNYX_FALLBACK_PHONE);
  assert.equal("bridge_on_answer" in dials[0].body, false);
  await transferEvent("call.answered");
  assert.equal(providerCalls.some((call) => call.path.endsWith("/actions/bridge")), false);
  assert.match(String(providerCalls.find((call) => call.path.endsWith("/actions/gather_using_speak"))!.body.payload), /Press 1/);
  await transferEvent("call.gather.ended", { digits: "1" });
  assert.equal(providerCalls.filter((call) => call.path.endsWith("/actions/bridge")).length, 1);
  await transferEvent("call.gather.ended", { digits: "1" });
  assert.equal(providerCalls.filter((call) => call.path.endsWith("/actions/bridge")).length, 1);
  process.env.AI_VOICE_INBOUND_ENABLED = "false";
  await transferEvent("call.hangup");
  const resumed = providerCalls.filter((call) => call.path.endsWith("/actions/ai_assistant_start")).at(-1)!;
  assert.match(String(resumed.body.greeting), /take a message.*book a meeting/);
  assert.equal((await voice.getVoiceCall(call.id)).aiVoiceState, "ACTIVE");
});

test("voicemail, declined and unanswered mobile legs return the caller to AI without bridging", async (t) => {
  const { call } = await incoming();
  t.mock.method(Date, "now", () => Date.parse("2026-10-29T10:00:00Z"));
  await inbound.runInboundTool(call.id, "connect_matthew", { confirmed: true });
  await transferEvent("call.answered");
  await transferEvent("call.gather.ended", { digits: "" });
  assert.equal(providerCalls.some((call) => call.path.endsWith("/actions/bridge")), false);
  assert.equal(providerCalls.filter((call) => call.path.endsWith("/actions/ai_assistant_start")).length, 2);
  await transferEvent("call.hangup");
  assert.equal(providerCalls.filter((call) => call.path.endsWith("/actions/ai_assistant_start")).length, 2);
  const before = providerCalls.length;
  await inbound.runInboundTool(call.id, "connect_matthew", { confirmed: true });
  await transferEvent("call.hangup");
  assert.ok(providerCalls.slice(before).some((call) => call.path.endsWith("/actions/ai_assistant_start")));
});

test("late acceptance after 5 pm cannot bridge and uncertain transfers cannot redial", async (t) => {
  const { call } = await incoming();
  const clock = t.mock.method(Date, "now", () => Date.parse("2026-10-29T16:59:00Z"));
  uncertainTransfer = true;
  await assert.rejects(inbound.runInboundTool(call.id, "connect_matthew", { confirmed: true }), /uncertain/);
  await assert.rejects(inbound.runInboundTool(call.id, "connect_matthew", { confirmed: true }), /uncertain/);
  assert.equal(providerCalls.filter((call) => call.path === "/v2/calls").length, 1);
  await transferEvent("call.answered");
  assert.ok(providerCalls.some((call) => call.path.endsWith("/actions/hangup")));
  assert.equal(providerCalls.some((call) => call.path.endsWith("/actions/bridge")), false);
  await transferEvent("call.hangup");
  uncertainTransfer = false;
  await inbound.runInboundTool(call.id, "connect_matthew", { confirmed: true });
  clock.mock.restore();
  t.mock.method(Date, "now", () => Date.parse("2026-10-29T17:00:00Z"));
  const dial = providerCalls.filter((call) => call.path === "/v2/calls").at(-1)!;
  const payload = { call_control_id: "transfer-leg-id", client_state: dial.body.client_state };
  await inbound.handleInboundVoiceEvent("call.answered", payload);
  await inbound.handleInboundVoiceEvent("call.gather.ended", { ...payload, digits: "1" });
  assert.equal(providerCalls.some((call) => call.path.endsWith("/actions/bridge")), false);
});

test("caller hangup terminates a ringing mobile leg and releases the AI call", async (t) => {
  const { call, answered } = await incoming();
  t.mock.method(Date, "now", () => Date.parse("2026-10-29T10:00:00Z"));
  await inbound.runInboundTool(call.id, "connect_matthew", { confirmed: true });
  await inbound.handleInboundVoiceEvent("call.hangup", answered);
  await voice.handleVoiceEvent("call.hangup", { ...answered, end_time: new Date().toISOString() });
  assert.ok(providerCalls.some((call) => call.path === "/v2/calls/transfer-leg-id/actions/hangup"));
  assert.equal((await voice.getVoiceCall(call.id)).aiVoiceState, "ENDED");
  await transferEvent("call.answered");
  assert.equal(providerCalls.some((call) => call.path.endsWith("/actions/bridge")), false);
});
