import { useCallback, useEffect, useMemo, useState } from "react";
import { describeError } from "@/domains/feedback/describeError";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, Mail, Phone, RefreshCw, User, Users } from "@/domains/ui/icons";
import { useDialer } from "@/domains/dialer/provider";
import { addToQueue } from "@/domains/dialer/queue";
import { api } from "@/domains/api/client";
import { StatusSelect, type StatusOption } from "@/domains/ui/status";
import { StatusFilterDropdown } from "@/domains/ui/status";
import { mapLeadProspectStatusOptions } from "@/domains/twenty/options";
import { ConfirmDialog } from "@/domains/ui/modal";
import { LeadForm } from "@/domains/contact/leadForm";
import { useToast } from "@/domains/ui/toast";
import { ActionsMenu } from "@/domains/ui/menu";
import { TwentyFieldLink } from "@/domains/twenty/fieldLink";
import { Chip } from "@/domains/ui/chip";
import { DataTable, TablePager, ToolbarButton, parsePageSize, useDataTable, type DataColumn } from "@/domains/ui/table";
import { usePersistedState } from "@/domains/app/persistedState";
import type { HeaderFilterOption } from "@/domains/ui/table";
import { ScriptsModal } from "@/domains/scripts/workspace";
import { useCampaigns } from "@/domains/campaigns/data";
import { Button } from "@/domains/ui/button";
import { Modal } from "@/domains/ui/modal";
import { DispositionBadge, DispositionIcon, dispositionMeta } from "@/domains/calls/disposition";
import { CountryBadge, CountryFlag } from "@/domains/country/badge";
import { countryCode, countryName } from "@/domains/country/lookup";
import { timeAgo } from "@/domains/admin/data";
import { useAuth } from "@/domains/auth/provider";
import { initials } from "@/domains/contact/model";
import { memberOptions, resolveMember, type MemberOption } from "./memberOptions";
import {
  contactName,
  useContactFacets,
  useContactWindow,
  useUpdateContact,
  contactsApi,
  type ContactQuery,
  type ContactRow,
  type ContactRowType,
  type ContactType,
} from "./contacts";

const ALL = "all";
const BLANK = "__blank";

/** Table column key -> ACTUAL Twenty agencyProspects field (null = object page). */
const PROSPECT_FIELD_FOR_KEY: Record<string, string | null> = {
  name: "name",
  company: "niche",
  phone: "phone",
  status: "coldCallStatus",
  assigned_to: "assignedTo",
  state: "region",
  city: "city",
  industry: "niche",
};

/** Columns the server can sort by (see backend prospects/helpers/query.ts). */
const SERVER_SORTABLE = new Set(["last_activity", "name", "company", "phone", "status", "state", "city", "country", "industry", "contact_type"]);

/** Twenty coldCallStatus -> app status (a blank status reads as New). */
const TWENTY_STATUS: Record<string, string> = {
  [BLANK]: "new",
  NEW: "new",
  CONTACTED: "contacted",
  INTERESTED: "interested",
  NOT_INTERESTED: "not_interested",
  CALLBACK: "callback",
  CONVERTED: "converted",
  DO_NOT_CONTACT: "do_not_contact",
};

const TYPE_META: Record<ContactRowType, { label: string; icon: typeof Users; color: string }> = {
  prospect: { label: "Prospect", icon: Users, color: "text-blue-600" },
  lead: { label: "Lead", icon: User, color: "text-violet-600" },
  // A decision maker (agencyPerson) at a prospect: shown with their company, dialled on their own line.
  person: { label: "Person", icon: User, color: "text-emerald-600" },
};

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** The Last call filter value for contacts with no call (matches the backend). */
const NEVER_CALLED = "__never";
const NO_CAMPAIGN = "__none";
const UNSELECTED_CAMPAIGN = "__unselected";

function option(value: string, label: string, icon: React.ReactNode, count?: number): StatusOption {
  return { value, label, icon, hint: count, dotColor: "", bgTint: "", textColor: "" };
}

/**
 * All Contacts: prospects and leads from Twenty, loaded a page at a time.
 * Search, filters and sorting run in Twenty, so the browser only holds the
 * rows scrolled through, never the whole list.
 */
