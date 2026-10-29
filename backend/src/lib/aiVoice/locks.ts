import { randomUUID } from "node:crypto";
import { createTwenty, listTwenty, updateTwenty } from "../twenty/client/index.js";
import { VoiceError } from "./config.js";
import { readLiveSchema } from "../twenty/schema/applySchema.js";

let schemaVerifiedAt = 0;
export async function verifyVoiceSchema(): Promise<void> {
  if (Date.now() - schemaVerifiedAt < 60_000) return;
  const live = await readLiveSchema();
  for (const [object, field] of [["agencyVoiceLock", "lockKey"], ["agencyCall", "aiVoiceRequestId"]]) {
    const metadata = live.get(object)?.fields.get(field);
    if (!metadata?.isActive || !metadata.isUnique) {
      throw new VoiceError(503, "AI voice schema is not ready: required unique reservation fields are missing. Run ai:voice:setup --schema --apply.");
    }
  }
  schemaVerifiedAt = Date.now();
}

export interface VoiceLock {
  id: string;
  lockKey: string | null;
  owner: string;
}

export async function findLock(key: string): Promise<VoiceLock | null> {
  if (!/^[a-z0-9:-]+$/i.test(key)) throw new VoiceError(400, "Invalid voice lock key.");
  const rows = await listTwenty<VoiceLock>("agencyVoiceLocks", { limit: 1, filter: `lockKey[eq]:"${key}"` });
  return rows[0] ?? null;
}

export async function acquireLock(key: string, owner: string = randomUUID()): Promise<VoiceLock> {
  await verifyVoiceSchema();
  if (await findLock(key)) throw new VoiceError(409, "This number or AI operation is already in use.");
  // The unique database constraint, not this preliminary lookup, arbitrates concurrent servers.
  try {
    return await createTwenty<VoiceLock>("agencyVoiceLocks", { name: key, lockKey: key, owner });
  } catch (error) {
    if (await findLock(key)) throw new VoiceError(409, "This number or AI operation is already in use.");
    throw error;
  }
}

export async function releaseLock(lock: VoiceLock): Promise<void> {
  // Retain a released audit row: concurrent cleanup can safely clear it again.
  await updateTwenty("agencyVoiceLocks", lock.id, { lockKey: null });
}

export async function releaseOwnedLock(key: string, owner: string): Promise<void> {
  const lock = await findLock(key);
  if (lock?.owner === owner) await releaseLock(lock);
}

export async function withVoiceLock<T>(key: string, action: () => Promise<T>): Promise<T> {
  const lock = await acquireLock(key);
  try {
    return await action();
  } finally {
    await releaseLock(lock);
  }
}
