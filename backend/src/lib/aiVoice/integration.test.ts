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
const { mapCall } = await import("../../routes/calls/helpers/mapCall.js");
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
      providerCalls.push({ path: url.pathname, body });
      if (url.pathname.endsWith("/actions/speak") && speakFails) {
        return Response.json({ errors: [{ code: "test-speech-error" }] }, { status: 422 });
      }
      if (url.pathname.endsWith("/actions/hangup") && hangupError) {
        return Response.json({ errors: [{ code: hangupError, title: "Test provider rejection" }] }, { status: 422 });
      }
      return Response.json({ data: url.pathname === "/v2/calls" && !uncertainDial ? { call_control_id: "fake-call-control-id" } : {} });
    }
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
        { node: { id: "phones", nameSingular: "agencyPhone", namePlural: "agencyPhones", fields: { edges: [{ node: { name: "aiAgentName", type: "TEXT", isActive: true } }] } } },
      ] } } });
    }
    const [, , object, id] = url.pathname.split("/");
    const rows = table(object);
    if (object === failedObject) return Response.json({ error: "CRM context unavailable" }, { status: 403 });
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
    if (id) {
      if (object === "agencyProspects" && id === contactId && ++contactReads === 2 && refreshContact) {
        Object.assign(rows.get(id)!, refreshContact);
      }
      return rows.has(id) ? Response.json({ data: rows.get(id) }) : Response.json({ error: "not found" }, { status: 404 });
    }
    const filter = url.searchParams.get("filter");
    const match = filter?.match(/^(\w+)\[eq\]:"([^"]+)"$/);
    const ids = filter?.match(/^id\[in\]:\[([^\]]+)\]$/)?.[1].split(",");
    const found = [...rows.values()].filter((row) => (!match || row[match[1]] === match[2]) && (!ids || ids.includes(row.id)));
    if (url.searchParams.get("orderBy") === "createdAt[DescNullsLast]") {
      found.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    }
    return Response.json({ data: { [object]: found.slice(0, Number(url.searchParams.get("limit")) || found.length) } });
  };
});

afterEach(() => { globalThis.fetch = originalFetch; });
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
