import { afterEach, beforeEach, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import express from "express";

process.env.TWENTY_BASE_URL = "https://crm.example.test";
process.env.TWENTY_API_KEY = "test-only";
process.env.TWENTY_REQUESTS_PER_MINUTE = "100000";
process.env.OPENAI_API_KEY = "test-only";
process.env.OPENAI_BASE_URL = "https://ai.example.test";
process.env.JWT_SECRET = "test-only-secret-at-least-thirty-two-characters";
process.env.TELNYX_WEBHOOK_TOKEN = "test-only-webhook";
process.env.TELNYX_API_KEY = "test-only-telnyx-key";

const { createFollowUpTasks, listCallTasks } = await import("./followUpTasks.js");
const { transcribeRecording } = await import("./transcribeRecording.js");
const { default: callsRouter } = await import("../../../routes/calls/index.js");
const { default: webhookRouter } = await import("../../../routes/telnyx/webhook/index.js");
const { default: legacyWebhook } = await import(new URL("../../../../../frontend/api/telnyx-webhook.ts", import.meta.url).href);
const { generateToken } = await import("../../../middleware/auth.js");
const originalFetch = globalThis.fetch;
type Row = { id: string; [key: string]: unknown };
const data = new Map<string, Map<string, Row>>();
const call = {
  id: "11111111-1111-4111-8111-111111111111",
  agencyProspectId: "22222222-2222-4222-8222-222222222222",
  agencyLeadId: "33333333-3333-4333-8333-333333333333",
  createdByMemberId: "44444444-4444-4444-8444-444444444444",
  telnyxCallId: "test-telnyx-call",
  transcript: "Vanessa: Send information to office@example.test and I will forward it. Agent: I will send it today.",
};
const proposed = [
  { title: "Send Tech and AI information to Vanessa", description: "Send the agreed details to office@example.test.", dueAt: null },
  { title: "Prepare agreed quote", description: "Prepare the requested quote.", dueAt: "2026-10-31T09:00:00.000Z" },
];
let failTarget: string | null;
let failRead: boolean;
let loseCreate: string | null;
let ignoreTarget: string | null;
let analysisRequest: { messages: { role: string; content: string }[]; max_tokens: number };
let modelTasks: Record<string, unknown>[];
let transcriptionRequests: FormData[];
let recordingRequests: Record<string, unknown>[];
let transcriptionResponse: string | number;
let failTranscriptWrite: boolean;
let loseAudioResponse: boolean;
let failResultWrite: boolean;
const targetRequests: URL[] = [];

function table(object: string) {
  let rows = data.get(object);
  if (!rows) { rows = new Map<string, Row>(); data.set(object, rows); }
  return rows;
}

beforeEach(() => {
  data.clear();
  table("agencyCalls").set(call.id, { ...call });
  failTarget = null;
  failRead = false;
  loseCreate = null;
  ignoreTarget = null;
  targetRequests.length = 0;
  transcriptionRequests = [];
  recordingRequests = [];
  transcriptionResponse = call.transcript;
  failTranscriptWrite = false;
  loseAudioResponse = false;
  failResultWrite = false;
  modelTasks = [{
    title: "Email the Tech and AI service overview to Vanessa",
    objective: "Give Vanessa the service overview for the relevant team.",
    recipient: { name: "Vanessa", email: "office@example.test" },
    steps: ["Prepare the Tech and AI service overview.", "Send the overview to office@example.test for Vanessa.", "Record the sent-message reference on the linked contact."],
    completionCriteria: ["The sent-message record identifies office@example.test and the service overview."],
    evidence: ["Vanessa: Send information to office@example.test and I will forward it."],
    missingInformation: ["Confirm the approved service overview before you send it."],
    due: null,
  }];
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    if (url.hostname === "127.0.0.1") return originalFetch(input, init);
    if (url.hostname === "api.telnyx.com") {
      if (url.pathname === "/v2/ai/audio/transcriptions") {
        const request = new Request(input, init);
        transcriptionRequests.push(await request.formData());
        if (loseAudioResponse) throw new Error("Audio response lost");
        if (typeof transcriptionResponse === "number") return Response.json({ error: "Transcription unavailable" }, { status: transcriptionResponse });
        return Response.json({ text: transcriptionResponse });
      }
      if (url.pathname.endsWith("/actions/record_start")) {
        recordingRequests.push(JSON.parse(String(init?.body)));
        return Response.json({ data: { recording_id: "recording-test" } });
      }
      assert.equal(url.pathname, "/v2/recordings/recording-test");
      return Response.json({ data: { id: "recording-test", status: "completed", download_urls: { mp3: "https://recording.example.test/audio.mp3" } } });
    }
    if (url.hostname === "ai.example.test") {
      analysisRequest = JSON.parse(String(init?.body));
      return Response.json({ choices: [{ message: { content: JSON.stringify({
      summary: "Agreed to send information to Vanessa.", sentiment: "POSITIVE", score: 72,
      keyPoints: ["Send the information"], tasks: modelTasks,
      }) } }] });
    }
    assert.equal(url.hostname, "crm.example.test", "Tests must not contact real external services");
    const [, , object, id] = url.pathname.split("/");
    const rows = table(object);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (method === "POST") {
      if (object === "taskTargets" && body[failTarget ?? ""]) return Response.json({ error: "Link unavailable" }, { status: 403 });
      const newId = body.id ?? randomUUID();
      if (rows.has(newId)) return Response.json({ error: "Already exists" }, { status: 409 });
      const row = { ...body, id: newId };
      if (ignoreTarget) delete row[ignoreTarget];
      rows.set(newId, row);
      if (loseCreate === object) { loseCreate = null; throw new Error("Response lost after create"); }
      return Response.json({ data: row });
    }
    if (method === "PATCH") {
      if (object === "agencyRecordingTranscriptions" && failResultWrite) return Response.json({ error: "Result write unavailable" }, { status: 403 });
      if (object === "agencyCalls" && body.transcript && failTranscriptWrite) return Response.json({ error: "CRM write unavailable" }, { status: 403 });
      const row = { ...rows.get(id), ...body, id };
      rows.set(id, row);
      return Response.json({ data: row });
    }
    if (object === "taskTargets" && failRead) return Response.json({ error: "Task access denied" }, { status: 403 });
    if (id) return rows.has(id) ? Response.json({ data: rows.get(id) }) : Response.json({ error: "Missing" }, { status: 404 });
    if (object === "taskTargets") targetRequests.push(url);
    const conditions = [...(url.searchParams.get("filter") ?? "").matchAll(/(\w+)\[eq\]:"([^"]+)"/g)];
    let found = [...rows.values()].filter((row) => conditions.every(([, field, value]) => row[field] === value));
    const cursor = url.searchParams.get("startingAfter");
    if (cursor) found = found.filter((row) => row.id > cursor);
    const limit = Number(url.searchParams.get("limit")) || found.length;
    return Response.json({ data: { [object]: found.slice(0, limit) }, pageInfo: { hasNextPage: found.length > limit, endCursor: found.slice(0, limit).at(-1)?.id } });
  };
});

