import type { AiCallInput, AiCallView } from "@dialer/shared";
import { callResultMachine } from "@dialer/shared";
import { APIError } from "telnyx";
import { getTwenty, createTwenty, listTwenty, listTwentyAll, updateTwenty } from "../twenty/client/index.js";
import type { WriteActor } from "../twenty/actor/index.js";
import { telnyxClient } from "../telnyx/index.js";
import type { AgencyCall } from "../../routes/calls/types.js";
import type { AgencyLead } from "../../routes/leads/types.js";
import type { AgencyProspect } from "../../routes/prospects/types.js";
import type { AgencyPhone } from "../../routes/twenty/phones/types.js";
import { isClaimStale } from "../../routes/twenty/phones/helpers/index.js";
import { acquireLock, findLock, releaseOwnedLock, withVoiceLock } from "./locks.js";
import { availableSlots, bookMeeting, meetingDetails, type BookingInput, type BookingState } from "./booking.js";
import { callToken, configurationError, decryptState, encryptState, UUID, VoiceError, voiceConfig } from "./config.js";
import { forgetLastCalls } from "../twenty/lastCall/index.js";
import { createLogger } from "../logger/index.js";
import { analyzeCallTranscript, isAiConfigured } from "../ai/analysis/index.js";
import { createFollowUpTasks } from "../ai/analysis/followUpTasks.js";
import { splitStatus } from "../../routes/calls/helpers/index.js";
import { contactNumber, loadVoiceContext, voiceGreeting, type VoiceBriefing } from "./context.js";
import { ASSISTANT_INSTRUCTIONS } from "./assistant.js";

const log = createLogger("ai-voice");
const GLOBAL_LOCK = "ai-voice";
const ACTIVE_STATES = new Set(["STARTING", "DIALING", "ACTIVE", "UNKNOWN"]);

interface PrivateState extends BookingState {
  company: string;
  script: string;
  briefing?: VoiceBriefing;
}

export interface VoiceCall extends AgencyCall {
  aiVoiceState: string;
  aiVoiceRequestId: string;
  aiVoicePermission: string;
  aiVoiceConsentEvidence: string;
  aiVoicePrivateState: string;
  aiVoiceError?: string;
  aiVoiceAnsweredAt?: string;
}

export function callView(call: VoiceCall): AiCallView {
  return {
    id: call.id,
    contactId: call.agencyProspectId || call.agencyLeadId || "",
    contactType: call.agencyProspectId ? "prospect" : "lead",
    state: call.aiVoiceState,
    active: ACTIVE_STATES.has(call.aiVoiceState),
    error: call.aiVoiceError || null,
    meetingAt: call.meetingAt || null,
    meetingUrl: call.meetingUrl || null,
  };
}

async function findRequest(requestId: string): Promise<VoiceCall | null> {
  if (!UUID.test(requestId)) throw new VoiceError(400, "A valid request ID is required.");
  const rows = await listTwenty<VoiceCall>("agencyCalls", { limit: 1, filter: `aiVoiceRequestId[eq]:"${requestId}"` });
  return rows[0] ?? null;
}

export async function activeVoiceCall(): Promise<AiCallView | null> {
  const lock = await findLock(GLOBAL_LOCK);
  if (!lock) return null;
  const call = await findRequest(lock.owner);
  if (!call) throw new VoiceError(409, "An AI call is starting or requires operator recovery. Check Telnyx before releasing its reservation.");
  const view = callView(await reconcileVoiceCall(call));
  return view.active ? view : null;
}

export async function getVoiceCall(id: string): Promise<VoiceCall> {
  if (!UUID.test(id)) throw new VoiceError(400, "A valid call ID is required.");
  const call = await getTwenty<VoiceCall>("agencyCalls", id);
  if (!call.aiVoiceRequestId) throw new VoiceError(404, "This is not an AI call.");
  return call;
}

function selectValue(value: unknown): string {
  if (typeof value === "string") return value.toUpperCase();
  if (value && typeof value === "object" && "value" in value) return selectValue(value.value);
  return "";
}

export function ensureCallable(contact: { coldCallStatus?: unknown; status?: unknown; outboundState?: unknown; outboundLabel?: unknown }): void {
  if ([contact.coldCallStatus, contact.status, contact.outboundState, contact.outboundLabel]
    .some((value) => ["DO_NOT_CONTACT", "OPTED_OUT", "DNC", "DO_NOT_CALL"].includes(selectValue(value)))) {
    throw new VoiceError(409, "This contact has opted out. AI calling is blocked.");
  }
}

