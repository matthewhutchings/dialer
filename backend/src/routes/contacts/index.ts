import { Router } from "express";
import { authMiddleware, AuthRequest } from "../../middleware/auth.js";
import { getTwenty, updateTwenty } from "../../lib/twenty/client/index.js";
import { resolveActor } from "../../lib/twenty/actor/index.js";
import { createLogger } from "../../lib/logger/index.js";
import type { AgencyPersonRecord } from "../people/helpers.js";

const router = Router();
router.use(authMiddleware);

const log = createLogger("contacts");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CAMPAIGN_ASSIGNMENT = 5000;
const CONCURRENCY = 10;

type ContactType = "prospect" | "lead" | "person";
type ContactRef = { id: string; type: ContactType };
type AssignmentTarget = { object: "agencyProspects" | "agencyLeads"; id: string; contacts: ContactRef[] };
type AssignmentFailure = ContactRef & { error: string };

/** Assign or clear a campaign on selected contacts. People inherit their company's campaign. */
router.post("/campaign", async (req: AuthRequest, res) => {
  const { campaignId, contacts } = req.body ?? {};
  if (campaignId !== null && (typeof campaignId !== "string" || !UUID.test(campaignId))) {
    res.status(400).json({ error: "campaignId must be a campaign id or null" });
    return;
  }
  if (!Array.isArray(contacts) || contacts.length === 0 || contacts.length > MAX_CAMPAIGN_ASSIGNMENT) {
    res.status(400).json({ error: `Select between 1 and ${MAX_CAMPAIGN_ASSIGNMENT} contacts` });
    return;
  }

  const selected: ContactRef[] = [];
  const seen = new Set<string>();
  for (const contact of contacts) {
    if (
      !contact ||
      typeof contact.id !== "string" ||
      !UUID.test(contact.id) ||
      !["prospect", "lead", "person"].includes(contact.type)
    ) {
      res.status(400).json({ error: "Each contact must have a valid id and type" });
      return;
    }
    const key = `${contact.type}:${contact.id}`;
    if (!seen.has(key)) {
      seen.add(key);
      selected.push({ id: contact.id, type: contact.type });
    }
  }

  try {
    if (campaignId) await getTwenty("agencyCampaigns", campaignId);
    const actor = await resolveActor(req);
    const targets = new Map<string, AssignmentTarget>();
    const failures: AssignmentFailure[] = [];

    const addTarget = (contact: ContactRef, object: AssignmentTarget["object"], id: string) => {
      const key = `${object}:${id}`;
      const target = targets.get(key) ?? { object, id, contacts: [] };
      target.contacts.push(contact);
      targets.set(key, target);
    };

    for (let i = 0; i < selected.length; i += CONCURRENCY) {
      const chunk = selected.slice(i, i + CONCURRENCY);
      await Promise.all(
        chunk.map(async (contact) => {
          if (contact.type === "prospect") {
            addTarget(contact, "agencyProspects", contact.id);
            return;
          }
          if (contact.type === "lead") {
            addTarget(contact, "agencyLeads", contact.id);
            return;
          }
          try {
            const person = await getTwenty<AgencyPersonRecord>("agencyPeople", contact.id);
            if (!person.prospectId || !UUID.test(person.prospectId)) {
              failures.push({ ...contact, error: "This person is not linked to a company contact" });
              return;
            }
            addTarget(contact, "agencyProspects", person.prospectId);
          } catch (err) {
            failures.push({ ...contact, error: err instanceof Error ? err.message : "Could not load this person's company" });
          }
        }),
      );
    }

    const updates = [...targets.values()];
    let updated = 0;
    for (let i = 0; i < updates.length; i += CONCURRENCY) {
      const chunk = updates.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        chunk.map((target) =>
          updateTwenty(target.object, target.id, { campaignIdId: campaignId }, actor),
        ),
      );
      results.forEach((result, index) => {
        const target = chunk[index];
        if (result.status === "fulfilled") {
          updated += target.contacts.length;
        } else {
          const error = result.reason instanceof Error ? result.reason.message : "Campaign assignment failed";
          failures.push(...target.contacts.map((contact) => ({ ...contact, error })));
        }
      });
    }

    res.json({
      requested: selected.length,
      updated,
      failed: failures.length,
      failures: failures.slice(0, 20),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Campaign assignment failed";
    log.error(`Campaign assignment failed: ${message}`);
    res.status(502).json({ error: "Could not assign contacts to the campaign", details: message });
  }
});

export default router;