afterEach(() => { globalThis.fetch = originalFetch; });

async function serve(t: TestContext) {
  const app = express();
  app.use(express.json());
  app.use("/api/calls", callsRouter);
  app.use("/api/telnyx-webhook", webhookRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers = { Authorization: `Bearer ${generateToken({ userId: "test" })}` };
  return { base, headers };
}

test("native tasks retain owner, description, dates and links; repeated analysis preserves task edits", async () => {
  assert.equal(await createFollowUpTasks(call, proposed), 2);
  assert.equal(table("tasks").size, 2);
  assert.equal(table("taskTargets").size, 6);
  const [task] = await listCallTasks(call.id);
  assert.equal(task.assigneeId, call.createdByMemberId);
  assert.match(task.description, /office@example.test/);
  assert.equal((await listCallTasks(call.id))[1].dueAt, proposed[1].dueAt);
  table("tasks").get(task.id)!.status = "DONE";
  table("tasks").get(task.id)!.bodyV2 = { markdown: "Agent edited notes" };
  assert.equal(await createFollowUpTasks(call, proposed), 0);
  assert.equal(table("tasks").size, 2);
  assert.equal(table("taskTargets").size, 6);
  assert.equal((await listCallTasks(call.id))[0].status, "DONE");
  assert.equal((await listCallTasks(call.id))[0].description, "Agent edited notes");
});

test("partial links, lost responses and concurrent retries recover without duplicate tasks", async () => {
  failTarget = "targetAgencyProspectId";
  await assert.rejects(createFollowUpTasks(call, proposed), /403/);
  assert.equal(table("tasks").size, 1);
  failTarget = null;
  loseCreate = "tasks";
  await Promise.all([createFollowUpTasks(call, proposed), createFollowUpTasks(call, proposed)]);
  assert.equal(table("tasks").size, 2);
  assert.equal(table("taskTargets").size, 6);
});

test("re-analysis repairs call-only tasks even when the new analysis proposes no tasks", async () => {
  const id = randomUUID();
  table("tasks").set(id, { id, title: "Old follow-up", status: "DONE", bodyV2: { markdown: "User notes" } });
  table("taskTargets").set("call-only", { id: "call-only", taskId: id, targetAgencyCallId: call.id });
  const stale = { id: call.id };
  assert.equal(await createFollowUpTasks(stale, []), 0);
  const [task] = await listCallTasks(call.id);
  assert.deepEqual(task.contacts, [{ type: "prospect", id: call.agencyProspectId }, { type: "lead", id: call.agencyLeadId }]);
  assert.equal(task.status, "DONE");
  assert.equal(task.description, "User notes");
  assert.equal(table("tasks").size, 1);
});

test("late call association repairs existing task contact links without running AI", async (t) => {
  const { base, headers } = await serve(t);
  const id = randomUUID();
  table("tasks").set(id, { id, title: "Send the overview" });
  table("taskTargets").set("call-only", { id: "call-only", taskId: id, targetAgencyCallId: call.id });
  const response = await originalFetch(`${base}/api/calls/${call.id}`, {
    method: "PATCH", headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ agencyProspectId: call.agencyProspectId }),
  });
  assert.equal(response.status, 200);
  assert.equal((await listCallTasks(call.id))[0].contacts.length, 2);
});

