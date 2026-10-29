import { getCountries, parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";
import { toE164 } from "@dialer/shared";
import { additionalPhones } from "../contactValues/index.js";
import type { AgencyProspect } from "../../../routes/prospects/types.js";
import type { AgencyLead } from "../../../routes/leads/types.js";
import type { AgencyPersonRecord } from "../../../routes/people/helpers.js";

export interface CallerMatch {
  id: string;
  type: "prospect" | "lead" | "person";
  name: string;
  company: string | null;
  email: string | null;
  jobTitle: string | null;
  prospectId: string | null;
  leadId: string | null;
  country: string | null;
  campaignId: string | null;
}

const countries = getCountries();
const names = new Intl.DisplayNames(["en"], { type: "region" });
const countryNames = new Map(countries.map((code) => [names.of(code)?.toLowerCase(), code]));
const aliases: Record<string, CountryCode> = {
  uk: "GB", britain: "GB", "great britain": "GB", england: "GB", scotland: "GB",
  wales: "GB", "northern ireland": "GB", usa: "US", "united states of america": "US",
  "republic of ireland": "IE", eire: "IE",
};

function countryCode(raw?: string | null): CountryCode | undefined {
  const value = raw?.trim();
  return value ? countries.find((code) => code === value.toUpperCase())
    ?? aliases[value.toLowerCase()] ?? countryNames.get(value.toLowerCase()) : undefined;
}

/** Never infer a national number's country from the caller or our business line. */
export function canonicalPhone(raw: string | null | undefined, country?: string | null): string | null {
  const text = raw?.trim().replace(/^00/, "+");
  if (!text || !/^[+\d\s().-]+$/.test(text)) return null;
  const parsed = parsePhoneNumberFromString(text, { defaultCountry: countryCode(country), extract: false });
  return parsed?.isPossible() ? parsed.number : null;
}

/** A broad database prefilter only; identity is verified against the full canonical number. */
export function callerCandidateFilters(number: string) {
  const canonical = canonicalPhone(number);
  if (!canonical) throw new Error("An international caller number is required");
  const pattern = `%${canonical.slice(-7).split("").join("%")}%`;
  const composite = (field: "phoneNumber" | "primaryPhone" | "phone" | "phones") => [
    { [field]: { primaryPhoneNumber: { like: pattern } } },
    { [field]: { additionalPhones: { like: pattern } } },
  ];
  return {
    prospect: { or: [{ phone: { like: pattern } }, ...composite("phoneNumber"), ...composite("primaryPhone")] },
    lead: { or: composite("phone") },
    person: { or: composite("phones") },
  };
}

function phoneNumbers(raw: AgencyProspect["phoneNumber"], country?: string | null): string[] {
  const values: Array<{ value: string | null; country?: string | null }> = [{
    value: toE164(raw),
    country: raw && typeof raw === "object" ? raw.primaryPhoneCountryCode || country : country,
  }];
  if (raw && typeof raw === "object") {
    for (const entry of raw.additionalPhones ?? []) {
      values.push({
        value: additionalPhones({ additionalPhones: [entry] })[0] ?? null,
        country: entry && typeof entry === "object" && "countryCode" in entry && typeof entry.countryCode === "string"
          ? entry.countryCode || country : country,
      });
    }
  }
  return values.flatMap(({ value, country }) => {
    const number = canonicalPhone(value, country);
    return number ? [number] : [];
  });
}

export function buildCallerIndex(
  prospects: AgencyProspect[], leads: AgencyLead[], people: AgencyPersonRecord[],
): Map<string, CallerMatch[]> {
  const index = new Map<string, CallerMatch[]>();
  const companies = new Map(prospects.map((p) => [p.id, p]));
  const add = (match: CallerMatch, numbers: string[]) => {
    for (const number of new Set(numbers)) {
      const matches = index.get(number) ?? [];
      matches.push(match);
      index.set(number, matches);
    }
  };
  for (const p of prospects) {
    add({
      id: p.id, type: "prospect", name: p.name?.trim() || "Unnamed company",
      company: p.name ?? null, email: p.email ?? null, jobTitle: null,
      prospectId: p.id, leadId: null, country: p.country ?? null, campaignId: p.campaignIdId ?? null,
    }, [p.phone, p.phoneNumber, p.primaryPhone].flatMap((phone) => phoneNumbers(phone, p.country)));
  }
  for (const lead of leads) {
    add({
      id: lead.id, type: "lead", name: lead.name?.trim() || lead.contactName?.trim() || "Unnamed lead",
      company: lead.company ?? null, email: typeof lead.email === "string" ? lead.email : lead.email?.primaryEmail ?? null,
      jobTitle: null, prospectId: null, leadId: lead.id, country: null, campaignId: lead.campaignIdId ?? null,
    }, phoneNumbers(lead.phone));
  }
  for (const person of people) {
    const company = person.prospectId ? companies.get(person.prospectId) : undefined;
    add({
      id: person.id, type: "person", name: person.name?.trim() || "Unnamed person",
      company: company?.name ?? null, email: person.emails?.primaryEmail ?? null,
      jobTitle: person.jobTitle ?? null, prospectId: person.prospectId ?? null, leadId: null,
      country: company?.country ?? null, campaignId: company?.campaignIdId ?? null,
    }, phoneNumbers(person.phones ?? undefined, company?.country));
  }
  return index;
}
