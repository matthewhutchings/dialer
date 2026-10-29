import { timingSafeEqual } from "node:crypto";
import type { AiAgentSettings, AiAutomationRun, AiAutomationView, AiCallInput, AiQueueEntry } from "@dialer/shared";
import { createTwenty, getTwenty, listTwenty, updateTwenty } from "../twenty/client/index.js";
import type { WriteActor } from "../twenty/actor/index.js";
import type { AgencyPhone } from "../../routes/twenty/phones/types.js";
import { isClaimStale } from "../../routes/twenty/phones/helpers/index.js";
import { createLogger } from "../logger/index.js";
import { callView, callableContact, findRequest, reconcileVoiceCall, startVoiceCall, validateCallInput, type PrivateState, type VoiceCall } from "./index.js";
import { contactNumber } from "./context.js";
import { decryptState, UUID, VoiceError, voiceConfig } from "./config.js";
import { acquireLock, findLock, releaseLock, withVoiceLock } from "./locks.js";
import { automationSchemaReady, readAgentSettings, saveAutomationRun, settingsPhone } from "./settings.js";
import { businessHours } from "./businessHours.js";

const log = createLogger("ai-automation");
const QUEUE = "agencyAiQueueEntries";
const WORKER_LOCK = "ai-automation";
const LIVE_STATES = new Set(["QUEUED", "STARTING", "UNCERTAIN"]);

export function validSchedulerToken(token: string): boolean {
  const secret = process.env.AI_AUTOMATION_CRON_SECRET || "";
  const a = Buffer.from(token), b = Buffer.from(secret);
  return secret.length >= 32 && a.length === b.length && timingSafeEqual(a, b);
}

export function londonDay(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)!.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

async function rows<T extends { id: string }>(object: string, filter?: string): Promise<T[]> {
  const result: T[] = [];
  let cursor = "";
  for (let page = 0; page < 500; page++) {
    const condition = cursor ? (filter ? `and(${filter},id[gt]:"${cursor}")` : `id[gt]:"${cursor}"`) : filter;
    const batch = await listTwenty<T>(object, { limit: 200, filter: condition, query: { orderBy: "id[AscNullsFirst]" } });
    result.push(...batch);
    if (batch.length < 200) return result;
    const last = batch.at(-1)!.id;
    if (last === cursor) throw new VoiceError(503, "Twenty pagination did not advance. Automation is blocked to avoid incorrect goals.");
    cursor = last;
  }
  throw new VoiceError(503, "Too many records to safely evaluate AI goals. Automation is blocked.");
}

export function dailyProgress(calls: VoiceCall[], settings: AiAgentSettings, now = new Date(Date.now())) {
  const day = londonDay(now);
  let attempted = 0, bookings = 0;
  for (const call of calls) {
    if (call.direction !== "OUTBOUND" || !call.aiVoiceRequestId) continue;
    if (call.startedAt && londonDay(new Date(call.startedAt)) === day && call.aiVoiceState !== "FAILED") attempted++;
    // Booking completion time lives in encrypted state; never count a future appointment date as today's conversion.
    const state = decryptState<PrivateState>(call.aiVoicePrivateState);
    if (state.attempt?.result && state.bookingConfirmedAt && londonDay(new Date(state.bookingConfirmedAt)) === day) bookings++;
  }
  const target = settings.goalMode === "calls" ? settings.dailyCallGoal : settings.goalMode === "bookings" ? settings.dailyBookingGoal : null;
  return { day, calls: attempted, bookings, target, goalReached: target !== null && (settings.goalMode === "calls" ? attempted : bookings) >= target };
}

async function outboundCalls(): Promise<VoiceCall[]> {
  // London is UTC/UTC+1. Include calls that crossed midnight (maximum call length is ten minutes).
  const since = new Date(Date.parse(`${londonDay(new Date(Date.now()))}T00:00:00Z`) - 2 * 3_600_000).toISOString();
  return rows<VoiceCall>("agencyCalls", `and(direction[eq]:"OUTBOUND",startedAt[gte]:"${since}")`);
}

export async function automationView(): Promise<AiAutomationView> {
  const settings = await readAgentSettings();
  const schemaReady = await automationSchemaReady();
  const [calls, queue, phone, lock, worker] = await Promise.all([
    outboundCalls(), schemaReady ? rows<AiQueueEntry>(QUEUE) : Promise.resolve([]), settingsPhone(), findLock("ai-voice"), findLock(WORKER_LOCK),
  ]);
  const active = lock ? await findRequest(lock.owner) : null;
  return {
    schemaReady, settings, schedulerConfigured: (process.env.AI_AUTOMATION_CRON_SECRET || "").length >= 32,
    schedulerStalled: !!worker?.createdAt && Date.now() - Date.parse(worker.createdAt) >= 15 * 60_000,
    ...dailyProgress(calls, settings), queue: queue.sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    activeCall: active && callView(active).active ? callView(active) : null,
    lastRun: phone.aiAutomationRun ?? null,
  };
}