test("a call without a contact cannot silently create call-only analysis tasks", async () => {
  table("agencyCalls").set(call.id, { id: call.id });
  await assert.rejects(createFollowUpTasks(call, proposed), /no linked contact/);
  assert.equal(table("tasks").size, 0);
});

test("a success response that omits the native contact relation is reported as a failure", async () => {
  ignoreTarget = "targetAgencyProspectId";
  await assert.rejects(createFollowUpTasks(call, proposed), /did not save the task link/);
});

test("analysis uses full call evidence after character 12000 and the original call date", async (t) => {
  const { base, headers } = await serve(t);
  const transcript = `${"Call context. ".repeat(1100)}${call.transcript}`;
  table("agencyCalls").set(call.id, { ...call, transcript, startedAt: "2026-10-28T11:01:00Z" });
  const response = await originalFetch(`${base}/api/calls/${call.id}/analyze`, { method: "POST", headers });
  assert.equal(response.status, 200);
  assert.match(analysisRequest.messages[0].content, /ASD-STE100/);
  assert.match(analysisRequest.messages[1].content, /Call date: 2026-10-28/);
  assert(analysisRequest.messages[1].content.endsWith(call.transcript));
  assert(analysisRequest.max_tokens >= 3000);
  const tasks = await listCallTasks(call.id);
  assert.match(tasks[0].description, /Email: office@example.test/);
});

test("linked task reads stay scoped to the call across multiple pages", async () => {
  for (let index = 0; index < 201; index++) {
    const id = String(index).padStart(4, "0");
    table("tasks").set(id, { id, title: `Task ${index}`, status: "TODO" });
    table("taskTargets").set(id, { id, taskId: id, targetAgencyCallId: call.id });
  }
  table("tasks").set("unrelated", { id: "unrelated", title: "Another call task" });
  table("taskTargets").set("unrelated", { id: "unrelated", taskId: "unrelated", targetAgencyCallId: "other-call" });
  const tasks = await listCallTasks(call.id);
  assert.equal(tasks.length, 201);
  assert(!tasks.some((task) => task.id === "unrelated"));
  const pages = targetRequests.filter((url) => url.searchParams.get("filter")?.startsWith("targetAgencyCallId"));
  assert.equal(pages.length, 2);
  assert(pages.every((url) => url.searchParams.get("filter") === `targetAgencyCallId[eq]:"${call.id}"`));
});

