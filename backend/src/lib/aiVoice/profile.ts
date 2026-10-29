import type { AiAgentProfile } from "@dialer/shared";
import { listTwenty, updateTwenty } from "../twenty/client/index.js";
import type { WriteActor } from "../twenty/actor/index.js";
import { applySchema, SCHEMA_MANIFEST } from "../twenty/schema/index.js";
import { VoiceError, voiceConfig } from "./config.js";

interface AgentPhone {
  id: string;
  aiAgentName?: string | null;
}

export function validateAgentProfile(value: unknown): AiAgentProfile {
  if (!value || typeof value !== "object" || !("name" in value) ||
      typeof value.name !== "string" || !value.name.trim() || value.name.trim().length > 80 ||
      /[\u0000-\u001f\u007f]/.test(value.name)) {
    throw new VoiceError(400, "Enter an AI agent name between 1 and 80 characters without control characters.");
  }
  return { name: value.name.trim() };
}

async function agentPhone(): Promise<AgentPhone> {
  const number = voiceConfig().caller;
  if (!/^\+[1-9]\d{6,14}$/.test(number)) throw new VoiceError(503, "Configure the agency caller number before naming the AI agent.");
  const [phone] = await listTwenty<AgentPhone>("agencyPhones", { limit: 1, filter: `phoneNumber[eq]:"${number}"` });
  if (!phone) throw new VoiceError(503, "The AI caller number has no agency phone record in Twenty.");
  return phone;
}

export async function readAgentProfile(): Promise<AiAgentProfile> {
  const phone = await agentPhone();
  return phone.aiAgentName == null ? { name: "Fewzen AI" } : validateAgentProfile({ name: phone.aiAgentName });
}

export async function saveAgentProfile(value: unknown, actor: WriteActor | null): Promise<AiAgentProfile> {
  const profile = validateAgentProfile(value);
  const phone = await agentPhone();
  const object = SCHEMA_MANIFEST.objects.find((item) => item.nameSingular === "agencyPhone");
  const field = object?.fields.find((item) => item.name === "aiAgentName");
  if (!object || !field) throw new VoiceError(503, "The AI agent profile schema definition is missing.");
  const report = await applySchema({ manifest: { objects: [{ ...object, fields: [field] }], relations: [] } });
  const failure = report.items.find((item) => item.status === "failed" || item.note);
  if (failure) throw new VoiceError(503, `Could not prepare AI agent settings: ${failure.note ?? failure.status}`);
  await updateTwenty("agencyPhones", phone.id, { aiAgentName: profile.name }, actor);
  return profile;
}
