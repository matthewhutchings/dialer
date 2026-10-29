import { createHash, randomUUID } from "node:crypto";
import { callResultMachine } from "@dialer/shared";
import { enumTaskStatusEnum } from "@dialer/shared/api";
import { createTwenty, listTwenty, updateTwenty } from "../twenty/client/index.js";
import { bridgeConfig } from "../audioBridge/telnyx.js";
import { readInboundSettings } from "../audioBridge/inboundSettings.js";
import { telnyxClient } from "../telnyx/index.js";
import { createLogger } from "../logger/index.js";
import { callView, getVoiceCall, handleVoiceEvent, providerSaysEnded, startVoiceAssistant, type PrivateState, type VoiceCall } from "./index.js";
import { decryptState, encryptState, UUID, VoiceError, configurationError } from "./config.js";
import { preloadCalendar } from "./booking.js";
import { businessHours } from "./businessHours.js";
import { withVoiceLock } from "./locks.js";

const log = createLogger("inbound-ai");
const E164 = /^\+[1-9]\d{6,14}$/;
const encode = (value: Record<string, unknown>) => Buffer.from(JSON.stringify(value)).toString("base64");

export function inboundAiEnabled(): boolean {
  return process.env.AI_VOICE_INBOUND_ENABLED === "true";
}

