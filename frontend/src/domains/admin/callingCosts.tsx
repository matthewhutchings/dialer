import { useQuery } from "@tanstack/react-query";
import { api } from "@/domains/api/client";
import { EmptyState, HeadCell, ReportCard, ReportTable, StatTiles, TD, TR } from "@/domains/reports/parts";
import type { DateRange } from "@/domains/reports/data";
import { Skeleton } from "@/domains/ui/skeleton";
import { Phone } from "@/domains/ui/icons";

export interface CallingBalanceResponse {
  balance: number;
  availableCredit: number;
  creditLimit: number;
  pending: number;
  currency: string;
  fetchedAt: string;
}

export interface CallingCostsResponse {
  rows: {
    date: string;
    product: string;
    service: string;
    direction: string | null;
    currency: string;
    cost: number;
  }[];
  services: { product: string; label: string }[];
  fetchedAt: string;
  timezone: "UTC";
}

function calendarDate(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function money(value: number, currency: string) {
  return new Intl.NumberFormat(undefined, {
    style: "currency", currency, currencyDisplay: "code", minimumFractionDigits: 4, maximumFractionDigits: 6,
  }).format(value);
}

export function CallingCosts({ range }: { range: DateRange }) {
  const since = calendarDate(range.start);
  const until = calendarDate(range.end);
  const { data, isLoading, error, isFetching, refetch } = useQuery({
    queryKey: ["admin-calling-costs", since, until],
    queryFn: () => api.admin.callingCosts(since, until),
    staleTime: 60_000,
    retry: 1,
  });
  const balance = useQuery({
    queryKey: ["admin-calling-balance"],
    queryFn: () => api.admin.callingBalance(),
    staleTime: 60_000,
    retry: 1,
  });
  const refreshing = isFetching || balance.isFetching;
  const currencies = [...new Set(data?.rows.map((row) => row.currency))].sort();
  const days: string[] = [];
  for (let time = Date.parse(`${since}T00:00:00Z`); time < Date.parse(`${until}T00:00:00Z`); time += 86_400_000) {
    days.push(new Date(time).toISOString().slice(0, 10));
  }
  return (
    <>
      <ReportCard title="Telnyx account balance" unit={balance.data?.currency}
        tip={{ title: "Telnyx account balance", what: "Current account values from Telnyx, independent of the selected date range. Available credit includes the credit limit; it is not the same as prepaid balance." }}>
        {balance.error ? <div role="alert"><EmptyState>Could not load Telnyx balance. {balance.error.message}</EmptyState></div> :
          balance.isLoading ? <Skeleton className="h-28 w-full" /> : balance.data && <>
            <StatTiles stats={[
              { label: "Current balance", value: money(balance.data.balance, balance.data.currency), icon: Phone },
              { label: "Available to spend", value: money(balance.data.availableCredit, balance.data.currency) },
              { label: "Pending charges", value: money(balance.data.pending, balance.data.currency) },
              { label: "Credit limit", value: money(balance.data.creditLimit, balance.data.currency) },
            ]} />
            <p className="mt-3 text-[13px] text-[var(--ods-text-secondary)]">
              Current account balance, not a balance for the selected dates. Available to spend includes credit.
              {" "}Fetched {new Date(balance.data.fetchedAt).toLocaleString()}.
            </p>
          </>}
      </ReportCard>
      <div className="flex flex-wrap items-start justify-between gap-3 text-[13px] text-[var(--ods-text-secondary)]">
        <div className="space-y-1">
          <p>Actual Telnyx usage charges across this account, not just this dialer. Dates are UTC; amounts stay in the billing currency.</p>
          <p>Recent usage can be delayed or adjusted. This is not a full invoice: number rental, taxes and other products are not included.</p>
          <p>Voice API and SIP/PSTN are separate billed components. Browser and mobile bridge legs can each incur charges.</p>
          {data && <p>Services checked: {data.services.map((service) => service.label).join(", ")}.</p>}
          {data && <p>Fetched {new Date(data.fetchedAt).toLocaleString()}.</p>}
        </div>
        <button type="button" disabled={refreshing} onClick={() => { void refetch(); void balance.refetch(); }}
          className="rounded-md border border-[var(--ods-border)] px-3 py-1.5 font-medium disabled:opacity-50">
          {refreshing ? "Refreshing..." : "Refresh"}
        </button>
      </div>
      {error ? <div role="alert"><EmptyState>Could not load calling costs. {error.message}</EmptyState></div> :
        isLoading ? <Skeleton className="h-48 w-full" /> :
        !data?.rows.length ? <EmptyState>No calling usage reported by Telnyx for this range. Very recent calls may not appear yet.</EmptyState> :
        currencies.map((currency) => {
          const rows = data.rows.filter((row) => row.currency === currency);
          const sum = (selected: typeof rows) => selected.reduce((total, row) => total + row.cost, 0);
          const total = sum(rows);
          return (
            <section key={currency} className="space-y-4" aria-label={`${currency} calling costs`}>
              <StatTiles stats={[
                { label: `Total charges (${currency})`, value: money(total, currency), icon: Phone },
                { label: "Inbound components", value: money(sum(rows.filter((row) => row.direction === "inbound")), currency) },
                { label: "Outbound components", value: money(sum(rows.filter((row) => row.direction === "outbound")), currency) },
                { label: "Other / shared features", value: money(sum(rows.filter((row) => row.direction !== "inbound" && row.direction !== "outbound")), currency) },
              ]} />
              <ReportCard title="Daily calling costs" unit={`${currency} / UTC day`}
                tip={{ title: "Daily calling costs", what: "Sum of the included Telnyx service charges per UTC day. Each currency is shown separately." }}>
                <ReportTable>
                  <thead><tr><HeadCell>Date (UTC)</HeadCell><HeadCell>Charges</HeadCell></tr></thead>
                  <tbody>{days.map((day) => <tr key={day} className={TR}>
                    <td className={TD}>{day}</td>
                    <td className={TD}>{money(sum(rows.filter((row) => row.date === day)), currency)}</td>
                  </tr>)}</tbody>
                </ReportTable>
              </ReportCard>
              <ReportCard title="Costs by service" unit={currency}
                tip={{ title: "Costs by service", what: "Actual reported charges, not estimates from CRM call durations. These components are additive, not unique call counts." }}>
                <ReportTable>
                  <thead><tr><HeadCell>Service</HeadCell><HeadCell>Charges</HeadCell></tr></thead>
                  <tbody>{data.services.map((service) => (
                    <tr key={service.product} className={TR}>
                      <td className={TD}>{service.label}</td>
                      <td className={TD}>{money(sum(rows.filter((row) => row.product === service.product)), currency)}</td>
                    </tr>
                  ))}</tbody>
                  <tfoot><tr><td className={`${TD} font-semibold`}>Total</td><td className={`${TD} font-semibold`}>{money(total, currency)}</td></tr></tfoot>
                </ReportTable>
              </ReportCard>
              <ReportCard title="Daily service breakdown" unit="UTC"
                tip={{ title: "Daily service breakdown", what: "Telnyx usage grouped by day, service, direction and billing currency. Shared features are not assigned an invented direction." }}>
                <ReportTable>
                  <thead><tr><HeadCell>Date</HeadCell><HeadCell>Service</HeadCell><HeadCell>Direction</HeadCell><HeadCell>Charges</HeadCell></tr></thead>
                  <tbody>{rows.map((row, i) => <tr key={`${row.date}-${row.product}-${row.direction}-${i}`} className={TR}>
                    <td className={TD}>{row.date}</td><td className={TD}>{row.service}</td>
                    <td className={`${TD} capitalize`}>{row.direction ?? "Shared feature"}</td><td className={TD}>{money(row.cost, currency)}</td>
                  </tr>)}</tbody>
                </ReportTable>
              </ReportCard>
            </section>
          );
        })}
    </>
  );
}
