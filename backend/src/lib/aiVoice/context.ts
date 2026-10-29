import { toE164, type AiCallInput } from "@dialer/shared";
import type { AgencyLead } from "../../routes/leads/types.js";
import type { AgencyProspect } from "../../routes/prospects/types.js";
import type { AgencyCall } from "../../routes/calls/types.js";
import { mapPerson, type AgencyPersonRecord } from "../../routes/people/helpers.js";
import { fromTwentyEmail } from "../../routes/leads/helpers/mapLead.js";
import { mapLinkedNote, noteTargetField, type LinkedNote } from "../../routes/notes/helpers.js";
import { realPhone, realText, realWebsite } from "../../routes/prospects/helpers/placeholders.js";
import { canonicalPhone } from "../twenty/callerMatching/index.js";
import { getTwenty, listTwenty } from "../twenty/client/index.js";
import { UUID, ukNumber } from "./config.js";

type ContactRef = Pick<AiCallInput, "contactId" | "contactType">;
type ContactRecord = AgencyProspect | AgencyLead;

export interface VoiceBriefing {
  company: {
    name: string | null;
    industry: string | null;
    website: string | null;
    city: string | null;
    region: string | null;
    country: string | null;
  };
  contact: {
    name: string | null;
    role: string | null;
    email: string | null;
    identity: "expected_person_unverified" | "company_number_person_unknown";
  };
  people: { name: string; role: string | null }[];
  recordNotes: string | null;
  callOpener: string | null;
  linkedNotes: { title: string; body: string; at: string | null }[];
  previousCalls: {
    at: string | null;
    summary: string | null;
    notes: string | null;
    disposition: string | null;
    meetingAt: string | null;
    meetingStatus: string | null;
  }[];
  campaign: string | null;
}

export interface VoiceContext {
  number: string;
  company: string;
  script: string;
  briefing: VoiceBriefing;
}

function text(value: unknown, limit = 200): string | null {
  return typeof value === "string" ? realText(value)?.slice(0, limit) || null : null;
}

export function contactNumber(contact: ContactRecord): string {
  const phoneNumber = "phoneNumber" in contact ? toE164(contact.phoneNumber) : null;
  const primaryPhone = "primaryPhone" in contact ? toE164(contact.primaryPhone) : null;
  return ukNumber(realPhone(toE164(contact.phone) || phoneNumber || primaryPhone) || "");
}

async function linkedPeople(ref: ContactRef, contact: ContactRecord): Promise<AgencyPersonRecord[]> {
  if (ref.contactType === "prospect") {
    return listTwenty<AgencyPersonRecord>("agencyPeople", { limit: 20, filter: `prospectId[eq]:"${ref.contactId}"` });
  }
  const personId = "personId" in contact ? contact.personId : null;
  return personId && UUID.test(personId) ? [await getTwenty<AgencyPersonRecord>("agencyPeople", personId)] : [];
}

async function linkedNotes(ref: ContactRef): Promise<VoiceBriefing["linkedNotes"]> {
  const targets = await listTwenty<{ noteId?: string }>("noteTargets", {
    limit: 20, filter: `${noteTargetField(ref.contactType)}[eq]:"${ref.contactId}"`,
    query: { orderBy: "createdAt[DescNullsLast]" },
  });
  const ids = [...new Set(targets.flatMap((target) => target.noteId && UUID.test(target.noteId) ? [target.noteId] : []))];
  if (!ids.length) return [];
  const notes = await listTwenty<LinkedNote>("notes", {
    limit: 5, filter: `id[in]:[${ids.join(",")}]`, query: { orderBy: "createdAt[DescNullsLast]" },
  });
  return notes.map(mapLinkedNote).map((note) => ({
    title: text(note.title) || "Note",
    body: text(note.body.replace(/!?\[([^\]]*)\]\([^)]+\)/g, "$1").replace(/https?:\/\/\S+/g, "[link omitted]"), 1200) || "",
    at: text(note.at, 40),
  }));
}