function inboundRequestId(ccid: string): string {
  const hash = createHash("sha256").update(`inbound-ai:${ccid}`).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

async function saveState(call: VoiceCall, state: PrivateState): Promise<void> {
  await updateTwenty("agencyCalls", call.id, { aiVoicePrivateState: encryptState(state) });
}

async function hangupTransfer(legId: string, commandId: string): Promise<void> {
  try {
    await telnyxClient().calls.actions.hangup(legId, { command_id: commandId });
  } catch (error) {
    if (!providerSaysEnded(error)) throw error;
    log.info("Transfer leg already ended.");
  }
}

async function returnToAssistant(call: VoiceCall, state: PrivateState, uncertain = false): Promise<void> {
  if (!callView(call).active || !state.transfer || (state.transfer.status === "returned" && state.transfer.returnedAt)) return;
  state.transfer.status = uncertain ? "uncertain" : "returned";
  await saveState(call, state);
  if (!call.telnyxCallId) throw new VoiceError(409, "The inbound call has no provider call ID.");
  await telnyxClient().calls.actions.stopPlayback(call.telnyxCallId, {
    stop: "all", command_id: `ai-transfer-hold-stop-${state.transfer.id}`,
  });
  await startVoiceAssistant({ ...call, aiVoicePrivateState: encryptState(state) },
    "Matthew isn't available to continue right now. I can take a message for him or help you book a meeting. What would you prefer?",
    `ai-transfer-return-${state.transfer.id}`);
  state.transfer.returnedAt = new Date().toISOString();
  await saveState(call, state);
}

async function handleTransferEvent(event: string, payload: Record<string, unknown>, decoded: Record<string, unknown>): Promise<boolean> {
  if (typeof decoded.callId !== "string" || !UUID.test(decoded.callId) || typeof decoded.transferId !== "string" || !UUID.test(decoded.transferId)) {
    throw new VoiceError(400, "Invalid AI transfer event state.");
  }
  const callId = decoded.callId;
  if (!["call.answered", "call.gather.ended", "call.hangup"].includes(event)) return true;
  return withVoiceLock(`tool:${callId}`, async () => {
    const call = await getVoiceCall(callId);
    const state = decryptState<PrivateState>(call.aiVoicePrivateState);
    const transfer = state.transfer;
    const legId = typeof payload.call_control_id === "string" ? payload.call_control_id : "";
    if (legId && transfer && transfer.id !== decoded.transferId) {
      if (event !== "call.hangup") await hangupTransfer(legId, `ai-transfer-stale-${decoded.transferId}`);
      return true;
    }
    if (!legId || !transfer || (transfer.legId && transfer.legId !== legId)) {
      throw new VoiceError(409, "AI transfer leg does not match the saved attempt.");
    }
    if (!callView(call).active) {
      if (event !== "call.hangup") await hangupTransfer(legId, `ai-transfer-orphan-${transfer.id}`);
      return true;
    }
    transfer.legId = legId;
    if (transfer.status === "returned" || transfer.status === "uncertain") {
      if (event !== "call.hangup") await hangupTransfer(legId, `ai-transfer-late-${transfer.id}`);
      if (event === "call.hangup" && transfer.returnedAt) {
        transfer.status = "returned";
        await saveState(call, state);
      } else if (event === "call.hangup" || !transfer.returnedAt) await returnToAssistant(call, state);
      return true;
    }
    if (event === "call.answered") {
      if (!["dialing", "screening"].includes(transfer.status)) return true;
      transfer.status = "screening";
      await saveState(call, state);
      await telnyxClient().calls.actions.gatherUsingSpeak(legId, {
        voice: process.env.TELNYX_AI_VOICE || "Telnyx.KokoroTTS.af_heart",
        payload: "Matthew, a caller to Fewzen would like to speak with you. Press 1 to accept. Otherwise the AI will take a message.",
        minimum_digits: 1, maximum_digits: 1, valid_digits: "0123456789",
        timeout_millis: 10_000, command_id: `ai-transfer-screen-${transfer.id}`,
        client_state: encode(decoded),
      });
    } else if (event === "call.gather.ended") {
      if (transfer.status === "connected") return true;
      if (transfer.status !== "screening") throw new VoiceError(409, "The transfer is not waiting for acceptance.");
      let hours;
      try { hours = await businessHours(); }
      catch (error) {
        log.error("Cannot verify business hours at transfer acceptance", error instanceof Error ? error.message : "unknown failure");
        await updateTwenty("agencyCalls", call.id, { aiVoiceError: "Live transfer was declined because business hours could not be verified." });
        await hangupTransfer(legId, `ai-transfer-hours-failed-${transfer.id}`);
        await returnToAssistant(call, state);
        return true;
      }
      if (payload.digits === "1" && hours.open) {
        if (!call.telnyxCallId) throw new VoiceError(409, "The incoming caller leg is missing.");
        await telnyxClient().calls.actions.stopPlayback(call.telnyxCallId, { stop: "all", command_id: `ai-transfer-hold-stop-${transfer.id}` });
        await telnyxClient().calls.actions.bridge(call.telnyxCallId, {
          call_control_id_to_bridge_with: legId, park_after_unbridge: "self",
          command_id: `ai-transfer-bridge-${transfer.id}`,
        });
        transfer.status = "connected";
        await saveState(call, state);
      } else {
        await hangupTransfer(legId, `ai-transfer-decline-${transfer.id}`);
        await returnToAssistant(call, state);
      }
    } else {
      await returnToAssistant(call, state);
    }
    return true;
  });
}

export async function handleInboundVoiceEvent(event: string, payload: Record<string, unknown>): Promise<boolean> {
  let decoded: Record<string, unknown> | undefined;
  if (typeof payload.client_state === "string" && payload.client_state) {
    let value: unknown;
    try { value = JSON.parse(Buffer.from(payload.client_state, "base64").toString("utf8")); }
    catch { return false; }
    if (value && typeof value === "object" && !Array.isArray(value)) decoded = value as Record<string, unknown>;
  }
  // Saved transfer legs must finish even after an operator disables new reception.
  if (decoded?.kind === "ai_inbound_transfer") return handleTransferEvent(event, payload, decoded);
  if (decoded?.kind === "ai_voice" && event === "call.hangup" && typeof decoded.callId === "string") {
    const call = await getVoiceCall(decoded.callId);
    if (call.direction === "INBOUND") {
      const state = decryptState<PrivateState>(call.aiVoicePrivateState);
      await handleVoiceEvent(event, payload);
      if (state.transfer?.legId && state.transfer.status !== "returned") {
        await hangupTransfer(state.transfer.legId, `ai-transfer-caller-ended-${state.transfer.id}`);
      }
      return true;
    }
    return false;
  }
  const config = bridgeConfig();
  if (!inboundAiEnabled() || event !== "call.initiated" || payload.direction !== "incoming" ||
      decoded || typeof payload.to !== "string" || payload.to !== config.inboundNumber) return false;
  const ccid = typeof payload.call_control_id === "string" ? payload.call_control_id : "";
  if (!ccid) throw new VoiceError(400, "Incoming AI call is missing a provider call ID.");
  const problem = configurationError(false);
  if (problem || !process.env.TELNYX_INBOUND_AI_ASSISTANT_ID) throw new VoiceError(503, problem || "Configure the inbound AI assistant.");
  const requestId = inboundRequestId(ccid);
  return withVoiceLock(`incoming:${requestId}`, async () => {
    const [existing] = await listTwenty<VoiceCall>("agencyCalls", { limit: 1, filter: `aiVoiceRequestId[eq]:"${requestId}"` });
    let call = existing;
    if (!call) {
      const state: PrivateState = { company: "Fewzen", script: "" };
      let preparationError = "";
      try {
        state.calendar = await preloadCalendar();
        state.slots = state.calendar.slots;
      } catch (error) {
        preparationError = "Incoming call answered without calendar preload. Booking requires a fresh calendar check.";
        log.error(preparationError, error instanceof Error ? error.message : "unknown calendar failure");
      }
      call = await createTwenty<VoiceCall>("agencyCalls", {
        name: "AI INBOUND Fewzen", direction: "INBOUND", status: callResultMachine.initial,
        startedAt: new Date().toISOString(), fromNumber: typeof payload.from === "string" ? payload.from : "",
        toNumber: config.inboundNumber, telnyxCallId: ccid, aiVoiceState: "STARTING",
        aiVoiceRequestId: requestId, aiVoicePermission: "inbound_requested",
        aiVoiceConsentEvidence: "Caller initiated an inbound call to Fewzen; no outbound marketing permission inferred.",
        aiVoicePrivateState: encryptState(state), aiVoiceError: preparationError,
      });
    }
    if (callView(call).active && !call.aiVoiceAnsweredAt) {
      await telnyxClient().calls.actions.answer(ccid, {
        command_id: `ai-inbound-answer-${call.id}`, client_state: encode({ kind: "ai_voice", callId: call.id }),
      });
    }
    return true;
  });
}

export async function runInboundTool(callId: string, tool: string, input: Record<string, unknown>): Promise<unknown> {
  return withVoiceLock(`tool:${callId}`, async () => {
    const call = await getVoiceCall(callId);
    if (call.direction !== "INBOUND" || call.aiVoiceState !== "ACTIVE") throw new VoiceError(409, "This inbound AI conversation is not active.");
    const state = decryptState<PrivateState>(call.aiVoicePrivateState);
    if (tool === "transfer_status") return businessHours();
    if (tool === "leave_message") {
      const text = (key: string, max: number, required = true): string => {
        const value = input[key];
        if (value === undefined && !required) return "";
        if (typeof value !== "string" || (required && !value.trim()) || value.length > max) throw new VoiceError(400, `Confirm a valid ${key} before saving the message.`);
        return value.trim();
      };
      if (input.confirmed !== true) throw new VoiceError(400, "The caller must agree to save their message.");
      const message = { name: text("name", 100), company: text("company", 200, false), contact: text("contact", 254), message: text("message", 2000) };
      if (state.message && JSON.stringify(state.message) !== JSON.stringify(message)) throw new VoiceError(409, "A different message has already been saved. Do not overwrite it or claim this replacement was saved.");
      state.message = message;
      const notes = `Inbound message for Matthew\nFrom: ${message.name}${message.company ? `, ${message.company}` : ""}\nReturn contact: ${message.contact}\n\n${message.message}`;
      await updateTwenty("agencyCalls", call.id, { notes, aiVoicePrivateState: encryptState(state) });
      const taskId = inboundRequestId(`message-task:${call.id}`);
      const [existingTask] = await listTwenty<{ id: string }>("tasks", { limit: 1, filter: `id[eq]:"${taskId}"` });
      if (!existingTask) await createTwenty("tasks", {
        id: taskId, title: "Reply to Fewzen inbound message", status: enumTaskStatusEnum.TODO, bodyV2: { markdown: notes },
      });
      const targetId = inboundRequestId(`message-target:${call.id}`);
      const [existingTarget] = await listTwenty<{ id: string }>("taskTargets", { limit: 1, filter: `id[eq]:"${targetId}"` });
      if (!existingTarget) await createTwenty("taskTargets", { id: targetId, taskId, targetAgencyCallId: call.id });
      const [savedTask, savedTarget] = await Promise.all([
        listTwenty<{ id: string }>("tasks", { limit: 1, filter: `id[eq]:"${taskId}"` }),
        listTwenty<{ id: string; taskId?: string; targetAgencyCallId?: string }>("taskTargets", { limit: 1, filter: `id[eq]:"${targetId}"` }),
      ]);
      if (!savedTask[0] || savedTarget[0]?.taskId !== taskId || savedTarget[0]?.targetAgencyCallId !== call.id) {
        throw new VoiceError(502, "The message is on the call but its follow-up task could not be verified. Do not claim full success; retry the same message.");
      }
      return { messageSaved: true, followUpCreated: true };
    }
    if (tool !== "connect_matthew") throw new VoiceError(404, "Unknown inbound AI tool.");
    if (input.confirmed !== true) throw new VoiceError(400, "The caller must agree before trying a live connection.");
    const hours = await businessHours();
    if (!hours.open) return { connecting: false, ...hours };
    if (state.transfer?.status === "uncertain") throw new VoiceError(409, "The previous transfer is uncertain. Offer a message or booking; do not dial again until Telnyx confirms the leg ended.");
    if (state.transfer?.status === "returned" && !state.transfer.returnedAt) throw new VoiceError(409, "The assistant is still recovering from the previous transfer. Do not start another transfer.");
    if (state.transfer && state.transfer.status !== "returned") return { connecting: true, status: state.transfer.status };
    const config = bridgeConfig();
    const settings = await readInboundSettings(config.inboundNumber, config);
    if (!E164.test(settings.fallbackPhone) || settings.fallbackPhone === config.inboundNumber) throw new VoiceError(503, "Configure a separate private fallback mobile for Matthew.");
    if (!/^https:\/\//.test(settings.holdAudioUrl)) throw new VoiceError(503, "Configure HTTPS hold audio before live transfer.");
    if (!call.telnyxCallId) throw new VoiceError(409, "The incoming caller leg is missing.");
    state.transfer = { id: randomUUID(), status: "dialing" };
    await saveState(call, state);
    try {
      await telnyxClient().calls.actions.stopAIAssistant(call.telnyxCallId, { command_id: `ai-transfer-stop-${state.transfer.id}` });
      await telnyxClient().calls.actions.startPlayback(call.telnyxCallId, {
        audio_url: settings.holdAudioUrl, audio_type: "mp3", loop: "infinity", target_legs: "self",
        command_id: `ai-transfer-hold-${state.transfer.id}`,
      });
      const response = await telnyxClient().calls.dial({
        connection_id: config.appId, from: config.inboundNumber, to: settings.fallbackPhone,
        timeout_secs: 20, time_limit_secs: 600, command_id: state.transfer.id,
        client_state: encode({ kind: "ai_inbound_transfer", callId: call.id, transferId: state.transfer.id }),
      });
      if (!response.data?.call_control_id) throw new VoiceError(502, "Transfer initiation is uncertain. Check Telnyx before trying again.");
      state.transfer.legId = response.data.call_control_id;
      await saveState(call, state);
      return { connecting: true, screened: true };
    } catch (error) {
      await updateTwenty("agencyCalls", call.id, { aiVoiceError: "The live transfer failed or is uncertain. Check Telnyx; the caller can leave a message or book." });
      log.error("Live transfer failed", error instanceof Error ? error.message : "unknown transfer failure");
      // Do not dial a replacement leg; late provider events still carry this attempt ID.
      await returnToAssistant(call, state, true);
      throw error;
    }
  });
}
