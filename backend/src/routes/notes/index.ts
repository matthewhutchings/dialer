import { Router } from "express";
import { authMiddleware } from "../../middleware/auth.js";
import { createTwenty, deleteTwenty, listTwenty } from "../../lib/twenty/client/index.js";
import { resolveActor } from "../../lib/twenty/actor/index.js";
import { createLogger } from "../../lib/logger/index.js";
import { mapLinkedNote, noteTargetField, type LinkedNote } from "./helpers.js";

const router = Router();
router.use(authMiddleware);
const log = createLogger("linked-notes");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get("/", async (req, res) => {
  const field = noteTargetField(req.query.contactType);
  const id = typeof req.query.contactId === "string" ? req.query.contactId : "";
  if (!field || !UUID.test(id)) {
    res.status(400).json({ error: "Pass contactType (prospect or lead) and a valid contactId." });
    return;
  }
  try {
    const noteIds = new Set<string>();
    let cursor: string | null = null;
    for (;;) {
      const filter: string = cursor
        ? `and(${field}[eq]:"${id}",id[gt]:"${cursor}")`
        : `${field}[eq]:"${id}"`;
      const targets: { id: string; noteId: string | null }[] = await listTwenty("noteTargets", {
        limit: 200, filter, query: { orderBy: "id[AscNullsFirst]" },
      });
      for (const target of targets) if (target.noteId) noteIds.add(target.noteId);
      if (targets.length < 200) break;
      const next = targets[targets.length - 1].id;
      if (next === cursor) throw new Error("Note target pagination did not advance.");
      cursor = next;
    }
    const ids = [...noteIds];
    const notes: LinkedNote[] = [];
    for (let offset = 0; offset < ids.length; offset += 100) {
      notes.push(...await listTwenty<LinkedNote>("notes", {
        limit: 200, filter: `id[in]:[${ids.slice(offset, offset + 100).join(",")}]`,
      }));
    }
    res.json(notes.map(mapLinkedNote).sort((a, b) => (b.at ?? "").localeCompare(a.at ?? "") || a.id.localeCompare(b.id)));
  } catch (err) {
    log.error("Failed to load linked notes:", err instanceof Error ? err.message : String(err));
    res.status(502).json({ error: "Failed to load linked Twenty notes." });
  }
});

router.post("/", async (req, res) => {
  const { contactType, contactId, title, body } = req.body ?? {};
  const field = noteTargetField(contactType);
  const text = typeof body === "string" ? body.trim() : "";
  if (!field || typeof contactId !== "string" || !UUID.test(contactId) || !text || text.length > 20000) {
    res.status(400).json({ error: "Pass contactType, a valid contactId and a note body (max 20000 chars)." });
    return;
  }
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  const author = (req as { memberName?: string }).memberName || "Dialer";
  const heading = (typeof title === "string" && title.trim() ? title.trim() : `Note by ${author} · ${stamp}`).slice(0, 120);
  try {
    const actor = await resolveActor(req);
    const note = await createTwenty<LinkedNote>("notes", { title: heading, bodyV2: { markdown: text } }, actor);
    try {
      await createTwenty("noteTargets", { noteId: note.id, [field]: contactId }, actor);
    } catch (err) {
      await deleteTwenty("notes", note.id).catch(() => undefined);
      throw err;
    }
    res.status(201).json(mapLinkedNote(note));
  } catch (err) {
    log.error("Failed to create note:", err instanceof Error ? err.message : String(err));
    res.status(502).json({ error: "Failed to create the Twenty note." });
  }
});

export default router;