async function callableContact(input: AiCallInput): Promise<AgencyProspect | AgencyLead> {
  const prospect = input.contactType === "prospect";
  const contact = prospect
    ? await getTwenty<AgencyProspect>("agencyProspects", input.contactId)
    : await getTwenty<AgencyLead>("agencyLeads", input.contactId);
  ensureCallable(contact);
  return contact;
}

export function validateCallInput(input: AiCallInput): void {
  if (!input || !UUID.test(input.requestId) || !UUID.test(input.contactId) ||
      !["prospect", "lead"].includes(input.contactType) ||
      !["internal_test", "consented"].includes(input.permission) ||
      typeof input.consentEvidence !== "string" || input.consentEvidence.trim().length < 10 ||
      input.consentEvidence.length > 1000) {
    throw new VoiceError(400, "Choose a company, calling permission and a 10-1000 character permission record.");
  }
}

async function releaseCallLocks(call: VoiceCall): Promise<void> {
  if (call.agencyPhoneId) await releaseOwnedLock(`phone:${call.agencyPhoneId}`, call.aiVoiceRequestId);
  await releaseOwnedLock(GLOBAL_LOCK, call.aiVoiceRequestId);
}

export async function startVoiceCall(input: AiCallInput, memberId: string, actor: WriteActor | null): Promise<AiCallView> {
  validateCallInput(input);
  const problem = configurationError();
  if (problem) throw new VoiceError(503, problem);
  const existing = await findRequest(input.requestId);
  if (existing) {
    const view = callView(existing);
    if (view.contactId !== input.contactId || view.contactType !== input.contactType) {
      throw new VoiceError(409, "This request ID belongs to another contact.");
    }
    return view;
  }
  const number = contactNumber(await callableContact(input));
  const config = voiceConfig();
  if (input.permission === "internal_test" && !config.testNumbers.includes(number)) {
    throw new VoiceError(403, "This number is not on the server's AI_VOICE_TEST_NUMBERS allowlist.");
  }
  const phones = await listTwentyAll<AgencyPhone>("agencyPhones");
  const phone = phones.find((p) => p.phoneNumber === config.caller);
  if (!phone || phone.state !== "ACTIVE") throw new VoiceError(409, "Configure an active agency caller number before AI calling.");
  await acquireLock(GLOBAL_LOCK, input.requestId);
  let call: VoiceCall | null = null;
  let dialAttempted = false;
  try {
    await acquireLock(`phone:${phone.id}`, input.requestId);
    const freshPhone = await getTwenty<AgencyPhone>("agencyPhones", phone.id);
    if (freshPhone.claimedByMemberId && !isClaimStale(freshPhone)) {
      throw new VoiceError(409, "The agency number is currently held by a human dialer.");
    }
    const contact = await callableContact(input);
    if (contactNumber(contact) !== number) throw new VoiceError(409, "The contact's phone number changed. Review the record and authorise a new call.");
    const context = await loadVoiceContext(input, contact);
    call = await createTwenty<VoiceCall>("agencyCalls", {
      name: `AI OUTBOUND ${context.company}`,
      direction: "OUTBOUND",
      status: callResultMachine.initial,
      startedAt: new Date().toISOString(),
      fromNumber: config.caller,
      toNumber: context.number,
      agencyPhoneId: phone.id,
      ...(input.contactType === "prospect" ? { agencyProspectId: input.contactId } : { agencyLeadId: input.contactId }),
      createdByMemberId: memberId,
      aiVoiceState: "STARTING",
      aiVoiceRequestId: input.requestId,
      aiVoicePermission: input.permission,
      aiVoiceConsentEvidence: `${new Date().toISOString()} | ${memberId} | ${input.consentEvidence.trim()}`,
      aiVoicePrivateState: encryptState({ company: context.company, script: context.script, briefing: context.briefing }),
    }, actor);
    // Both the client state and command ID survive retries and early provider webhooks.
    const clientState = Buffer.from(JSON.stringify({ kind: "ai_voice", callId: call.id })).toString("base64");
    dialAttempted = true;
    const response = await telnyxClient().calls.dial({
      connection_id: config.appId,
      from: config.caller,
      to: number,
      command_id: input.requestId,
      client_state: clientState,
      timeout_secs: 30,
      time_limit_secs: 600,
    });
    const ccid = response.data?.call_control_id;
    if (!ccid) throw new VoiceError(502, "Telnyx did not return a call ID; the call outcome is uncertain.");
    // A fast answer/hangup webhook may already have advanced the row.
    const current = await getVoiceCall(call.id);
    const updated = await updateTwenty<VoiceCall>("agencyCalls", call.id, {
      telnyxCallId: ccid,
      ...(current.aiVoiceState === "STARTING" ? { aiVoiceState: "DIALING" } : {}),
    });
    forgetLastCalls();
    return callView(updated);
  } catch (error) {
    if (dialAttempted && call) {
      const current = await getVoiceCall(call.id);
      if (current.aiVoiceState === "STARTING") {
        await updateTwenty("agencyCalls", call.id, {
          aiVoiceState: "UNKNOWN",
          aiVoiceError: "Call initiation was not confirmed. Wait for Telnyx events or verify the provider before retrying.",
        });
      }
    } else {
      if (call) await updateTwenty("agencyCalls", call.id, { aiVoiceState: "FAILED", status: callResultMachine.state("FAILED"), aiVoiceError: "Call could not be started." });
      await releaseOwnedLock(`phone:${phone.id}`, input.requestId);
      await releaseOwnedLock(GLOBAL_LOCK, input.requestId);
    }
    throw error;
  }
}

