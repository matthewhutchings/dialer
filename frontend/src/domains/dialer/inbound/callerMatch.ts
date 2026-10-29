import type { CallerMatch } from "@/domains/api/client";
import type { DialTarget } from "@/domains/dialer/provider";

export interface CallerLookup {
  matches: CallerMatch[];
  loading: boolean;
  error: string | null;
}

export function callerRecordPath(match: CallerMatch): string | null {
  if (match.type === "lead") return `/leads/${match.id}`;
  const id = match.type === "person" ? match.prospectId : match.id;
  return id ? `/contacts/${id}` : null;
}

export function callerTarget(number: string, name: string, matches: CallerMatch[]): DialTarget {
  const match = matches.length === 1 ? matches[0] : null;
  return {
    phone: number,
    name: match?.name ?? name,
    contactType: match?.leadId ? "lead" : match?.prospectId ? "prospect" : null,
    contactId: match?.leadId ?? match?.prospectId ?? null,
    country: match?.country,
    campaignId: match?.campaignId,
  };
}
