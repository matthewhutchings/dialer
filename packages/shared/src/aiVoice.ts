export type AiCallPermission = "internal_test" | "consented";

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
