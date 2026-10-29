import { applySchema, readLiveSchema } from "../twenty/schema/applySchema.js";
import { SCHEMA_OBJECTS } from "../twenty/schema/manifest.js";
import type { ApplyItem } from "../twenty/schema/types.js";
import { VoiceError } from "./config.js";

export async function setupVoiceSchema(onItem?: (item: ApplyItem) => void): Promise<void> {
  const live = await readLiveSchema();
  if (!live.has("agencyCall")) throw new VoiceError(503, "The base dialer schema must exist before voice setup.");
  const report = await applySchema({
    manifest: {
      objects: SCHEMA_OBJECTS.filter((object) => ["agencyCall", "agencyVoiceLock"].includes(object.nameSingular))
        .map((object) => object.nameSingular === "agencyCall" ? { ...object, fields: object.fields.filter((field) => field.name.startsWith("aiVoice")) } : object),
      relations: [],
    },
    onItem,
  });
  if (report.items.some((item) => item.status === "failed" || item.note)) {
    throw new VoiceError(503, "Resolve voice schema failures or drift before enabling AI calls.");
  }
  const verified = await readLiveSchema();
  if (!verified.get("agencyVoiceLock")?.fields.get("lockKey")?.isUnique ||
      !verified.get("agencyCall")?.fields.get("aiVoiceRequestId")?.isUnique) {
    throw new VoiceError(503, "Required unique voice indexes are missing. Do not enable calling.");
  }
}
