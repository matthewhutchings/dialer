import { getTwenty } from "../client/index.js";
import { twentyGraphqlClient } from "../graphql/index.js";
import type { AgencyProspect } from "../../../routes/prospects/types.js";
import type { AgencyLead } from "../../../routes/leads/types.js";
import type { AgencyPersonRecord } from "../../../routes/people/helpers.js";
import { buildCallerIndex, callerCandidateFilters, canonicalPhone, type CallerMatch } from "./helpers.js";

export { canonicalPhone } from "./helpers.js";

const phones = { __scalar: true, additionalPhones: { __scalar: true } };

export async function matchCaller(number: string): Promise<CallerMatch[]> {
  const canonical = canonicalPhone(number);
  if (!canonical) throw new Error("An international caller number is required");
  const filters = callerCandidateFilters(canonical);
  const client = twentyGraphqlClient();
  const prospects: AgencyProspect[] = [];
  const leads: AgencyLead[] = [];
  const people: AgencyPersonRecord[] = [];
  for (let page = 0; ; page++) {
    if (page === 50) throw new Error("Too many caller candidates to establish a complete match");
    const args = { first: 200, offset: page * 200, orderBy: [{ id: "AscNullsFirst" as const }] };
    const result = await client.query({
      agencyProspects: {
        __args: { ...args, filter: filters.prospect },
        edges: { node: { __scalar: true, phoneNumber: phones, primaryPhone: phones } },
      },
      agencyLeads: {
        __args: { ...args, filter: filters.lead },
        edges: { node: { __scalar: true, phone: phones, email: { __scalar: true } } },
      },
      agencyPeople: {
        __args: { ...args, filter: filters.person },
        edges: { node: { __scalar: true, phones, emails: { __scalar: true } } },
      },
    });
    if (!result.agencyProspects || !result.agencyLeads || !result.agencyPeople) {
      throw new Error("CRM returned an incomplete caller lookup");
    }
    const p = result.agencyProspects.edges.map((edge) => edge.node);
    const l = result.agencyLeads.edges.map((edge) => edge.node);
    const pe = result.agencyPeople.edges.map((edge) => edge.node);
    prospects.push(...p);
    leads.push(...l);
    people.push(...pe);
    if (p.length < 200 && l.length < 200 && pe.length < 200) break;
  }
  const companyIds = [...new Set(people.flatMap((person) => person.prospectId ? [person.prospectId] : []))]
    .filter((id) => !prospects.some((prospect) => prospect.id === id));
  for (let i = 0; i < companyIds.length; i += 5) {
    prospects.push(...await Promise.all(companyIds.slice(i, i + 5).map((id) =>
      getTwenty<AgencyProspect>("agencyProspects", id),
    )));
  }
  return buildCallerIndex(prospects, leads, people).get(canonical) ?? [];
}
