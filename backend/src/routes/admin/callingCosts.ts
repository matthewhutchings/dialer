import { telnyxClient } from "../../lib/telnyx/index.js";

export const CALLING_SERVICES = [
  { product: "sip-trunking", label: "SIP / PSTN", direction: true },
  { product: "call-control", label: "Voice API", direction: true },
  { product: "webrtc", label: "WebRTC", direction: true },
  { product: "recording", label: "Recording", direction: true },
  { product: "call-control-features", label: "Call Control features", direction: false },
  { product: "amd", label: "Answering machine detection", direction: false },
  { product: "speech-to-text", label: "Transcription", direction: false },
  { product: "text-to-speech", label: "Text to speech", direction: false },
] as const;

const DAY_MS = 86_400_000;
const MAX_PAGES = 10;

function amount(value: unknown): number {
  return typeof value === "number" ? value :
    typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : NaN;
}

export async function loadCallingBalance(
  client: Pick<ReturnType<typeof telnyxClient>, "balance"> = telnyxClient(),
) {
  const { data } = await client.balance.retrieve();
  const balance = amount(data?.balance);
  const availableCredit = amount(data?.available_credit);
  const creditLimit = amount(data?.credit_limit);
  const pending = amount(data?.pending);
  if (!data || typeof data.currency !== "string" || !/^[A-Z]{3}$/.test(data.currency) ||
      ![balance, availableCredit, creditLimit, pending].every(Number.isFinite)) {
    throw new Error("Invalid Telnyx balance response");
  }
  return { balance, availableCredit, creditLimit, pending, currency: data.currency, fetchedAt: new Date().toISOString() };
}

export function callingCostRange(since: unknown, until: unknown) {
  const date = (value: unknown): number => {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
    const time = Date.parse(`${value}T00:00:00Z`);
    return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? time : NaN;
  };
  const start = date(since);
  const end = date(until);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 31 * DAY_MS) {
    throw new RangeError("since and until must be YYYY-MM-DD dates, covering 1-31 UTC days (until exclusive)");
  }
  return {
    start,
    end,
    startDate: new Date(start).toISOString().replace(".000Z", "Z"),
    endDate: new Date(end - 1000).toISOString().replace(".000Z", "Z"),
  };
}

export interface CallingCostRow {
  date: string;
  product: string;
  service: string;
  direction: string | null;
  currency: string;
  cost: number;
}

export async function loadCallingCosts(
  range: ReturnType<typeof callingCostRange>,
  client: Pick<ReturnType<typeof telnyxClient>, "usageReports"> = telnyxClient(),
) {
  const groups = await Promise.all(CALLING_SERVICES.map(async (service) => {
    const rows: CallingCostRow[] = [];
    for (let number = 1; number <= MAX_PAGES; number++) {
      const page = await client.usageReports.list({
        product: service.product,
        dimensions: service.direction ? ["date", "currency", "direction"] : ["date", "currency"],
        metrics: ["cost"],
        start_date: range.startDate,
        end_date: range.endDate,
        "page[size]": 200,
        "page[number]": number,
      });
      if (!Array.isArray(page.data) || !Number.isInteger(page.meta?.total_pages) ||
          page.meta.total_pages < 0 || page.meta.page_number !== number ||
          (page.meta.total_pages > number && page.data.length === 0)) {
        throw new Error(`Invalid Telnyx pagination for ${service.product}`);
      }
      for (const raw of page.data) {
        // SIP reports use midnight timestamps; other products use date-only strings.
        const date = typeof raw.date === "string" ? raw.date.slice(0, 10) : "";
        const time = Date.parse(`${date}T00:00:00Z`);
        const cost = amount(raw.cost);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(time) ||
            new Date(time).toISOString().slice(0, 10) !== date || time < range.start || time >= range.end ||
            typeof raw.currency !== "string" || !/^[A-Z]{3}$/.test(raw.currency) ||
            !Number.isFinite(cost) ||
            (service.direction && (typeof raw.direction !== "string" || !raw.direction.trim()))) {
          throw new Error(`Invalid Telnyx cost row for ${service.product}`);
        }
        rows.push({
          date, product: service.product, service: service.label,
          direction: service.direction ? String(raw.direction) : null,
          currency: raw.currency, cost,
        });
      }
      if (number >= page.meta.total_pages) break;
      if (number === MAX_PAGES) throw new Error(`Telnyx ${service.product} report exceeds pagination limit; choose a shorter range`);
    }
    return rows;
  }));
  return {
    rows: groups.flat().sort((a, b) => b.date.localeCompare(a.date) || a.service.localeCompare(b.service)),
    services: CALLING_SERVICES.map(({ product, label }) => ({ product, label })),
    fetchedAt: new Date().toISOString(),
    timezone: "UTC" as const,
  };
}