export async function approveQueue(
  input: AiCallInput, member: { id: string; name: string }, actor: WriteActor | null, retryOf?: string,
): Promise<AiQueueEntry> {
  validateCallInput(input);
  if (!await automationSchemaReady()) throw new VoiceError(409, "Save AI agent controls once to prepare the approval queue.");
  return withVoiceLock(WORKER_LOCK, async () => {
    const queue = await rows<AiQueueEntry>(QUEUE);
    const previous = queue.find((row) => row.id === input.requestId);
    if (previous) {
      if (previous.contactId !== input.contactId || previous.contactType !== input.contactType || previous.permission !== input.permission ||
          previous.consentEvidence !== input.consentEvidence.trim()) throw new VoiceError(409, "This approval request belongs to different contact or permission details.");
      return previous;
    }
    const contact = await callableContact(input);
    const phone = contactNumber(contact);
    if (input.permission === "internal_test" && !voiceConfig().testNumbers.includes(phone)) throw new VoiceError(403, "The approved number is not on the internal test allowlist.");
    const related = queue.filter((row) => row.contactId === input.contactId && row.contactType === input.contactType);
    if (related.some((row) => LIVE_STATES.has(row.state))) throw new VoiceError(409, "This contact already has a queued, active or uncertain attempt.");
    if (related.some((row) => row.state !== "CANCELLED" && row.phone === phone) && !related.some((row) => row.id === retryOf && ["COMPLETE", "FAILED"].includes(row.state))) {
      throw new VoiceError(409, "This contact has already had an attempt. Explicitly approve another attempt from the AI queue.");
    }
    return createTwenty<AiQueueEntry>(QUEUE, {
      id: input.requestId, name: contact.name || phone, contactId: input.contactId, contactType: input.contactType,
      phone, permission: input.permission, consentEvidence: input.consentEvidence.trim(),
      approvedByMemberId: member.id, approvedByName: member.name, state: "QUEUED",
    }, actor);
  });
}

export async function cancelQueue(id: string): Promise<AiQueueEntry> {
  if (!UUID.test(id)) throw new VoiceError(400, "A valid queue entry ID is required.");
  return withVoiceLock(WORKER_LOCK, async () => {
    const entry = await getTwenty<AiQueueEntry>(QUEUE, id);
    if (entry.state === "CANCELLED") return entry;
    if (entry.state !== "QUEUED") throw new VoiceError(409, "This attempt has already started. Use End AI call for a live conversation.");
    return updateTwenty<AiQueueEntry>(QUEUE, id, { state: "CANCELLED" });
  });
}

export async function retryQueue(id: string, requestId: string, member: { id: string; name: string }, actor: WriteActor | null): Promise<AiQueueEntry> {
  if (!UUID.test(id)) throw new VoiceError(400, "A valid queue entry ID is required.");
  const entry = await getTwenty<AiQueueEntry>(QUEUE, id);
  if (!["COMPLETE", "FAILED"].includes(entry.state)) throw new VoiceError(409, "Only a finished attempt can be explicitly retried.");
  const input = { requestId, contactId: entry.contactId, contactType: entry.contactType, permission: entry.permission, consentEvidence: entry.consentEvidence };
  if (contactNumber(await callableContact(input)) !== entry.phone) throw new VoiceError(409, "The phone changed. Review consent and approve a new entry from the contact.");
  return approveQueue(input, member, actor, id);
}

async function runStatus(status: string, detail: string): Promise<AiAutomationRun> {
  const run = { checkedAt: new Date(Date.now()).toISOString(), status, detail };
  await saveAutomationRun(run);
  return run;
}

async function launchAllowed(entry: AiQueueEntry, number: string): Promise<void> {
  const settings = await readAgentSettings();
  if (!voiceConfig().enabled || !settings.outboundEnabled || settings.paused || settings.goalMode === "off") throw new VoiceError(409, "Outbound automation is off or paused.");
  if (number !== entry.phone) throw new VoiceError(409, "The phone changed since approval. Review consent and approve a new entry.");
  const fresh = await getTwenty<AiQueueEntry>(QUEUE, entry.id);
  if (fresh.state !== "STARTING") throw new VoiceError(409, "This queue entry is no longer authorised for dispatch.");
  if (!(await businessHours()).open) throw new VoiceError(409, "Outside UK business hours or an England and Wales bank holiday.");
  if (dailyProgress(await outboundCalls(), settings).goalReached) throw new VoiceError(409, "Today's goal has already been reached.");
}

export async function recoverAutomation(): Promise<void> {
  const lock = await findLock(WORKER_LOCK);
  if (!lock) return;
  const created = lock.createdAt ? Date.parse(lock.createdAt) : NaN;
  if (!Number.isFinite(created) || Date.now() - created < 15 * 60_000 || await findLock("ai-voice")) {
    throw new VoiceError(409, "Recovery requires a scheduler check older than 15 minutes and no active/uncertain AI call reservation. Verify Telnyx before recovering call reservations.");
  }
  await releaseLock(lock);
  await runStatus("recovered", "Operator recovered a stalled scheduler; no call or phone reservation was cleared.");
}

