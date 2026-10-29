import { test } from "node:test";
import assert from "node:assert/strict";
import { createPresenceQueue } from "./presenceQueue";

test("offline waits for an in-flight online write and is always the last update", async () => {
  const writes: boolean[] = [];
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const publish = createPresenceQueue(async (online) => {
    writes.push(online);
    if (online) await pending;
  });
  let current = true;
  const online = publish(true, () => current);
  await Promise.resolve();
  assert.deepEqual(writes, [true]);
  current = false;
  const staleHeartbeat = publish(true, () => current);
  const offline = publish(false, () => current);
  assert.deepEqual(writes, [true]);
  release();
  assert.equal(await online, true);
  assert.equal(await staleHeartbeat, false);
  assert.equal(await offline, true);
  assert.deepEqual(writes, [true, false]);
});

test("a failed heartbeat is surfaced and does not prevent an offline release", async () => {
  const writes: boolean[] = [];
  const publish = createPresenceQueue(async (online) => {
    writes.push(online);
    if (online) throw new Error("Presence unavailable");
  });
  const online = publish(true, () => true);
  const offline = publish(false, () => false);
  await assert.rejects(online, /Presence unavailable/);
  assert.equal(await offline, true);
  assert.deepEqual(writes, [true, false]);
});

test("a newly enabled session follows the previous session's offline release", async () => {
  const writes: boolean[] = [];
  const publish = createPresenceQueue(async (online) => { writes.push(online); });
  await Promise.all([
    publish(true, () => false),
    publish(false, () => false),
    publish(true, () => true),
  ]);
  assert.deepEqual(writes, [false, true]);
});