async function finishVoiceCall(
  call: VoiceCall, ccid: string, endTime?: string, cause = "", duration?: number,
): Promise<VoiceCall> {
  const current = await getVoiceCall(call.id);
  if (current.aiVoiceState === "ENDED") {
    await releaseCallLocks(current);
    return current;
  }
  const endedAt = endTime && Number.isFinite(Date.parse(endTime)) ? endTime : null;
  const status = current.aiVoiceAnsweredAt ? "COMPLETED" : cause === "user_busy" ? "BUSY" : cause === "no_answer" || cause === "timeout" ? "NO_ANSWER" : "FAILED";
  const durationSeconds = typeof duration === "number" && Number.isFinite(duration) && duration >= 0
    ? Math.round(duration)
    : endedAt && current.aiVoiceAnsweredAt ? Math.max(0, Math.round((Date.parse(endedAt) - Date.parse(current.aiVoiceAnsweredAt)) / 1000)) : undefined;
  const updated = await updateTwenty<VoiceCall>("agencyCalls", call.id, {
    telnyxCallId: ccid, status, aiVoiceState: "ENDED",
    ...(endedAt ? { endedAt } : {}),
    ...(durationSeconds !== undefined ? { durationSeconds } : {}),
    aiVoiceError: endedAt ? "" : "Telnyx confirms this call ended, but its exact end time is unavailable.",
  });
  await releaseCallLocks(current);
  forgetLastCalls();
  return updated;
}

export async function reconcileVoiceCall(call: VoiceCall): Promise<VoiceCall> {
  if (!callView(call).active) {
    if (call.aiVoiceState === "ENDED") await releaseCallLocks(call);
    return call;
  }
  if (!call.telnyxCallId) return call;
  const status = (await telnyxClient().calls.retrieveStatus(call.telnyxCallId)).data;
  if (!status || status.call_control_id !== call.telnyxCallId || typeof status.is_alive !== "boolean") {
    throw new VoiceError(502, "Telnyx did not return a valid status for this call. Its reservation is retained.");
  }
  // An asynchronous dial can report is_alive=false; require positive end evidence.
  if (status.is_alive === false && status.end_time && Number.isFinite(Date.parse(status.end_time))) {
    log.info(`Reconciling ended Telnyx call ${call.id}`);
    return finishVoiceCall(call, call.telnyxCallId, status.end_time, "", status.call_duration);
  }
  return call;
}

function providerSaysEnded(error: unknown): boolean {
  if (!(error instanceof APIError) || error.status !== 422) return false;
  const body: unknown = error.error;
  return !!body && typeof body === "object" && "errors" in body && Array.isArray(body.errors) &&
    body.errors.some((item: unknown) => !!item && typeof item === "object" && "code" in item && item.code === "90018");
}