test("manual analysis exposes task failures separately, lists persisted tasks and retries", async (t) => {
  const { base, headers } = await serve(t);
  failTarget = "targetAgencyCallId";
  const failed = await originalFetch(`${base}/api/calls/${call.id}/analyze`, { method: "POST", headers });
  assert.equal(failed.status, 200);
  const result = await failed.json();
  assert.equal(result.ok, false);
  assert.match(result.taskSync.error, /could not all be saved/);
  assert.equal(table("agencyCalls").get(call.id)!.aiScore, 72);
  failTarget = null;
  const retried = await originalFetch(`${base}/api/calls/${call.id}/analyze`, { method: "POST", headers });
  assert.equal((await retried.json()).taskSync.error, null);
  const tasks = await originalFetch(`${base}/api/calls/${call.id}/tasks`, { headers }).then((res) => res.json());
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].title, modelTasks[0].title);
  assert.match(tasks[0].description, /## Procedure/);
  assert.match(tasks[0].description, /office@example.test/);
  assert.match(tasks[0].description, /## Source records/);
  assert.deepEqual(tasks[0].contacts, [{ type: "prospect", id: call.agencyProspectId }, { type: "lead", id: call.agencyLeadId }]);
  assert.equal(table("tasks").size, 1);
  failRead = true;
  const unavailable = await originalFetch(`${base}/api/calls/${call.id}/tasks`, { headers });
  assert.equal(unavailable.status, 502);
  assert.match((await unavailable.json()).error, /Could not load/);
});

test("no agreed follow-ups creates no tasks and tasks endpoints require authentication", async (t) => {
  const { base, headers } = await serve(t);
  modelTasks = [];
  const analyzed = await originalFetch(`${base}/api/calls/${call.id}/analyze`, { method: "POST", headers }).then((res) => res.json());
  assert.deepEqual(analyzed.taskSync, { created: 0, error: null });
  assert.equal(table("tasks").size, 0);
  assert.equal((await originalFetch(`${base}/api/calls/${call.id}/tasks`)).status, 401);
});

