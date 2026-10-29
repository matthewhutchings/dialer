export type AiCallPermission = "internal_test" | "consented";

export interface AiAgentProfile {
  name: string;
}

export interface AiAgentSettings {
  inboundEnabled: boolean;
  outboundEnabled: boolean;
  inboundGuidance: string;
  outboundGuidance: string;
  goalMode: "off" | "calls" | "bookings";
  dailyCallGoal: number;
  dailyBookingGoal: number;
  paused: boolean;
}

export interface AiQueueEntry {
  id: string;
  contactId: string;
  contactType: "prospect" | "lead";
  name: string;
  phone: string;
  permission: AiCallPermission;
  consentEvidence: string;
  approvedByMemberId: string;
  approvedByName: string;
  state: "QUEUED" | "STARTING" | "COMPLETE" | "FAILED" | "CANCELLED" | "UNCERTAIN";
  callId: string | null;
  error: string | null;
  createdAt: string;
}

export interface AiAutomationRun {
  checkedAt: string;
  status: string;
  detail: string;
}

export interface AiAutomationView {
  schemaReady: boolean;
  schedulerConfigured: boolean;
  schedulerStalled: boolean;
  settings: AiAgentSettings;
  day: string;
  calls: number;
  bookings: number;
  target: number | null;
  goalReached: boolean;
  queue: AiQueueEntry[];
  activeCall: AiCallView | null;
  lastRun: AiAutomationRun | null;
}

export interface AiCallInput {
  requestId: string;
  contactId: string;
  contactType: "prospect" | "lead";
  permission: AiCallPermission;
  consentEvidence: string;
}

export interface AiCallView {
  id: string;
  contactId: string;
  contactType: "prospect" | "lead";
  state: string;
  active: boolean;
  error: string | null;
  meetingAt: string | null;
  meetingUrl: string | null;
}

export interface AiVoiceConfigView {
  enabled: boolean;
  ready: boolean;
  reason: string | null;
  activeCall: AiCallView | null;
}
