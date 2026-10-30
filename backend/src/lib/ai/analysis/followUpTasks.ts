import { v5 as uuidv5 } from "uuid";
import type { CallTask, CallTaskSync } from "@dialer/shared";
import { createTwenty, listTwenty, getTwenty, fetchTwenty, unwrapTwentyList, type TwentyListResponse } from "../../twenty/client/index.js";
import { createLogger } from "../../logger/index.js";
import type { FollowUpTask } from "./types.js";

const log = createLogger("followup-tasks");
class MissingTaskContactError extends Error {}

export interface CallRef {
  id: string;
  agencyProspectId?: string | null;
  agencyLeadId?: string | null;
  createdByMemberId?: string | null;
}

interface TaskRow {
  id: string;
  title?: string;
  status?: string;
  bodyV2?: { markdown?: string | null } | null;
  dueAt?: string | null;
  assigneeId?: string | null;
}

interface TaskTarget {
  id: string;
  taskId: string;
  targetAgencyProspectId?: string | null;
  targetAgencyLeadId?: string | null;
}

async function taskTargets(filter: string): Promise<TaskTarget[]> {
  const targets: TaskTarget[] = [];
  let cursor: string | undefined;
  do {
    const page = await fetchTwenty<TwentyListResponse<TaskTarget>>("taskTargets", {
      limit: 200, startingAfter: cursor, query: { filter },
    });
    targets.push(...unwrapTwentyList<TaskTarget>(page, "taskTargets"));
    if (!page.pageInfo?.hasNextPage) break;
    const next = page.pageInfo.endCursor;
    if (!next || next === cursor) throw new Error("Twenty did not return the next task page.");
    cursor = next;
  } while (cursor);
  return targets;
}

export async function listCallTasks(callId: string): Promise<CallTask[]> {
  const targets = await taskTargets(`targetAgencyCallId[eq]:"${callId}"`);
  return Promise.all([...new Set(targets.map((target) => target.taskId))].map(async (id) => {
    const [task, links] = await Promise.all([
      getTwenty<TaskRow>("tasks", id),
      taskTargets(`taskId[eq]:"${id}"`),
    ]);
    const contacts: CallTask["contacts"] = [];
    for (const link of links) {
      if (link.targetAgencyProspectId) contacts.push({ type: "prospect", id: link.targetAgencyProspectId });
      if (link.targetAgencyLeadId) contacts.push({ type: "lead", id: link.targetAgencyLeadId });
    }
    return {
      id: task.id, title: task.title ?? "", status: task.status ?? "",
      description: task.bodyV2?.markdown ?? "", dueAt: task.dueAt ?? null, assigneeId: task.assigneeId ?? null,
      contacts,
    };
  }));
}

async function linkTask(call: CallRef, taskId: string): Promise<void> {
  const links: Record<string, string>[] = [{ targetAgencyCallId: call.id }];
  if (call.agencyProspectId) links.push({ targetAgencyProspectId: call.agencyProspectId });
  if (call.agencyLeadId) links.push({ targetAgencyLeadId: call.agencyLeadId });
  for (const link of links) {
    const [field, targetId] = Object.entries(link)[0];
    const [linked] = await listTwenty<{ id: string }>("taskTargets", {
      limit: 1, filter: `and(taskId[eq]:"${taskId}",${field}[eq]:"${targetId}")`,
    });
    if (!linked) await ensureRecord("taskTargets", uuidv5(`${taskId}:${field}:${targetId}`, uuidv5.URL), { taskId, ...link });
    const [verified] = await listTwenty<{ id: string }>("taskTargets", {
      limit: 1, filter: `and(taskId[eq]:"${taskId}",${field}[eq]:"${targetId}")`,
    });
    if (!verified) throw new Error(`Twenty did not save the task link to ${field}.`);
  }
}

/** Re-read persisted associations: caller matching can finish while AI analysis runs. */
export async function repairCallTaskLinks(callId: string): Promise<CallRef> {
  const current = await getTwenty<CallRef>("agencyCalls", callId);
  const targets = await taskTargets(`targetAgencyCallId[eq]:"${callId}"`);
  for (const id of new Set(targets.map((target) => target.taskId))) await linkTask(current, id);
  return current;
}

function sourceRecords(call: CallRef): string {
  const base = (process.env.TWENTY_BASE_URL ?? "").replace(/\/$/, "");
  const records = [`- Call: [${call.id}](${base}/object/agencyCall/${call.id})`];
  if (call.agencyProspectId) records.push(`- Contact (prospect): [${call.agencyProspectId}](${base}/object/agencyProspect/${call.agencyProspectId})`);
  if (call.agencyLeadId) records.push(`- Contact (lead): [${call.agencyLeadId}](${base}/object/agencyLead/${call.agencyLeadId})`);
  return `## Source records\n\n${records.join("\n")}`;
}

async function ensureRecord<T extends { id: string }>(object: string, id: string, body: Record<string, unknown>): Promise<T> {
  const [existing] = await listTwenty<T>(object, { limit: 1, filter: `id[eq]:"${id}"` });
  if (existing) return existing;
  try {
    return await createTwenty<T>(object, { id, ...body });
  } catch (err) {
    // A concurrent request or a lost create response may already have saved it.
    const [saved] = await listTwenty<T>(object, { limit: 1, filter: `id[eq]:"${id}"` });
    if (saved) return saved;
    throw err;
  }
}

/**
 * Creates native Twenty tasks from an analysis, linked to the call and its contact.
 * Stable IDs let retries finish partially linked tasks without duplicating them.
 * Existing task status, edits and assignment are never overwritten.
 */
export async function createFollowUpTasks(call: CallRef, tasks: FollowUpTask[]): Promise<number> {
  call = await repairCallTaskLinks(call.id);
  if (!tasks.length) return 0;
  if (!call.agencyProspectId && !call.agencyLeadId) {
    throw new MissingTaskContactError("The call has no linked contact. Link a prospect or lead before you create follow-up tasks.");
  }
  const existing = await listCallTasks(call.id);
  const titleKey = (title: string) => title.trim().toLowerCase().replace(/\s+/g, " ");
  const byTitle = new Map<string, { id: string }>(existing.map((task) => [titleKey(task.title), task]));
  let created = 0;
  for (const t of tasks) {
    const key = titleKey(t.title);
    const previous = byTitle.get(key);
    const taskId = previous?.id ?? uuidv5(`call-follow-up:${call.id}:${key}`, uuidv5.URL);
    const body: Record<string, unknown> = { title: t.title, status: "TODO", bodyV2: { markdown: `${t.description}\n\n${sourceRecords(call)}\n\n_Created from call analysis._`.trim() } };
    if (t.dueAt) body.dueAt = t.dueAt;
    if (call.createdByMemberId) body.assigneeId = call.createdByMemberId;
    const task = previous ?? await ensureRecord("tasks", taskId, body);
    await linkTask(call, task.id);
    if (!previous) created++;
    byTitle.set(key, { id: task.id });
  }
  log.info(`Created ${created} follow-up task(s) for call=${call.id}`);
  return created;
}

export async function syncFollowUpTasks(call: CallRef, tasks: FollowUpTask[]): Promise<CallTaskSync> {
  try {
    return { created: await createFollowUpTasks(call, tasks), error: null };
  } catch (err) {
    log.error(`Follow-up tasks failed for call=${call.id}:`, err instanceof Error ? err.message : String(err));
    return {
      created: null,
      error: err instanceof MissingTaskContactError
        ? err.message
        : "The AI review was saved, but follow-up tasks could not all be saved in Twenty. Check the linked tasks and re-analyze to retry.",
    };
  }
}
