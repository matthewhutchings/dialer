import { listTwenty, updateTwenty } from "../twenty/client/index.js";
import type { WriteActor } from "../twenty/actor/index.js";
import { applySchema, SCHEMA_MANIFEST } from "../twenty/schema/index.js";

export interface InboundRoutingSettings {
  fallbackPhone: string;
  holdAudioUrl: string;
}

interface InboundPhone {
  id: string;
  inboundRouting?: unknown;
}

export function validateInboundSettings(value: unknown, inboundNumber?: string): InboundRoutingSettings {
  if (!value || typeof value !== "object") throw new Error("Inbound settings are required.");
  if (!("fallbackPhone" in value) || typeof value.fallbackPhone !== "string" ||
      !/^\+[1-9]\d{6,14}$/.test(value.fallbackPhone)) {
    throw new Error("Enter the fallback mobile in international format, e.g. +447700900123.");
  }
  if (value.fallbackPhone === inboundNumber) throw new Error("The fallback mobile must not be the inbound business number.");
  if (!("holdAudioUrl" in value) || typeof value.holdAudioUrl !== "string") {
    throw new Error("Enter a public HTTPS hold-audio URL.");
  }
  let url: URL;
  try { url = new URL(value.holdAudioUrl); }
  catch { throw new Error("Enter a valid public HTTPS hold-audio URL."); }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("Hold audio must use HTTPS without embedded credentials.");
  }
  return { fallbackPhone: value.fallbackPhone, holdAudioUrl: value.holdAudioUrl };
}

async function inboundPhone(number: string): Promise<InboundPhone | undefined> {
  if (!/^\+[1-9]\d{6,14}$/.test(number)) throw new Error("TELNYX_INBOUND_NUMBER must be configured in E.164 format.");
  const rows = await listTwenty<InboundPhone>("agencyPhones", {
    limit: 1,
    filter: `phoneNumber[eq]:"${number}"`,
  });
  return rows[0];
}

export async function readInboundSettings(
  number: string,
  defaults: InboundRoutingSettings,
): Promise<InboundRoutingSettings> {
  const phone = await inboundPhone(number);
  return phone?.inboundRouting == null
    ? { fallbackPhone: defaults.fallbackPhone, holdAudioUrl: defaults.holdAudioUrl }
    : validateInboundSettings(phone.inboundRouting, number);
}

export async function saveInboundSettings(
  number: string,
  settings: InboundRoutingSettings,
  actor: WriteActor | null,
): Promise<void> {
  const validated = validateInboundSettings(settings, number);
  const phone = await inboundPhone(number);
  if (!phone) throw new Error("The inbound business number has no agency phone record in Twenty.");
  const object = SCHEMA_MANIFEST.objects.find((item) => item.nameSingular === "agencyPhone");
  const field = object?.fields.find((item) => item.name === "inboundRouting");
  if (!object || !field) throw new Error("The inbound settings schema definition is missing.");
  const report = await applySchema({
    manifest: { objects: [{ ...object, fields: [field] }], relations: [] },
  });
  const failure = report.items.find((item) => item.status === "failed" || item.note);
  if (failure) throw new Error(`Could not prepare inbound settings: ${failure.note ?? failure.status}`);
  await updateTwenty("agencyPhones", phone.id, { inboundRouting: validated }, actor);
}
