import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { parsePhoneNumberFromString } from "libphonenumber-js";

export class VoiceError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function voiceConfig() {
  return {
    enabled: process.env.AI_VOICE_ENABLED === "true",
    assistantId: process.env.TELNYX_AI_ASSISTANT_ID?.trim() || "",
    appId: process.env.TELNYX_CALL_CONTROL_APP_ID?.trim() || "",
    caller: process.env.AGENCY_PHONE_NUMBER?.trim() || "",
    publicUrl: process.env.AI_VOICE_PUBLIC_URL?.replace(/\/$/, "") || "",
    testNumbers: (process.env.AI_VOICE_TEST_NUMBERS || "").split(",").map((n) => n.trim()).filter(Boolean),
  };
}

export function configurationError(requireEnabled = true): string | null {
  const c = voiceConfig();
  if (requireEnabled && !c.enabled) return "AI calling is disabled. Complete setup and enable AI_VOICE_ENABLED on the backend.";
  if (!c.assistantId || !c.appId || !c.caller || !c.publicUrl ||
      !process.env.TELNYX_API_KEY || !process.env.TELNYX_WEBHOOK_TOKEN ||
      !process.env.AI_VOICE_SECRET || process.env.AI_VOICE_SECRET.length < 32) {
    return "AI calling requires an assistant, Call Control app, agency number, public URL, webhook token and a 32+ character AI_VOICE_SECRET.";
  }
  if (!/^https:\/\//.test(c.publicUrl)) return "AI_VOICE_PUBLIC_URL must use HTTPS.";
  return null;
}

export function ukNumber(raw: string): string {
  const phone = parsePhoneNumberFromString(raw, "GB");
  if (!phone?.isValid() || phone.country !== "GB") {
    throw new VoiceError(400, "Initial AI calling is restricted to valid United Kingdom numbers.");
  }
  return phone.number;
}

function secret(): string {
  const value = process.env.AI_VOICE_SECRET;
  if (!value || value.length < 32) throw new VoiceError(503, "AI_VOICE_SECRET must contain at least 32 characters.");
  return value;
}

export function callToken(callId: string): string {
  return createHmac("sha256", secret()).update(`ai-voice-tool:${callId}`).digest("hex");
}

export function setupToken(): string {
  return createHmac("sha256", secret()).update("ai-voice-additive-schema-setup-v1").digest("hex");
}

export function validSetupToken(token: string): boolean {
  return /^[a-f0-9]{64}$/.test(token) &&
    timingSafeEqual(Buffer.from(setupToken(), "hex"), Buffer.from(token, "hex"));
}

export function validCallToken(callId: string, token: string): boolean {
  if (!UUID.test(callId) || !/^[a-f0-9]{64}$/.test(token)) return false;
  return timingSafeEqual(Buffer.from(callToken(callId), "hex"), Buffer.from(token, "hex"));
}

function encryptionKey(): Buffer {
  return createHmac("sha256", secret()).update("ai-voice-private-state-v1").digest();
}

export function encryptState(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const bytes = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), bytes].map((b) => b.toString("base64url")).join(".");
}

export function decryptState<T>(value: string): T {
  const parts = value.split(".");
  if (parts.length !== 3) throw new VoiceError(500, "Invalid encrypted AI call state.");
  const [iv, tag, bytes] = parts.map((p) => Buffer.from(p, "base64url"));
  const cipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([cipher.update(bytes), cipher.final()]).toString("utf8")) as T;
}
