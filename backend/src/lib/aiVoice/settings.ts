import type { AiAgentSettings, AiAutomationRun } from "@dialer/shared";
import { listTwenty, updateTwenty } from "../twenty/client/index.js";
import type { WriteActor } from "../twenty/actor/index.js";
import { applySchema, readLiveSchema } from "../twenty/schema/applySchema.js";
import { SCHEMA_OBJECTS } from "../twenty/schema/manifest.js";
import { VoiceError, voiceConfig } from "./config.js";

interface SettingsPhone {
  id: string;
  aiAgentSettings?: unknown;
  aiAutomationRun?: AiAutomationRun | null;
}

export function defaultAgentSettings(): AiAgentSettings {
  return {
    inboundEnabled: process.env.AI_VOICE_INBOUND_ENABLED === "true",
    outboundEnabled: voiceConfig().enabled,
    inboundGuidance: "", outboundGuidance: "", goalMode: "off",
    dailyCallGoal: 10, dailyBookingGoal: 10, paused: false,
  };
}

export function validateAgentSettings(value: unknown): AiAgentSettings {
  if (!value || typeof value !== "object") throw new VoiceError(400, "AI settings are required.");
  const field = (key: string): unknown => key in value ? Reflect.get(value, key) : undefined;
  const inboundEnabled = field("inboundEnabled"), outboundEnabled = field("outboundEnabled"), paused = field("paused");
  const inboundGuidance = field("inboundGuidance"), outboundGuidance = field("outboundGuidance"), goalMode = field("goalMode");
  const dailyCallGoal = field("dailyCallGoal"), dailyBookingGoal = field("dailyBookingGoal");
  if (typeof inboundEnabled !== "boolean" || typeof outboundEnabled !== "boolean" || typeof paused !== "boolean" ||
      typeof inboundGuidance !== "string" || inboundGuidance.length > 8000 ||
      typeof outboundGuidance !== "string" || outboundGuidance.length > 8000 ||
      (goalMode !== "off" && goalMode !== "calls" && goalMode !== "bookings") ||
      typeof dailyCallGoal !== "number" || !Number.isInteger(dailyCallGoal) || dailyCallGoal < 1 || dailyCallGoal > 1000 ||
      typeof dailyBookingGoal !== "number" || !Number.isInteger(dailyBookingGoal) || dailyBookingGoal < 1 || dailyBookingGoal > 1000) {
    throw new VoiceError(400, "Choose one goal mode, whole-number targets from 1 to 1000, valid switches and guidance up to 8000 characters.");
  }
  return { inboundEnabled, outboundEnabled, paused, inboundGuidance: inboundGuidance.trim(), outboundGuidance: outboundGuidance.trim(), goalMode, dailyCallGoal, dailyBookingGoal };
}

export async function settingsPhone(): Promise<SettingsPhone> {
  const number = voiceConfig().caller;
  if (!/^\+[1-9]\d{6,14}$/.test(number)) throw new VoiceError(503, "Configure the AI caller number before managing the agents.");
  const [phone] = await listTwenty<SettingsPhone>("agencyPhones", { limit: 1, filter: `phoneNumber[eq]:"${number}"` });
  if (!phone) throw new VoiceError(503, "The AI caller number has no Twenty phone record.");
  return phone;
}

export async function readAgentSettings(): Promise<AiAgentSettings> {
  const phone = await settingsPhone();
  return phone.aiAgentSettings == null ? defaultAgentSettings() : validateAgentSettings(phone.aiAgentSettings);
}

export async function automationSchemaReady(): Promise<boolean> {
  const live = await readLiveSchema();
  const queue = SCHEMA_OBJECTS.find((object) => object.nameSingular === "agencyAiQueueEntry")!;
  return queue.fields.every((field) => {
    const found = live.get(queue.nameSingular)?.fields.get(field.name);
    return found?.isActive && found.type === field.type;
  }) && ["aiAgentSettings", "aiAutomationRun"].every((name) => {
    const field = live.get("agencyPhone")?.fields.get(name);
    return field?.isActive && field.type === "RAW_JSON";
  });
}

export async function prepareAutomationSchema(): Promise<void> {
  if (await automationSchemaReady()) return;
  const objects = SCHEMA_OBJECTS.filter((object) => ["agencyAiQueueEntry", "agencyPhone"].includes(object.nameSingular))
    .map((object) => object.nameSingular === "agencyPhone"
      ? { ...object, fields: object.fields.filter((field) => ["aiAgentSettings", "aiAutomationRun"].includes(field.name)) }
      : object);
  const report = await applySchema({ manifest: { objects, relations: [] } });
  const failure = report.items.find((item) => item.status === "failed" || item.note);
  if (failure) throw new VoiceError(503, `Cannot prepare AI automation: ${failure.note || failure.status}`);
  if (!await automationSchemaReady()) throw new VoiceError(503, "AI automation fields are not ready yet. Wait and save again.");
}

export async function saveAgentSettings(value: unknown, actor: WriteActor | null): Promise<AiAgentSettings> {
  const settings = validateAgentSettings(value);
  await prepareAutomationSchema();
  if (settings.outboundEnabled && !voiceConfig().enabled) throw new VoiceError(503, "Outbound AI calling is disabled in deployment configuration.");
  if (settings.inboundEnabled && process.env.AI_VOICE_INBOUND_ENABLED !== "true") throw new VoiceError(503, "Inbound AI reception is disabled in deployment configuration.");
  const phone = await settingsPhone();
  await updateTwenty("agencyPhones", phone.id, { aiAgentSettings: settings }, actor);
  return settings;
}

export async function saveAutomationRun(run: AiAutomationRun): Promise<void> {
  const phone = await settingsPhone();
  await updateTwenty("agencyPhones", phone.id, { aiAutomationRun: run });
}