export async function runAutomation(): Promise<AiAutomationRun> {
  if (!await automationSchemaReady()) throw new VoiceError(503, "Save AI agent controls to prepare automation before scheduling.");
  const lock = await acquireLock(WORKER_LOCK);
  try {
    await runStatus("checking", "Checking the approved queue and today's goal.");
    const settings = await readAgentSettings();
    const queue = await rows<AiQueueEntry>(QUEUE);
    for (const entry of queue.filter((row) => row.state === "STARTING" || row.state === "UNCERTAIN")) {
      const call = await findRequest(entry.id);
      if (call) {
        const fresh = await reconcileVoiceCall(call);
        const active = callView(fresh).active;
        await updateTwenty(QUEUE, entry.id, {
          callId: fresh.id, state: active ? (fresh.aiVoiceState === "UNKNOWN" ? "UNCERTAIN" : "STARTING") : fresh.aiVoiceState === "FAILED" ? "FAILED" : "COMPLETE",
          error: fresh.aiVoiceError || null,
        });
        if (active) return runStatus("call_active", "Waiting for the current outbound AI call to finish.");
      } else if (await findLock("ai-voice")) {
        return runStatus("recovery_required", "An interrupted attempt has an AI call reservation. Check Telnyx; no automatic retry is permitted.");
      } else {
        await updateTwenty(QUEUE, entry.id, { state: "FAILED", error: "Worker stopped before a call record was confirmed. Explicitly approve another attempt." });
      }
    }
    const voiceLock = await findLock("ai-voice");
    if (voiceLock) {
      const call = await findRequest(voiceLock.owner);
      if (!call) return runStatus("recovery_required", "An AI reservation has no confirmed call record. Verify Telnyx before recovery.");
      if (callView(await reconcileVoiceCall(call)).active) return runStatus("call_active", "An outbound AI call is already running.");
    }
    if (!voiceConfig().enabled || !settings.outboundEnabled) return runStatus("disabled", "Outbound AI is switched off.");
    if (settings.paused) return runStatus("paused", "Future automatic calls are paused. An existing call is not interrupted.");
    if (settings.goalMode === "off") return runStatus("goal_off", "Choose either a daily call goal or a daily booking goal to enable automatic calling.");
    if (dailyProgress(await outboundCalls(), settings).goalReached) return runStatus("goal_reached", "Today's goal is reached. Queued contacts are retained for the next UK working day.");
    if (!(await businessHours()).open) return runStatus("outside_hours", "Calls run Monday to Friday, 9 am to 5 pm London time, excluding England and Wales bank holidays.");
    const entry = queue.filter((row) => row.state === "QUEUED").sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (!entry) return runStatus("queue_empty", "No approved contacts remain. Add consent-approved contacts to continue.");
    const [phone] = await listTwenty<AgencyPhone>("agencyPhones", { limit: 1, filter: `phoneNumber[eq]:"${voiceConfig().caller}"` });
    if (!phone || phone.state !== "ACTIVE") throw new VoiceError(503, "Configure an active agency caller number before automatic calling.");
    if ((phone.claimedByMemberId && !isClaimStale(phone)) || await findLock(`phone:${phone.id}`)) {
      return runStatus("number_busy", "The agency caller is reserved. Approved contacts will wait for a later background check.");
    }
    await updateTwenty(QUEUE, entry.id, { state: "STARTING", error: null });
    try {
      const input: AiCallInput = { requestId: entry.id, contactId: entry.contactId, contactType: entry.contactType, permission: entry.permission, consentEvidence: entry.consentEvidence };
      const call = await startVoiceCall(input, entry.approvedByMemberId, {
        createdBy: { source: "API", workspaceMemberId: entry.approvedByMemberId, name: entry.approvedByName },
      }, (number) => launchAllowed(entry, number));
      await updateTwenty(QUEUE, entry.id, { callId: call.id, state: call.active ? "STARTING" : "COMPLETE", error: call.error });
      return runStatus("call_started", "One approved outbound AI call was requested.");
    } catch (error) {
      const call = await findRequest(entry.id);
      const message = error instanceof Error ? error.message : "The approved call could not be dispatched.";
      log.error("Automatic call dispatch failed", message);
      await updateTwenty(QUEUE, entry.id, { callId: call?.id ?? null, state: call && callView(call).active ? "UNCERTAIN" : "FAILED", error: message });
      return runStatus(call && callView(call).active ? "recovery_required" : "attempt_failed", message);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Automation could not check the queue.";
    await runStatus("error", message);
    throw error;
  } finally {
    await releaseLock(lock);
  }
}