export function buildBriefing(
  ref: ContactRef,
  contact: ContactRecord,
  people: AgencyPersonRecord[],
  notes: VoiceBriefing["linkedNotes"],
  calls: AgencyCall[],
  campaign: string | null,
): VoiceBriefing {
  const prospect = ref.contactType === "prospect" ? contact as AgencyProspect : null;
  const lead = ref.contactType === "lead" ? contact as AgencyLead : null;
  const number = contactNumber(contact);
  const mapped = people.filter((person) => text(person.name)).map(mapPerson);
  // A shared switchboard does not establish which of its people has answered.
  const matching = mapped.filter((person) => canonicalPhone(person.phone, "GB") === number);
  const recipient = lead?.personId
    ? mapped.find((person) => person.id === lead.personId)
    : matching.length === 1 ? matching[0] : undefined;
  const name = text(lead?.contactName) || text(lead?.name) || text(recipient?.name) || text(prospect?.decisionMaker);
  const email = recipient?.email || fromTwentyEmail(contact.email);
  return {
    company: {
      name: text(prospect?.name || lead?.company),
      industry: text(prospect?.niche),
      website: prospect?.website ? realWebsite(prospect.website)?.slice(0, 500) || null : null,
      city: text(prospect?.city), region: text(prospect?.region), country: text(prospect?.country),
    },
    contact: {
      name,
      role: text(recipient?.jobTitle || recipient?.role || prospect?.decisionMakerTitle),
      email: text(email, 254),
      identity: name ? "expected_person_unverified" : "company_number_person_unknown",
    },
    people: mapped.slice(0, 20).map((person) => ({
      name: person.name.slice(0, 200), role: text(person.jobTitle || person.role),
    })),
    recordNotes: text(prospect?.notes || lead?.note, 2000),
    callOpener: text(prospect?.callOpener, 500),
    linkedNotes: notes.slice(0, 5),
    previousCalls: calls.slice(0, 3).map((call) => ({
      at: call.startedAt || call.createdAt || null,
      summary: text(call.aiSummary || call.summary, 1000),
      notes: text(call.notes, 1000),
      disposition: text(call.disposition),
      meetingAt: call.meetingAt || null,
      meetingStatus: call.meetingStatus || null,
    })),
    campaign,
  };
}

export async function loadVoiceContext(ref: ContactRef, contact: ContactRecord): Promise<VoiceContext> {
  const [people, notes, calls, campaign] = await Promise.all([
    linkedPeople(ref, contact),
    linkedNotes(ref),
    listTwenty<AgencyCall>("agencyCalls", {
      limit: 3,
      filter: `${ref.contactType === "prospect" ? "agencyProspectId" : "agencyLeadId"}[eq]:"${ref.contactId}"`,
      query: { orderBy: "createdAt[DescNullsLast]" },
    }),
    contact.campaignIdId && UUID.test(contact.campaignIdId)
      ? getTwenty<{ name?: string }>("agencyCampaigns", contact.campaignIdId) : null,
  ]);
  let script = "";
  if (campaign && contact.campaignIdId) {
    const scripts = await listTwenty<{ scriptData?: string }>("agencyScripts", {
      limit: 1, filter: `campaignIdId[eq]:"${contact.campaignIdId}"`,
    });
    script = scripts[0]?.scriptData?.slice(0, 8000) || "";
  }
  const briefing = buildBriefing(ref, contact, people, notes, calls, text(campaign?.name));
  return { number: contactNumber(contact), company: briefing.company.name || "the company", script, briefing };
}

export function voiceGreeting(briefing: VoiceBriefing | undefined): string {
  const intro = "Hi, I'm an AI assistant calling on behalf of Matthew at Fewzen.";
  if (briefing?.contact.name) {
    const company = briefing.company.name ? ` at ${spokenName(briefing.company.name)}` : "";
    return `${intro} Am I speaking with ${spokenName(briefing.contact.name)}${company}?`;
  }
  if (briefing?.company.name) return `${intro} Have I reached ${spokenName(briefing.company.name)}?`;
  return `${intro} Is now an okay time for a quick conversation about AI and technology support?`;
}

function spokenName(value: string): string {
  return value.replace(/[<>{}\r\n]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
}