export async function stopVoiceCall(call: VoiceCall): Promise<VoiceCall> {
  if (!callView(call).active) return reconcileVoiceCall(call);
  if (!call.telnyxCallId) throw new VoiceError(409, "Telnyx has not supplied a call ID yet. Wait for the webhook; do not start another call.");
  try {
    await telnyxClient().calls.actions.hangup(call.telnyxCallId, { command_id: `ai-stop-${call.id}` });
  } catch (error) {
    if (!providerSaysEnded(error)) throw error;
    log.info(`Telnyx rejected stop because call ${call.id} already ended`);
    try {
      return await reconcileVoiceCall(call);
    } catch (statusError) {
      if (!(statusError instanceof APIError) || statusError.status !== 404) throw statusError;
      log.warn(`Ended call ${call.id} is outside Telnyx status retention; exact end time unavailable`);
      return finishVoiceCall(call, call.telnyxCallId);
    }
  }
  return reconcileVoiceCall(await getVoiceCall(call.id));
}

export async function runVoiceTool(callId: string, tool: string, input: Record<string, unknown>): Promise<unknown> {
  return withVoiceLock(`tool:${callId}`, async () => {
    const call = await getVoiceCall(callId);
    if (!callView(call).active || call.aiVoiceState !== "ACTIVE") throw new VoiceError(409, "This AI conversation is not active.");
    const state = decryptState<PrivateState>(call.aiVoicePrivateState);
    const persist = async () => {
      await updateTwenty("agencyCalls", call.id, { aiVoicePrivateState: encryptState(state) });
    };
    if (tool === "meeting_details") return meetingDetails();
    if (tool === "availability") {
      if (typeof input.start !== "string" || typeof input.end !== "string") throw new VoiceError(400, "Provide start and end timestamps.");
      const slots = await availableSlots(input.start, input.end);
      state.slots = slots;
      await persist();
      return { slots };
    }
    if (tool === "book") {
      if (input.confirmed !== true) throw new VoiceError(400, "The prospect must explicitly confirm the meeting and attendee details.");
      const bookingInput: BookingInput = {
        start: typeof input.start === "string" ? input.start : "",
        name: typeof input.name === "string" ? input.name : "",
        email: typeof input.email === "string" ? input.email : "",
        timezone: typeof input.timezone === "string" ? input.timezone : "",
        ...(typeof input.notes === "string" ? { notes: input.notes } : {}),
      };
      const booking = await bookMeeting(state, bookingInput, persist);
      await updateTwenty("agencyCalls", call.id, {
        meetingAt: booking.start,
        meetingBookingId: booking.id,
        meetingProvider: "GOOGLE_MEET",
        meetingStatus: "SCHEDULED",
        meetingUrl: booking.meetLink || "",
        disposition: splitStatus("APPOINTMENT_SET").disposition,
      });
      return { confirmed: true, start: booking.start, end: booking.end, timezone: bookingInput.timezone, meetLink: booking.meetLink };
    }
    if (tool === "opt_out") {
      const object = call.agencyProspectId ? "agencyProspects" : "agencyLeads";
      const id = call.agencyProspectId || call.agencyLeadId;
      if (!id) throw new VoiceError(409, "The call has no linked contact.");
      await updateTwenty(object, id, call.agencyProspectId
        ? { coldCallStatus: "DO_NOT_CONTACT", outboundState: "OPTED_OUT", outboundLabel: "DO_NOT_CONTACT" }
        : { status: "DO_NOT_CONTACT", coldCallStatus: "DO_NOT_CONTACT" });
      await updateTwenty("agencyCalls", call.id, { disposition: splitStatus("DNC").disposition });
      await stopVoiceCall(call);
      return { optedOut: true };
    }
    if (tool === "callback") {
      if (typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 1000) throw new VoiceError(400, "Provide the callback agreed with the prospect.");
      // One call-targeted task is enough; duplicate tool deliveries must not create another.
      await createFollowUpTasks(call, [{
        title: "Call back after AI conversation", description: input.reason, dueAt: null,
      }]);
      const saved = await listTwenty<{ id: string }>("taskTargets", { limit: 1, filter: `targetAgencyCallId[eq]:"${call.id}"` });
      if (!saved.length) throw new VoiceError(502, "The callback task could not be saved. Do not claim it was recorded.");
      await updateTwenty("agencyCalls", call.id, { disposition: splitStatus("CALLBACK").disposition });
      return { callbackRecorded: true };
    }
    if (tool === "end") {
      await stopVoiceCall(call);
      return { ending: true };
    }
    throw new VoiceError(404, "Unknown AI tool.");
  });
}

