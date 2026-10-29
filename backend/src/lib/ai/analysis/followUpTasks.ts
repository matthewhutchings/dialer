import { createTwenty, listTwenty, deleteTwenty } from "../../twenty/client/index.js";
import { createLogger } from "../../logger/index.js";
import type { FollowUpTask } from "./types.js";

const log = createLogger("followup-tasks");

interface CallRef {
  id: string;
  agencyProspectId?: string | null;
  agencyLeadId?: string | null;
  createdByMemberId?: string | null;
}

/**
 * Creates native Twenty tasks from an analysis, linked to the call and its contact.
 * Safe to run twice for one call: if any task already points at the call, nothing is added.
 * Returns how many tasks were created.
 */
export async function createFollowUpTasks(call: CallRef, tasks: FollowUpTask[]): Promise<number> {
  if (!tasks.length) return 0;
  const existing = await listTwenty<{ id: string }>("taskTargets", { limit: 1, filter: `targetAgencyCallId[eq]:"${call.id}"` });
  if (existing.length) return 0;

  let created = 0;
  for (const t of tasks) {
    const body: Record<string, unknown> = { title: t.title, status: "TODO", bodyV2: { markdown: `${t.description}\n\n_Created from call analysis._`.trim() } };
    if (t.dueAt) body.dueAt = t.dueAt;
    if (call.createdByMemberId) body.assigneeId = call.createdByMemberId;
    const task = await createTwenty<{ id: string }>("tasks", body);
    try {
      const links: Record<string, string>[] = [{ targetAgencyCallId: call.id }];
      if (call.agencyProspectId) links.push({ targetAgencyProspectId: call.agencyProspectId });
      if (call.agencyLeadId) links.push({ targetAgencyLeadId: call.agencyLeadId });
      for (const link of links) await createTwenty("taskTargets", { taskId: task.id, ...link });
      created++;
    } catch (err) {
      log.error(`Could not link task ${task.id} to call ${call.id}:`, err instanceof Error ? err.message : String(err));
      await deleteTwenty("tasks", task.id).catch(() => undefined);
    }
  }
  log.info(`Created ${created} follow-up task(s) for call=${call.id}`);
  return created;
}