test("both webhook receivers create tasks before returning and manual analysis reuses them", async (t) => {
  const { base, headers } = await serve(t);
  const body = { data: { event_type: "call.recording.transcription.saved", payload: {
    call_control_id: call.telnyxCallId, transcript: call.transcript,
  } } };
  const response = await originalFetch(`${base}/api/telnyx-webhook?token=test-only-webhook`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  assert.equal(table("tasks").size, 1);
  table("tasks").clear();
  table("taskTargets").clear();
  let status = 0;
  await legacyWebhook({ method: "POST", query: { token: "test-only-webhook" }, body }, {
    status(code: number) { status = code; return this; },
    json() {},
  });
  assert.equal(status, 200);
  assert.equal(table("tasks").size, 1);
  await originalFetch(`${base}/api/calls/${call.id}/analyze`, { method: "POST", headers });
  assert.equal(table("tasks").size, 1);
});

function awaitingRecording() {
  table("agencyCalls").set(call.id, { ...call, transcript: "", telnyxRecordingId: "recording-test" });
}

test("recording start disables built-in transcription", async (t) => {
  const { base, headers } = await serve(t);
  const response = await originalFetch(`${base}/api/calls/${call.id}/record`, { method: "POST", headers });
  assert.equal(response.status, 200);
  assert.equal(recordingRequests.length, 1);
  assert.equal(recordingRequests[0].transcription, false);
  assert.equal(transcriptionRequests.length, 0);
});

test("one Whisper English request survives concurrent deliveries and later duplicates", async () => {
  awaitingRecording();
  await Promise.all([transcribeRecording(call.id), transcribeRecording(call.id)]);
  await transcribeRecording(call.id);
  assert.equal(transcriptionRequests.length, 1);
  assert.equal(transcriptionRequests[0].get("model"), "openai/whisper-large-v3-turbo");
  assert.equal(transcriptionRequests[0].get("language"), "en");
  assert.equal(transcriptionRequests[0].get("file_url"), "https://recording.example.test/audio.mp3");
  assert.equal(table("agencyCalls").get(call.id)!.transcript, call.transcript);
  assert.equal(table("agencyCalls").get(call.id)!.transcriptionStatus, "READY");
});

test("AI voice calls retain their conversation-event transcript pipeline", async () => {
  awaitingRecording();
  table("agencyCalls").get(call.id)!.aiVoiceRequestId = randomUUID();
  await transcribeRecording(call.id);
  assert.equal(transcriptionRequests.length, 0);
  assert.equal(table("agencyRecordingTranscriptions").size, 0);
});

test("a second call row for the same recording does not cause a second transcription", async () => {
  awaitingRecording();
  await transcribeRecording(call.id);
  const secondId = randomUUID();
  table("agencyCalls").set(secondId, { ...call, id: secondId, transcript: "", telnyxRecordingId: "recording-test" });
  await transcribeRecording(secondId);
  assert.equal(transcriptionRequests.length, 1);
  assert.equal(table("agencyCalls").get(secondId)!.transcript, call.transcript);
});

test("empty or failed transcription is explicit and never automatically resubmitted", async () => {
  for (const response of ["", 500]) {
    data.clear();
    awaitingRecording();
    transcriptionResponse = response;
    const before = transcriptionRequests.length;
    await assert.rejects(transcribeRecording(call.id), /Automatic resubmission is disabled/);
    assert.equal(table("agencyCalls").get(call.id)!.transcriptionStatus, "FAILED");
    await transcribeRecording(call.id);
    assert.equal(transcriptionRequests.length, before + 1, "including SDK retries");
  }
});

test("a saved transcription result repairs a failed call write without another paid request", async () => {
  awaitingRecording();
  failTranscriptWrite = true;
  await assert.rejects(transcribeRecording(call.id), /CRM write unavailable/);
  failTranscriptWrite = false;
  await transcribeRecording(call.id);
  assert.equal(transcriptionRequests.length, 1);
  assert.equal(table("agencyCalls").get(call.id)!.transcriptionStatus, "READY");
});

test("an uncertain reservation response never causes an automatic transcription attempt", async () => {
  awaitingRecording();
  loseCreate = "agencyRecordingTranscriptions";
  await transcribeRecording(call.id);
  await transcribeRecording(call.id);
  assert.equal(transcriptionRequests.length, 0);
  assert.equal(table("agencyRecordingTranscriptions").size, 1);
});

test("lost audio responses and failed result writes cannot trigger a second paid request", async () => {
  for (const failure of ["audio", "result"]) {
    data.clear();
    awaitingRecording();
    loseAudioResponse = failure === "audio";
    failResultWrite = failure === "result";
    const before = transcriptionRequests.length;
    await assert.rejects(transcribeRecording(call.id), /Automatic resubmission is disabled/);
    await transcribeRecording(call.id);
    assert.equal(transcriptionRequests.length, before + 1);
    assert.equal(table("agencyCalls").get(call.id)!.transcriptionStatus, "FAILED");
  }
});

test("recording reconciliation uses the same single-pass transcription and analysis flow", async (t) => {
  awaitingRecording();
  const { base, headers } = await serve(t);
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await originalFetch(`${base}/api/calls/${call.id}/reconcile`, { method: "POST", headers });
    assert.equal(response.status, 200);
  }
  assert.equal(transcriptionRequests.length, 1);
  assert.equal(table("agencyCalls").get(call.id)!.transcriptionStatus, "READY");
  assert.equal(table("tasks").size, 1);
});

test("both recording webhooks save Whisper text, analyze it, and reject later legacy transcripts", async (t) => {
  const { base, headers } = await serve(t);
  const body = { data: { event_type: "call.recording.saved", payload: {
    call_control_id: call.telnyxCallId, recording_id: "recording-test",
  } } };
  for (const legacy of [false, true]) {
    data.clear();
    awaitingRecording();
    const before = transcriptionRequests.length;
    const deliver = async (event: unknown) => {
      if (!legacy) {
        const res = await originalFetch(`${base}/api/telnyx-webhook?token=test-only-webhook`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(event),
        });
        assert.equal(res.status, 200);
      } else {
        let status = 0;
        await legacyWebhook({ method: "POST", query: { token: "test-only-webhook" }, body: event }, {
          status(code: number) { status = code; return this; }, json() {},
        });
        assert.equal(status, 200);
      }
    };
    await deliver(body);
    assert.equal(table("tasks").size, 1);
    assert.equal(table("agencyCalls").get(call.id)!.aiScore, 72);
    await deliver(body);
    await deliver({ data: { event_type: "call.recording.transcription.saved", payload: {
      call_control_id: call.telnyxCallId, transcript: "Incorrect old transcript",
    } } });
    assert.equal(table("agencyCalls").get(call.id)!.transcript, call.transcript);
    assert.equal(table("agencyCalls").get(call.id)!.transcriptionStatus, "READY");
    await originalFetch(`${base}/api/calls/${call.id}/analyze`, { method: "POST", headers });
    assert.equal(transcriptionRequests.length, before + 1, "Analyse must not transcribe again");
  }
});
