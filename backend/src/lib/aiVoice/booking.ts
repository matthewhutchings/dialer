import { randomBytes } from "node:crypto";
import { VoiceError } from "./config.js";

const BASE = "https://booking.fewzen.ai";

export interface BookingInput {
  start: string;
  name: string;
  email: string;
  timezone: string;
  notes?: string;
}

export interface BookingResult {
  id: string;
  start: string;
  end: string;
  meetLink: string | null;
  manageUrl: string;
}

export interface BookingAttempt {
  key: string;
  input: BookingInput;
  result?: BookingResult;
  slotUnavailable?: boolean;
}

export interface BookingState {
  slots?: string[];
  attempt?: BookingAttempt;
}

export function validTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: value }).format();
    return value.length > 0 && value.length <= 64;
  } catch {
    return false;
  }
}

export function validateBooking(input: BookingInput): void {
  if (!input || typeof input.name !== "string" || !input.name.trim() || input.name.length > 100 ||
      typeof input.email !== "string" || input.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email) ||
      typeof input.timezone !== "string" || !validTimezone(input.timezone) ||
      typeof input.start !== "string" || !Number.isFinite(Date.parse(input.start)) ||
      (input.notes !== undefined && (typeof input.notes !== "string" || input.notes.length > 2000))) {
    throw new VoiceError(400, "Confirm the attendee's actual name, email, IANA timezone and selected slot before booking.");
  }
}

class SlotUnavailable extends VoiceError {
  constructor() {
    super(409, "That slot is no longer available. Fetch availability again and confirm a new choice.");
  }
}

async function bookingRequest(path: string, init?: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, { ...init, signal: AbortSignal.timeout(12_000) });
  } catch {
    throw new VoiceError(503, "Booking service did not respond. Outcome may be uncertain; retry the same booking details.");
  }
  if (!response.ok) {
    // Do not echo response bodies: recovery credentials may be present.
    if (response.status === 409) {
      const body: unknown = await response.json();
      const message = body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : "";
      if (!/idempotency|key|details/i.test(message) && /slot.*unavailable|no longer available|time.*already booked/i.test(message)) {
        throw new SlotUnavailable();
      }
      throw new VoiceError(409, "Booking conflict. Do not change the existing attempt; recover it or ask Matthew to resolve it.");
    }
    if (response.status === 429) throw new VoiceError(429, `Booking rate limit reached. Retry after ${response.headers.get("Retry-After") || "900"} seconds with the same details.`);
    throw new VoiceError(response.status === 410 ? 410 : 502, `Booking service returned ${response.status}. No new booking is confirmed; retain the same retry details.`);
  }
  return response.json();
}

interface MeetingDetails {
  connected: boolean;
  durationMinutes: number;
  timezone: string;
  minNoticeHours: number;
  maxDaysAhead: number;
}

export async function meetingDetails(): Promise<MeetingDetails> {
  const value = await bookingRequest("/api/event");
  if (!value || typeof value !== "object" || !("connected" in value) ||
      typeof value.connected !== "boolean" || !("durationMinutes" in value) || typeof value.durationMinutes !== "number" ||
      !("timezone" in value) || typeof value.timezone !== "string" ||
      !("minNoticeHours" in value) || typeof value.minNoticeHours !== "number" ||
      !("maxDaysAhead" in value) || typeof value.maxDaysAhead !== "number") {
    throw new VoiceError(502, "Booking service returned invalid meeting details.");
  }
  return {
    connected: value.connected, durationMinutes: value.durationMinutes, timezone: value.timezone,
    minNoticeHours: value.minNoticeHours, maxDaysAhead: value.maxDaysAhead,
  };
}

export async function availableSlots(start: string, end: string): Promise<string[]> {
  const explicitOffset = /(Z|[+-]\d{2}:\d{2})$/;
  const range = Date.parse(end) - Date.parse(start);
  if (!explicitOffset.test(start) || !explicitOffset.test(end) || !Number.isFinite(range) || range <= 0 || range > 62 * 86_400_000) {
    throw new VoiceError(400, "Availability requires explicit-offset timestamps and a range of at most 62 days.");
  }
  const details = await meetingDetails();
  if (!details.connected) throw new VoiceError(503, "Matthew's calendar is disconnected. Do not offer or confirm a booking.");
  const value = await bookingRequest(`/api/availability?${new URLSearchParams({ start, end })}`);
  if (!value || typeof value !== "object" || !("slots" in value) || !Array.isArray(value.slots) ||
      !value.slots.every((slot: unknown) => typeof slot === "string" && Number.isFinite(Date.parse(slot)))) {
    throw new VoiceError(502, "Booking service returned invalid availability.");
  }
  return value.slots;
}

export async function bookMeeting(
  state: BookingState,
  input: BookingInput,
  persist: () => Promise<void>,
): Promise<BookingResult> {
  validateBooking(input);
  if (state.attempt?.slotUnavailable && state.attempt.input.start !== input.start) {
    state.attempt = undefined;
  }
  if (state.attempt) {
    if (JSON.stringify(state.attempt.input) !== JSON.stringify(input)) {
      throw new VoiceError(409, "A booking is already pending or confirmed for this call. Retry its exact original details; do not create another booking.");
    }
  } else {
    if (!state.slots?.includes(input.start)) throw new VoiceError(400, "Choose an exact slot returned by the availability tool.");
    state.attempt = { key: randomBytes(32).toString("hex"), input };
    // Persist before the external side effect so a server restart can recover the same booking.
    await persist();
  }
  let value: unknown;
  try {
    value = await bookingRequest("/api/book", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": state.attempt.key },
      body: JSON.stringify(state.attempt.input),
    });
  } catch (error) {
    if (error instanceof SlotUnavailable) {
      state.attempt.slotUnavailable = true;
      state.slots = [];
      await persist();
    }
    throw error;
  }
  if (!value || typeof value !== "object" ||
      !("id" in value) || typeof value.id !== "string" ||
      !("start" in value) || typeof value.start !== "string" || !Number.isFinite(Date.parse(value.start)) ||
      !("end" in value) || typeof value.end !== "string" || !Number.isFinite(Date.parse(value.end)) ||
      !("meetLink" in value) || (value.meetLink !== null && typeof value.meetLink !== "string") ||
      !("manageUrl" in value) || typeof value.manageUrl !== "string") {
    throw new VoiceError(502, "Invalid booking confirmation. Outcome is uncertain; retain the same retry details.");
  }
  state.attempt.result = { id: value.id, start: value.start, end: value.end, meetLink: value.meetLink, manageUrl: value.manageUrl };
  await persist();
  return state.attempt.result;
}