export function ProspectPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { success, error: toastError, warning: toastWarning } = useToast();
  const { data: campaigns, isLoading: campaignsLoading, error: campaignsError } = useCampaigns();
  const dialer = useDialer();
  const table = useDataTable("prospects");
  const { columnFilters, setColumnFilter } = table;

  // Status options come from Twenty CRM
  const { data: meta } = useQuery<{ fields: Record<string, Array<{ label: string; value: string; color: string }>> }>({
    queryKey: ["twenty-meta", "agencyProspects"],
    queryFn: async () => api.twentyMeta.fields("agencyProspects"),
    staleTime: Infinity,
  });
  const statusOptions = meta?.fields["coldCallStatus"] ? mapLeadProspectStatusOptions(meta.fields["coldCallStatus"]) : [];
  const { data: facets } = useContactFacets();

  // ---- filter options with server counts (shared by toolbar and column headers) ----
  const statusCounts = useMemo(() => {
    const out = new Map<string, number>();
    for (const [raw, n] of Object.entries(facets?.status ?? {})) {
      const app = TWENTY_STATUS[raw] ?? raw.toLowerCase();
      out.set(app, (out.get(app) ?? 0) + n);
    }
    return out;
  }, [facets]);
  const statusFilterOptions: StatusOption[] = statusOptions.map((o) => ({ ...o, hint: statusCounts.get(o.value) ?? 0 }));

  // Countries grouped by ISO code: "CA" and "Canada" are one option holding both spellings.
  const countryGroups = useMemo(() => {
    const groups = new Map<string, { raws: string[]; count: number }>();
    for (const [raw, n] of Object.entries(facets?.country ?? {})) {
      const key = raw === BLANK ? BLANK : countryCode(raw) ?? raw;
      const g = groups.get(key) ?? { raws: [], count: 0 };
      g.raws.push(raw);
      g.count += n;
      groups.set(key, g);
    }
    return groups;
  }, [facets]);
  const countryOptions = [...countryGroups.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([key, g]) => option(key, key === BLANK ? "Unknown" : countryName(key), <CountryFlag code={key === BLANK ? null : countryCode(key)} />, g.count));

  const typeOptions = (Object.keys(TYPE_META) as ContactRowType[]).map((t) => {
    const Icon = TYPE_META[t].icon;
    return option(t, TYPE_META[t].label, <Icon className={`w-4 h-4 ${TYPE_META[t].color}`} />, facets?.type?.[t] ?? 0);
  });

  const industryOptions = Object.entries(facets?.industry ?? {})
    .sort((a, b) => b[1] - a[1])
    .map(([raw, n]) => option(raw, raw === BLANK ? "No industry" : raw, null, n));

  // Values with counts from Twenty for the place columns.
  const valueOptions = (counts: Record<string, number> | undefined, blank: string) =>
    Object.entries(counts ?? {})
      .sort((a, b) => b[1] - a[1])
      .map(([raw, n]) => option(raw, raw === BLANK ? blank : raw, null, n));
  const companyOptions = valueOptions(facets?.industry, "No company");
  const stateOptions = valueOptions(facets?.state, "No state");
  const cityOptions = valueOptions(facets?.city, "No city");

  const { user } = useAuth();
  const me = user?.memberId ?? null;
  const memberNames = facets?.names?.member ?? {};

  const assignedOptions = useMemo(() => {
    return memberOptions(facets?.names?.member, facets?.assignedTo, me).map((o: MemberOption) =>
      option(o.value, o.label, o.isMe ? <User className="w-3.5 h-3.5" /> : null, o.count),
    );
  }, [facets?.names?.member, facets?.assignedTo, me]);

  // Last call: how the newest call ended, most common first, then Never called.
  const lastCallOptions = Object.entries(facets?.lastCall ?? {})
    .filter(([raw]) => raw !== NEVER_CALLED)
    .sort((a, b) => b[1] - a[1])
    .map(([raw, n]) => option(raw, dispositionMeta(raw).label, <DispositionIcon status={raw} />, n));
  if (facets?.lastCall) lastCallOptions.push(option(NEVER_CALLED, "Never called", null, facets.lastCall[NEVER_CALLED] ?? 0));

  // Toolbar dropdowns and column-header filters share one state (table.columnFilters).
  const pick = (key: string, options: StatusOption[]) => {
    const v = columnFilters[key];
    return v && options.some((o) => o.value === v) ? v : ALL;
  };
  const active = {
    status: pick("status", statusFilterOptions),
    country: pick("country", countryOptions),
    contact_type: pick("contact_type", typeOptions),
    assigned_to: pick("assigned_to", assignedOptions),
    industry: pick("industry", industryOptions),
    company: pick("company", companyOptions),
    state: pick("state", stateOptions),
    city: pick("city", cityOptions),
    last_call: pick("last_call", lastCallOptions),
  };
  // Free-text column filters (every name and number is different).
  const nameText = columnFilters.name ?? "";
  const phoneText = columnFilters.phone ?? "";

  const search = useDebounced(table.search, 300);
  const sort = table.sort && SERVER_SORTABLE.has(table.sort.key) ? table.sort : null;
  const query: ContactQuery = {
    q: search || undefined,
    status: active.status !== ALL ? [active.status] : undefined,
    country: active.country !== ALL ? countryGroups.get(active.country)?.raws : undefined,
    type: active.contact_type !== ALL ? [active.contact_type as ContactRowType] : undefined,
    assignedTo: active.assigned_to !== ALL ? [resolveMember(active.assigned_to, me)] : undefined,
    industry: active.industry !== ALL ? [active.industry] : undefined,
    company: active.company !== ALL ? [active.company] : undefined,
    state: active.state !== ALL ? [active.state] : undefined,
    city: active.city !== ALL ? [active.city] : undefined,
    lastCall: active.last_call !== ALL ? active.last_call : undefined,
    name: nameText || undefined,
    phone: phoneText || undefined,
    sort: sort?.key,
    dir: sort?.direction,
  };
  // One page of rows at a time (20, 50 or 100), with Prev / Next under the table. Only the
  // rows on screen within the page are fetched; the page offset is added to the window.
  const [savedSize, setPageSize] = usePersistedState("prospects-page-size", 50);
  const pageSize = parsePageSize(savedSize);
  const [page, setPage] = useState(0);
  const [range, setRange] = useState<[number, number]>([0, 60]);
  const onRangeChange = useCallback((first: number, last: number) => setRange([first, last]), []);
  // A new search, filter, sort or page size starts back on the first page.
  const queryKey = JSON.stringify([query, pageSize]);
  useEffect(() => setPage(0), [queryKey]);
  const windowRange: [number, number] = [page * pageSize + range[0], page * pageSize + Math.min(range[1], pageSize - 1)];
  const contacts = useContactWindow(query, windowRange);
  const rows = contacts.loaded;
  const total = contacts.total;
  const pageRows = total == null ? null : Math.max(0, Math.min(pageSize, total - page * pageSize));
  const rowAt = useCallback((i: number) => contacts.rowAt(page * pageSize + i), [contacts.rowAt, page, pageSize]); // eslint-disable-line react-hooks/exhaustive-deps

  const updateProspect = useUpdateContact("prospect");
  const updateLead = useUpdateContact("lead");
  const [showForm, setShowForm] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: string; name: string; type: ContactRowType } | null>(null);
  const [bulkDelete, setBulkDelete] = useState<string[] | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [scriptsOpen, setScriptsOpen] = useState(false);
  const [campaignAssignment, setCampaignAssignment] = useState<{
    contacts: { id: string; type: ContactRowType }[];
    clear: () => void;
  } | null>(null);
  const [campaignChoice, setCampaignChoice] = useState(UNSELECTED_CAMPAIGN);
  const [assigningCampaign, setAssigningCampaign] = useState(false);

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["contacts-page"] }),
      queryClient.invalidateQueries({ queryKey: ["contacts-facets"] }),
    ]);

  // Types of the contacts picked with Select all (most are on pages that are not loaded).
  const [pickedTypes, setPickedTypes] = useState<Map<string, ContactRowType>>(new Map());
  const typeOf = useMemo(() => new Map<string, ContactRowType>([...pickedTypes, ...rows.map((r) => [r.id, r.type] as const)]), [rows, pickedTypes]);

  /** Select all: every contact matching the current search and filters, across all pages. */
  async function selectAllMatching(): Promise<string[]> {
    try {
      const { ids, truncated } = await contactsApi.ids(query);
      setPickedTypes(new Map(ids.map((c) => [c.id, c.type])));
      if (truncated) toastWarning("Selection capped", `Only the first ${ids.length.toLocaleString()} contacts were selected. Narrow the filters to pick the rest.`);
      return ids.map((c) => c.id);
    } catch (err) {
      toastError("Contacts not selected", describeError(err).detail);
      return [];
    }
  }

  async function removeContacts(ids: string[]) {
    await Promise.all(
      ids.map((id) => {
        const t = typeOf.get(id);
        return t === "lead" ? api.leads.delete(id) : t === "person" ? api.people.delete(id) : api.prospects.delete(id);
      }),
    );
    await refresh();
  }

  async function handleDelete() {
    if (!deleteConfirm) return;
    const { id, name } = deleteConfirm;
    setDeleteConfirm(null);
    try {
      await removeContacts([id]);
      success("Contact deleted", `${name} has been removed from the list`);
    } catch (err) {
      toastError("Contact not deleted", describeError(err).detail);
    }
  }

  async function handleStatusChange(row: ContactRow, newStatus: string) {
    try {
      // A person's status is their company's pipeline status.
      const id = row.type === "person" ? row.prospectId : row.id;
      if (!id) return;
      await (row.type === "lead" ? updateLead : updateProspect).mutateAsync({ id, patch: { status: newStatus } });
      queryClient.invalidateQueries({ queryKey: ["contacts-facets"] });
      if (row.type === "person") queryClient.invalidateQueries({ queryKey: ["contacts-page"] });
    } catch (err) {
      // The change was rolled back; a pipeline refusal (409) says why.
      toastError("Status not saved", describeError(err).detail);
    }
  }

  async function handleSyncFromTwenty() {
    // No sync endpoint exists (reads are live from Twenty) — refetch instead.
    setSyncing(true);
    try {
      await refresh();
      success("Sync complete", "Contacts refreshed from Twenty");
    } catch (err) {
      toastError("Contacts not refreshed", describeError(err).detail);
    } finally {
      setSyncing(false);
    }
  }

  async function handleBulkDelete(ids: string[]) {
    try {
      await removeContacts(ids);
      success("Deleted", `${ids.length} contact(s) deleted`);
    } catch (err) {
      toastError("Contacts not deleted", describeError(err).detail);
    }
  }

  async function assignCampaign() {
    if (!campaignAssignment || campaignChoice === UNSELECTED_CAMPAIGN) return;
    setAssigningCampaign(true);
    try {
      const result = await api.contacts.assignCampaign({
        campaignId: campaignChoice === NO_CAMPAIGN ? null : campaignChoice,
        contacts: campaignAssignment.contacts,
      });
      await refresh();
      if (result.failed === 0) {
        success(
          campaignChoice === NO_CAMPAIGN ? "Campaign removed" : "Campaign assigned",
          `${result.updated.toLocaleString()} contact${result.updated === 1 ? "" : "s"} updated. Their linked call script will be shown in the dialer.`,
        );
        campaignAssignment.clear();
        setCampaignAssignment(null);
      } else {
        toastWarning(
          "Campaign assignment incomplete",
          `${result.updated.toLocaleString()} assigned; ${result.failed.toLocaleString()} failed. ${result.failures[0]?.error ?? "Review the contacts and retry."}`,
        );
      }
    } catch (err) {
      toastError("Campaign not assigned", describeError(err).detail);
    } finally {
      setAssigningCampaign(false);
    }
  }

  const open = (r: ContactRow) =>
    navigate(r.type === "lead" ? `/leads/${r.id}` : r.type === "person" ? (r.prospectId ? `/contacts/${r.prospectId}` : "/contacts") : `/contacts/${r.id}`);
  const fieldLink = (key: string) => <TwentyFieldLink objectName="agencyProspects" fieldName={PROSPECT_FIELD_FOR_KEY[key] ?? null} />;
  const statusLabel = (value?: string) => statusOptions.find((o) => o.value === value)?.label ?? value;

  const asHeaderOptions = (opts: StatusOption[]): HeaderFilterOption[] =>
    opts.map((o) => ({ value: o.value, label: o.label, count: typeof o.hint === "number" ? o.hint : undefined, icon: o.icon }));

  const columns: DataColumn<ContactRow>[] = [
    { key: "name", label: "Name", type: "title", width: 210, value: (r) => contactName(r) ?? "", onClick: open, headerExtra: fieldLink("name"), filterable: true, filterMode: "contains" },
    {
      key: "contact_type",
      label: "Type",
      type: "custom",
      width: 120,
      value: (r) => r.type,
      text: (r) => TYPE_META[r.type].label,
      render: (r) => (
        <Chip icon={TYPE_META[r.type].icon} iconClassName={TYPE_META[r.type].color}>
          {TYPE_META[r.type].label}
        </Chip>
      ),
      filterable: true,
    },
    { key: "company", label: "Company", type: "text", width: 150, value: (r) => r.company, onClick: open, headerExtra: fieldLink("company"), filterable: true },
    { key: "phone", label: "Phone", type: "phone", width: 175, value: (r) => r.phone, onClick: open, headerExtra: fieldLink("phone"), filterable: true, filterMode: "contains" },
    {
      key: "status",
      label: "Status",
      type: "status",
      value: (r) => r.status,
      text: (r) => statusLabel(r.status),
      render: (r) => <StatusSelect value={r.status} options={statusOptions} onChange={(s) => handleStatusChange(r, s)} />,
      filterable: true,
      headerExtra: fieldLink("status"),
    },
    {
      key: "last_call",
      label: "Last call",
      type: "custom",
      width: 190,
      sortable: false,
      filterable: true,
      value: (r) => r.lastCall?.status ?? null,
      render: (r) =>
        r.lastCall ? (
          <span className="inline-flex items-center gap-2 min-w-0">
            <DispositionBadge status={r.lastCall.status} />
            {r.lastCall.at && <span className="text-[12px] text-[var(--ods-text-tertiary)] shrink-0">{timeAgo(r.lastCall.at)}</span>}
          </span>
        ) : (
          <span className="text-[12px] text-[var(--ods-text-tertiary)]">Never called</span>
        ),
    },
    {
      key: "assigned_to",
      label: "Assigned to",
      type: "custom",
      width: 160,
      sortable: false,
      filterable: true,
      headerExtra: fieldLink("assigned_to"),
      value: (r) => (r.assignedToId ? memberNames[r.assignedToId] ?? "Assigned" : "Unassigned"),
      render: (r) => {
        const name = r.assignedToId ? memberNames[r.assignedToId] ?? null : null;
        return name ? (
          <span className="inline-flex items-center gap-1.5 min-w-0" title={name}>
            <span className="w-5 h-5 rounded-md bg-[var(--ods-bg-tertiary)] text-[12px] font-semibold flex items-center justify-center shrink-0">
              {initials(name)}
            </span>
            <span className="truncate text-[13px]">{name}</span>
          </span>
        ) : (
          <span className="text-[12px] text-[var(--ods-text-tertiary)]">Unassigned</span>
        );
      },
    },
    {
      key: "last_activity",
      label: "Last activity",
      type: "custom",
      width: 150,
      // Sorted by the server (newest or oldest call first); contacts never called always come last.
      value: (r) => r.lastCall?.at ?? null,
      text: (r) => (r.lastCall?.at ? timeAgo(r.lastCall.at) : "Never"),
      render: (r) =>
        r.lastCall?.at ? (
          <span title={new Date(r.lastCall.at).toLocaleString()}>{timeAgo(r.lastCall.at)}</span>
        ) : (
          <span className="text-[12px] text-[var(--ods-text-tertiary)]">Never</span>
        ),
    },
    { key: "state", label: "State", type: "text", width: 110, value: (r) => r.state, headerExtra: fieldLink("state"), filterable: true },
    { key: "city", label: "City", type: "text", width: 120, value: (r) => r.city, headerExtra: fieldLink("city"), filterable: true },
    {
      key: "country",
      label: "Country",
      type: "text",
      width: 150,
      value: (r) => countryName(r.country),
      render: (r) => <CountryBadge country={r.country} />,
      filterable: true,
    },
    {
      key: "industry",
      label: "Industry",
      type: "badge",
      width: 140,
      value: (r) => (r.type === "lead" ? r.source : (r.niche as string | undefined) ?? r.source),
      filterable: true,
      headerExtra: fieldLink("industry"),
    },
  ];

  return (
    <>
      <DataTable
        state={table}
        title="All Contacts"
        footer={<TablePager page={page} pageSize={pageSize} total={total} onPage={setPage} onPageSize={setPageSize} />}
        info={{
          title: "All Contacts",
          icon: Users,
          what: "Every prospect and lead in Twenty. Rows load as you scroll; search and filters run in Twenty, so even huge lists stay fast.",
          key: [
            { color: "#2563eb", label: "Prospect", note: "from lead lists / scraping" },
            { color: "#7c3aed", label: "Lead", note: "came in to you" },
          ],
          use: "Status is where a contact is in your pipeline; Last call shows how the most recent call ended.",
        }}
        columns={columns}
        rows={rows}
        loading={contacts.initialLoading}
        getRowId={(r) => r.id}
        server={{
          total: pageRows,
          count: total,
          pageKey: page,
          rowAt,
          onRangeChange,
          facets: {
            status: asHeaderOptions(statusFilterOptions),
            country: asHeaderOptions(countryOptions),
            contact_type: asHeaderOptions(typeOptions),
            assigned_to: asHeaderOptions(assignedOptions),
            industry: asHeaderOptions(industryOptions),
            company: asHeaderOptions(companyOptions),
            state: asHeaderOptions(stateOptions),
            city: asHeaderOptions(cityOptions),
            last_call: asHeaderOptions(lastCallOptions),
          },
        }}
        onClearFilters={() => {
          for (const key of ["status", "country", "contact_type", "assigned_to", "industry", "company", "state", "city", "last_call", "name", "phone"]) setColumnFilter(key, ALL);
        }}
        selection={{
          selectAll: selectAllMatching,
          onDelete: (ids) => setBulkDelete(ids),
          actions: (ids, clear) => (
            <>
              <ToolbarButton
                onClick={() => {
                  const contacts = ids.flatMap((id) => {
                    const type = typeOf.get(id);
                    return type ? [{ id, type }] : [];
                  });
                  if (contacts.length !== ids.length) {
                    toastError("Campaign not assigned", "One or more selected contact types could not be resolved. Select the contacts again and retry.");
                    return;
                  }
                  setCampaignChoice(UNSELECTED_CAMPAIGN);
                  setCampaignAssignment({ contacts, clear });
                }}
              >
                <Users className="w-3.5 h-3.5" />
                Set campaign
              </ToolbarButton>
              <ToolbarButton
                primary
                onClick={() => {
                  // People are dialled as their company, so only prospects and leads are queued directly.
                  const callable = ids.filter((id) => typeOf.get(id) !== "person");
                  const added = addToQueue(callable);
                  clear();
                  dialer.open();
                  success("Added to dialer", `${added.toLocaleString()} contact${added === 1 ? "" : "s"} queued${callable.length - added ? `, ${(callable.length - added).toLocaleString()} already in the queue` : ""}${ids.length - callable.length ? `, ${ids.length - callable.length} people skipped` : ""}. Open the Queue tab and press Start calling.`);
                }}
              >
                <Phone className="w-3.5 h-3.5" />
                Add to dialer
              </ToolbarButton>
            </>
          ),
        }}
        emptyMessage='No contacts yet. Click "Sync" to import from Twenty.'
        filters={
          <>
            <StatusFilterDropdown label="Type" allLabel="All types" value={active.contact_type} options={typeOptions} onChange={(v) => setColumnFilter("contact_type", v)} />
            <StatusFilterDropdown label="Assigned to" allLabel="All members" value={active.assigned_to} options={assignedOptions} onChange={(v) => setColumnFilter("assigned_to", v)} />
            <StatusFilterDropdown value={active.status} options={statusFilterOptions} onChange={(v) => setColumnFilter("status", v)} />
            <StatusFilterDropdown label="Country" allLabel="All countries" value={active.country} options={countryOptions} onChange={(v) => setColumnFilter("country", v)} />
          </>
        }
        actions={
          <>
            <ToolbarButton onClick={() => setScriptsOpen(true)}>
              <BookOpen className="w-3.5 h-3.5" />
              Scripts
            </ToolbarButton>
            <ToolbarButton onClick={handleSyncFromTwenty} disabled={syncing}>
              <RefreshCw className={`w-3.5 h-3.5 ${syncing ? "animate-spin" : ""}`} />
              Sync
            </ToolbarButton>
            <ToolbarButton primary onClick={() => setShowForm(true)}>
              + New contact
            </ToolbarButton>
          </>
        }
        rowActions={(r) => (
          <>
            {r.email && (
              <a href={`mailto:${r.email}`} className="p-1 text-[var(--ods-text-secondary)] hover:text-[var(--ods-brand-600)]" title="Email">
                <Mail className="w-3.5 h-3.5" />
              </a>
            )}
            <ActionsMenu
              leadId={r.id}
              leadName={contactName(r) ?? "this contact"}
              onView={() => open(r)}
              onDelete={(id, name) => setDeleteConfirm({ id, name, type: r.type })}
              data={r}
            />
          </>
        )}
      />

      <ScriptsModal open={scriptsOpen} onClose={() => setScriptsOpen(false)} />

      <Modal
        open={campaignAssignment !== null}
        onClose={() => !assigningCampaign && setCampaignAssignment(null)}
        title="Set campaign"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" disabled={assigningCampaign} onClick={() => setCampaignAssignment(null)}>Cancel</Button>
            <Button
              variant="primary"
              busy={assigningCampaign}
              busyLabel="Updating…"
              disabled={campaignChoice === UNSELECTED_CAMPAIGN || campaignsLoading || !!campaignsError}
              onClick={() => void assignCampaign()}
            >
              Apply to {campaignAssignment?.contacts.length.toLocaleString() ?? 0} contacts
            </Button>
          </div>
        }
      >
        <p className="mb-4 text-[13px] text-[var(--ods-text-secondary)]">
          The selected campaign determines which linked call script appears when agents call these contacts. People are assigned through their company.
        </p>
        {campaignsError ? (
          <p className="text-sm text-red-600">Campaigns could not be loaded: {describeError(campaignsError).detail}</p>
        ) : campaignsLoading ? (
          <p className="text-sm text-[var(--ods-text-secondary)]">Loading campaigns…</p>
        ) : (campaigns ?? []).length === 0 ? (
          <div className="space-y-3">
            <p className="text-sm text-[var(--ods-text-secondary)]">Create a campaign before assigning contacts.</p>
            <Button
              variant="secondary"
              onClick={() => {
                setCampaignAssignment(null);
                navigate("/campaigns");
              }}
            >
              Open campaigns
            </Button>
          </div>
        ) : (
          <label className="block text-[14px] font-medium text-[var(--ods-text-primary)]">
            Campaign
            <select
              className="mt-1 block w-full rounded-[8px] border border-[var(--ods-border-strong)] bg-[var(--ods-bg-primary)] px-3 py-2 text-[14px]"
              value={campaignChoice}
              onChange={(event) => setCampaignChoice(event.target.value)}
            >
              <option value={UNSELECTED_CAMPAIGN} disabled>Select a campaign</option>
              <option value={NO_CAMPAIGN}>Remove campaign</option>
              {(campaigns ?? []).map((campaign) => (
                <option key={campaign.id} value={campaign.id}>{campaign.name} ({campaign.status})</option>
              ))}
            </select>
          </label>
        )}
      </Modal>

      {showForm && (
        <LeadForm
          onClose={() => setShowForm(false)}
          onSubmit={async (data) => {
            await api.prospects.create(data as any);
            await refresh();
            setShowForm(false);
            success("Contact created", `${data.first_name} ${data.last_name} has been added`);
          }}
        />
      )}

      <ConfirmDialog
        open={!!bulkDelete}
        title="Delete Contacts"
        message={`Delete ${bulkDelete?.length.toLocaleString()} contact${bulkDelete?.length === 1 ? "" : "s"}? This action cannot be undone.`}
        variant="danger"
        confirmLabel="Delete"
        onConfirm={() => {
          const ids = bulkDelete ?? [];
          setBulkDelete(null);
          void handleBulkDelete(ids);
        }}
        onCancel={() => setBulkDelete(null)}
      />

      <ConfirmDialog
        open={!!deleteConfirm}
        title="Delete Contact"
        message={`Are you sure you want to delete "${deleteConfirm?.name}"? This action cannot be undone.`}
        variant="danger"
        confirmLabel="Delete"
        onConfirm={handleDelete}
        onCancel={() => setDeleteConfirm(null)}
      />
    </>
  );
}