export async function handleVoiceEvent(event: string, payload: Record<string, unknown>): Promise<boolean> {
  let state: unknown;
  try {
    state = JSON.parse(Buffer.from(typeof payload.client_state === "string" ? payload.client_state : "", "base64").toString("utf8"));
  } catch {
    return false;
  }
  if (!state || typeof state !== "object" || !("kind" in state) || state.kind !== "ai_voice" ||
      !("callId" in state) || typeof state.callId !== "string" || !UUID.test(state.callId)) return false;
  // Existing recording handlers remain the owner of recording/transcription events.
  if (event.startsWith("call.recording.")) return false;
  const callId = state.callId;
  const transcriptEvent = event === "call.ai_gather.message_history_updated" || event === "call.conversation.ended";
  if (!["call.hangup", "call.initiated", "call.answered"].includes(event) && !transcriptEvent) return true;
  const handle = async () => {
    const call = await getVoiceCall(callId);
    const ccid = typeof payload.call_control_id === "string" ? payload.call_control_id : "";
    if (!ccid || (call.telnyxCallId && call.telnyxCallId !== ccid)) throw new VoiceError(409, "AI event call ID does not match.");
    if (event === "call.hangup") {
      const cause = typeof payload.hangup_cause === "string" ? payload.hangup_cause : "";
      const endedAt = typeof payload.end_time === "string" && Number.isFinite(Date.parse(payload.end_time)) ? payload.end_time : new Date().toISOString();
      await finishVoiceCall(call, ccid, endedAt, cause);
      return true;
    }
    if (event === "call.ai_gather.message_history_updated" || event === "call.conversation.ended") {
      const messages = event === "call.conversation.ended" ? payload.messages : payload.message_history;
      if (!Array.isArray(messages)) throw new VoiceError(400, "AI transcript event is missing message history.");
      const transcript = messages.flatMap((message: unknown) => {
        if (!message || typeof message !== "object" || !("role" in message) || !("content" in message) ||
            !["user", "assistant"].includes(String(message.role)) || typeof message.content !== "string") return [];
        return [`${message.role}: ${message.content}`];
      }).join("\n").slice(0, 60_000);
      if (transcript) await updateTwenty("agencyCalls", call.id, { transcript, transcriptionStatus: "READY" });
      if (event === "call.conversation.ended" && transcript.length >= 10 && isAiConfigured()) {
        const analysis = await analyzeCallTranscript(transcript, { direction: "OUTBOUND", durationSeconds: call.durationSeconds });
        await updateTwenty("agencyCalls", call.id, {
          summary: analysis.summary, aiSummary: analysis.summary, aiSentiment: analysis.sentiment,
          aiScore: analysis.score, aiKeyPoints: JSON.stringify(analysis.keyPoints),
          aiScores: JSON.stringify(analysis.scores), aiConfidence: analysis.confidence,
          aiModel: analysis.model, aiAnalyzedAt: new Date().toISOString(),
        });
      }
      return true;
    }
    if (!callView(call).active) return true;
    if (event === "call.initiated") {
      await updateTwenty("agencyCalls", call.id, { telnyxCallId: ccid });
    } else if (event === "call.answered") {
      const privateState = decryptState<PrivateState>(call.aiVoicePrivateState);
      const answeredAt = call.aiVoiceAnsweredAt || new Date().toISOString();
      await updateTwenty("agencyCalls", call.id, { telnyxCallId: ccid, aiVoiceState: "ACTIVE", aiVoiceAnsweredAt: answeredAt, aiVoiceError: "" });
      try {
        await telnyxClient().calls.actions.startAIAssistant(ccid, {
          assistant: {
            id: voiceConfig().assistantId,
            instructions: ASSISTANT_INSTRUCTIONS,
            dynamic_variables: {
              call_id: call.id, tool_token: callToken(call.id),
              company_name: privateState.company, campaign_script: privateState.script,
              crm_context: JSON.stringify(privateState.briefing || { company: { name: privateState.company } }),
              current_time: new Date().toISOString(),
            },
          },
          greeting: voiceGreeting(privateState.briefing),
          command_id: `ai-start-${call.id}`,
          send_message_history_updates: true,
        });
      } catch (error) {
        log.error("AI assistant start failed; ending the call", error instanceof Error ? error.message : "provider error");
        await updateTwenty("agencyCalls", call.id, { aiVoiceError: "The voice assistant could not start. Ending the call." });
        await telnyxClient().calls.actions.hangup(ccid, { command_id: `ai-start-failed-${call.id}` });
        throw error;
      }
    }
    return true;
  };
  // Terminal writes are idempotent and must not wait behind a stalled transcript/AI operation.
  if (event === "call.hangup") return handle();
  return withVoiceLock(`${transcriptEvent ? "transcript" : "event"}:${callId}`, handle);
}
