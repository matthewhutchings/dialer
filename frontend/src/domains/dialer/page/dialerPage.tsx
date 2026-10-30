import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/domains/api/client";
import { Button } from "@/domains/ui/button";
import { Card } from "@/domains/ui/card";
import { Chip } from "@/domains/ui/chip";
import { Markdown } from "@/domains/ui/markdown";
import { useToast } from "@/domains/ui/toast";
import { describeError } from "@/domains/feedback/describeError";
import { LinkedNotes } from "@/domains/contact/notes";
import { contactsApi, contactName, type ContactQuery, type ContactRow } from "@/domains/contact/list";
import { CallScriptViewer } from "@/domains/scripts/viewer";
import { DISPOSITIONS } from "@/domains/calls/disposition";
import { CallControls, formatDuration, STATE_LABEL } from "@/domains/dialer/dock";
import { isLive, useDialer } from "@/domains/dialer/provider";
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Globe,
  MapPin,
  Phone,
  PhoneOff,
  PhoneIncoming,
  RefreshCw,
  SkipForward,
  Star,
  User,
  Users,
  X,
} from "@/domains/ui/icons";

type DialerFilter = "not-contacted" | "all";
type CandidateData = { rows: ContactRow[]; truncated: boolean; withoutPhone: number };

function candidateQuery(filter: DialerFilter): ContactQuery {
  return filter === "not-contacted"
    ? { type: ["prospect"], status: ["new"], lastCall: "__never" }
    : { type: ["prospect"] };
}

function dialTarget(contact: ContactRow) {
  return {
    contactType: "prospect" as const,
    contactId: contact.id,
    phone: contact.phone ?? "",
    name: contactName(contact) ?? "Unknown company",
    campaignId: contact.campaign_id ?? null,
    country: contact.country ?? null,
  };
}

function place(contact: ContactRow) {
  return [contact.city, contact.state, contact.country].filter(Boolean).join(", ");
}

export function DialerPage() {
  const dialer = useDialer();
  const { success, warning, error: toastError } = useToast();
  const [filter, setFilter] = useState<DialerFilter>("not-contacted");
  const [queue, setQueue] = useState<ContactRow[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [running, setRunning] = useState(false);
  const [savingDisposition, setSavingDisposition] = useState(false);
  const queueRef = useRef(queue);
  const currentIndexRef = useRef(currentIndex);
  const runningRef = useRef(running);
  const appliedFilter = useRef<DialerFilter | null>(null);
  const dialAtRef = useRef<(index: number) => void>(() => {});
  queueRef.current = queue;
  currentIndexRef.current = currentIndex;
  runningRef.current = running;

  const query = useMemo(() => candidateQuery(filter), [filter]);
  const candidates = useQuery({
    queryKey: ["dialer-candidates", filter],
    queryFn: async (): Promise<CandidateData> => {
      const { ids, truncated } = await contactsApi.ids(query);
      const found = new Map<string, ContactRow>();
      for (let i = 0; i < ids.length; i += 200) {
        const rows = await contactsApi.lookup(ids.slice(i, i + 200).map((contact) => contact.id));
        for (const row of rows) if (row.type === "prospect") found.set(row.id, row);
      }
      const rows = ids.map((contact) => found.get(contact.id)).filter((row): row is ContactRow => !!row);
      const dialable = rows.filter((row) => row.phone?.trim());
      return { rows: dialable, truncated, withoutPhone: rows.length - dialable.length };
    },
    staleTime: 30_000,
  });

  useEffect(() => {
    if (!candidates.data || appliedFilter.current === filter) return;
    appliedFilter.current = filter;
    queueRef.current = candidates.data.rows;
    currentIndexRef.current = 0;
    runningRef.current = false;
    setQueue(candidates.data.rows);
    setCurrentIndex(0);
    setRunning(false);
  }, [candidates.data, filter]);

  const current = queue[currentIndex] ?? null;
  const active = isLive(dialer.state);
  const contactId = current?.id ?? null;
  const { data: people, isLoading: peopleLoading, error: peopleError } = useQuery({
    queryKey: ["dialer-company-people", contactId],
    queryFn: () => api.people.list({ prospectId: contactId! }),
    enabled: !!contactId,
    staleTime: 30_000,
  });

  const dialAt = useCallback((index: number) => {
    const selected = queueRef.current[index];
    if (!selected) return;
    currentIndexRef.current = index;
    setCurrentIndex(index);
    dialer.open();
    void dialer.dial(dialTarget(selected), {
      saveLabel: "Save & next",
      onSaved: () => {
        if (!runningRef.current) return;
        const savedIndex = queueRef.current.findIndex((row) => row.id === selected.id);
        const nextIndex = savedIndex + 1;
        if (nextIndex >= queueRef.current.length) {
          runningRef.current = false;
          setRunning(false);
          success("Dialer list complete", "You have reached the end of this company list.");
          return;
        }
        dialAtRef.current(nextIndex);
      },
    });
  }, [dialer.dial, dialer.open, success]);
  dialAtRef.current = dialAt;

  const start = () => {
    if (!queue.length) return;
    runningRef.current = true;
    setRunning(true);
    dialAt(currentIndex);
  };

  const stop = () => {
    runningRef.current = false;
    setRunning(false);
  };

  const moveTo = (index: number) => {
    if (!queue.length || active) return;
    const bounded = Math.max(0, Math.min(queue.length - 1, index));
    if (bounded === currentIndex) return;
    if (dialer.state === "ended") dialer.discardSummary();
    currentIndexRef.current = bounded;
    setCurrentIndex(bounded);
    if (runningRef.current) dialAt(bounded);
  };

  const removeCompany = (id: string) => {
    if (active && dialer.target?.contactId === id) {
      warning("Call in progress", "End the call before removing the current company.");
      return;
    }
    const removedIndex = queueRef.current.findIndex((row) => row.id === id);
    if (removedIndex < 0) return;
    const nextQueue = queueRef.current.filter((row) => row.id !== id);
    const wasCurrent = removedIndex === currentIndexRef.current;
    const nextIndex = wasCurrent ? Math.min(removedIndex, nextQueue.length - 1) : removedIndex < currentIndexRef.current ? currentIndexRef.current - 1 : currentIndexRef.current;
    if (wasCurrent && dialer.state === "ended") dialer.discardSummary();
    queueRef.current = nextQueue;
    currentIndexRef.current = Math.max(0, nextIndex);
    setQueue(nextQueue);
    setCurrentIndex(Math.max(0, nextIndex));
    if (wasCurrent && runningRef.current && nextIndex >= 0 && nextQueue[nextIndex]) dialAtRef.current(nextIndex);
    if (!nextQueue.length) stop();
    success("Removed from dialer", "The company is still saved in Contacts.");
  };

  const saveDisposition = async (value: string) => {
    if (savingDisposition || dialer.state !== "ended") return;
    setSavingDisposition(true);
    try {
      await dialer.saveSummary(value);
    } catch (err) {
      toastError("Disposition not saved", describeError(err).detail);
    } finally {
      setSavingDisposition(false);
    }
  };

  const retryCandidates = () => void candidates.refetch();
  const scriptPanel = current ? (
    <CallScriptViewer bare campaignId={current.campaign_id ?? null} onClose={() => {}} />
  ) : null;

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--ods-bg-primary)]">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-[var(--ods-border)] px-5 py-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Phone className="h-5 w-5 text-[var(--ods-brand-600)]" />
            <h1 className="text-xl font-semibold text-[var(--ods-text-primary)]">Dialer</h1>
            {running && <Chip dot="#22c55e">Auto-next on</Chip>}
          </div>
          <p className="mt-1 text-[13px] text-[var(--ods-text-secondary)]">
            Call down the list. Choose a disposition to save the call and move on.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-[12px] font-medium text-[var(--ods-text-secondary)]" htmlFor="dialer-filter">Company list</label>
          <select
            id="dialer-filter"
            className="h-9 rounded-[8px] border border-[var(--ods-border-strong)] bg-[var(--ods-bg-primary)] px-2.5 text-[13px]"
            value={filter}
            disabled={running || active}
            onChange={(event) => setFilter(event.target.value as DialerFilter)}
          >
            <option value="not-contacted">Not contacted</option>
            <option value="all">All companies</option>
          </select>
          <Button size="sm" variant="ghost" icon={RefreshCw} disabled={candidates.isFetching || running || active} onClick={retryCandidates}>
            Refresh
          </Button>
          <Button size="sm" variant="secondary" icon={ExternalLink} onClick={dialer.open}>
            Open call popup
          </Button>
          {running && <Button size="sm" variant="secondary" onClick={stop}>Stop auto-next</Button>}
        </div>
      </header>

      <main className="grid min-h-0 flex-1 grid-cols-1 auto-rows-max overflow-y-auto xl:auto-rows-fr xl:overflow-hidden xl:grid-cols-[260px_minmax(320px,1fr)_minmax(320px,0.95fr)]">
        <aside className="flex max-h-72 min-h-0 flex-col border-b border-[var(--ods-border)] xl:max-h-none xl:border-b-0 xl:border-r">
          <div className="flex items-center justify-between gap-2 border-b border-[var(--ods-border)] px-4 py-3">
            <div>
              <h2 className="text-[14px] font-semibold">Companies</h2>
              <p className="text-[12px] text-[var(--ods-text-tertiary)]">
                {candidates.isLoading ? "Loading…" : `${queue.length.toLocaleString()} ready`}
                {candidates.data?.withoutPhone ? ` · ${candidates.data.withoutPhone} without a number` : ""}
              </p>
            </div>
            {queue.length > 0 && <span className="text-[12px] tabular-nums text-[var(--ods-text-tertiary)]">{currentIndex + 1}/{queue.length}</span>}
          </div>

          {candidates.isLoading ? (
            <p className="p-4 text-[13px] text-[var(--ods-text-secondary)]">Loading companies…</p>
          ) : candidates.error ? (
            <div className="space-y-2 p-4">
              <p role="alert" className="text-[13px] text-red-600">Companies could not be loaded: {describeError(candidates.error).detail}</p>
              <Button size="sm" onClick={retryCandidates}>Try again</Button>
            </div>
          ) : queue.length === 0 ? (
            <div className="p-4 text-[13px] text-[var(--ods-text-secondary)]">
              {filter === "not-contacted" ? "No uncontacted companies with a phone number were found." : "No companies with phone numbers were found."}
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto">
              {queue.map((company, index) => {
                const selected = company.id === current?.id;
                return (
                  <div key={company.id} className={`group flex items-center gap-2 border-b border-[var(--ods-border)] px-3 py-2 ${selected ? "bg-[var(--ods-active)]" : "hover:bg-[var(--ods-hover)]"}`}>
                    <button className="min-w-0 flex-1 text-left" aria-current={selected ? "step" : undefined} onClick={() => moveTo(index)} disabled={active}>
                      <span className="block truncate text-[13px] font-medium">{contactName(company) ?? "Unknown company"}</span>
                      <span className="block truncate text-[11px] text-[var(--ods-text-tertiary)]">{company.phone} · {company.niche ?? company.source ?? "Company"}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => removeCompany(company.id)}
                      disabled={active && dialer.target?.contactId === company.id}
                      aria-label={`Remove ${contactName(company) ?? "company"} from dialer`}
                      title="Remove from dialer list"
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--ods-text-tertiary)] xl:opacity-0 hover:bg-[var(--ods-hover)] hover:text-red-600 group-hover:opacity-100 focus:opacity-100 disabled:opacity-40"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {candidates.data?.truncated && (
            <p className="border-t border-[var(--ods-border)] p-3 text-[12px] text-amber-700">
              The contact search is capped at 5,000 companies. Narrow the Contacts list to work through the rest.
            </p>
          )}
        </aside>

        <section className="min-h-0 border-b border-[var(--ods-border)] p-4 xl:overflow-y-auto xl:border-b-0 xl:border-r">
          {current ? (
            <div className="mx-auto max-w-3xl space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[12px] font-medium uppercase tracking-wide text-[var(--ods-text-tertiary)]">Company profile</div>
                  <h2 className="mt-1 break-words text-2xl font-semibold text-[var(--ods-text-primary)]">{contactName(current) ?? "Unknown company"}</h2>
                  <p className="mt-1 text-[13px] text-[var(--ods-text-secondary)]">{current.niche ?? current.source ?? "Company"}{place(current) ? ` · ${place(current)}` : ""}</p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button size="sm" variant="secondary" icon={ArrowLeft} disabled={active || currentIndex <= 0} onClick={() => moveTo(currentIndex - 1)}>Previous</Button>
                  <Button size="sm" variant="secondary" icon={ArrowRight} disabled={active || currentIndex >= queue.length - 1} onClick={() => moveTo(currentIndex + 1)}>Next</Button>
                </div>
              </div>

              <Card className="border-[color-mix(in_srgb,var(--ods-brand-600)_30%,var(--ods-border))] bg-[color-mix(in_srgb,var(--ods-brand-600)_5%,var(--ods-bg-primary))]">
                <div className="flex items-center gap-2 text-[13px] font-semibold text-[var(--ods-brand-700)]">
                  <Phone className="h-4 w-4" /> Call opener
                </div>
                {current.callOpener?.trim() ? (
                  <div className="mt-3 text-[15px] leading-relaxed text-[var(--ods-text-primary)]">
                    <Markdown>{current.callOpener}</Markdown>
                  </div>
                ) : (
                  <p className="mt-2 text-[13px] text-[var(--ods-text-secondary)]">No call opener has been added to this company yet.</p>
                )}
              </Card>

              <Card title="Company details" padding="sm">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Detail icon={Phone} label="Phone" value={current.phone} />
                  <Detail icon={MapPin} label="Location" value={place(current)} />
                  <Detail icon={Globe} label="Website" value={current.website as string | undefined} href={current.website as string | undefined} />
                  <Detail icon={Star} label="Reviews" value={typeof current.rating === "number" ? `${current.rating} / 5${current.reviewCount ? ` · ${current.reviewCount} reviews` : ""}` : null} />
                  <Detail icon={User} label="Email" value={current.email} href={current.email ? `mailto:${current.email}` : undefined} />
                </div>
                {(current.additional_phones as string[] | undefined)?.length ? (
                  <div className="mt-3 border-t border-[var(--ods-border)] pt-3">
                    <p className="mb-1 text-[12px] font-semibold text-[var(--ods-text-secondary)]">Additional numbers</p>
                    <div className="flex flex-wrap gap-2">
                      {(current.additional_phones as string[]).map((number) => <Chip key={number}>{number}</Chip>)}
                    </div>
                  </div>
                ) : null}
              </Card>

              <Card title={`People at this company${people ? ` (${people.length})` : ""}`} padding="sm">
                {peopleLoading ? (
                  <p className="text-[13px] text-[var(--ods-text-secondary)]">Loading people…</p>
                ) : peopleError ? (
                  <p role="alert" className="text-[13px] text-red-600">People could not be loaded: {describeError(peopleError).detail}</p>
                ) : people?.length ? (
                  <div className="divide-y divide-[var(--ods-border)]">
                    {people.map((person) => (
                      <div key={person.id} className="flex items-center gap-3 py-2 first:pt-0 last:pb-0">
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[var(--ods-bg-tertiary)] text-[var(--ods-text-secondary)]"><User className="h-4 w-4" /></span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[13px] font-medium">{person.name}</p>
                          <p className="truncate text-[12px] text-[var(--ods-text-tertiary)]">{[person.jobTitle, person.role, person.phone].filter(Boolean).join(" · ") || "No additional details"}</p>
                        </div>
                        {person.phone && <a className="text-[12px] text-[var(--ods-brand-600)] hover:underline" href={`tel:${person.phone}`}>Call</a>}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-[13px] text-[var(--ods-text-secondary)]">No additional people are linked to this company.</p>
                )}
              </Card>

              <Card title="Company notes" padding="sm">
                {current.notes?.trim() ? (
                  <Markdown className="text-[13px] text-[var(--ods-text-primary)]">{current.notes}</Markdown>
                ) : (
                  <p className="text-[13px] text-[var(--ods-text-tertiary)]">No company notes have been added.</p>
                )}
                <div className="mt-4 border-t border-[var(--ods-border)] pt-3">
                  <LinkedNotes contact={{ type: "prospect", id: current.id }} />
                </div>
              </Card>
            </div>
          ) : (
            <EmptyState
              loading={candidates.isLoading}
              error={!!candidates.error}
              onRetry={retryCandidates}
              onStart={() => setFilter("not-contacted")}
            />
          )}
        </section>

        <section aria-label="Call workspace" className="-order-1 min-h-0 p-4 xl:order-none xl:overflow-y-auto">
          <div className="mx-auto flex max-w-2xl flex-col gap-4">
            {dialer.incoming && (
              <Card className="border-emerald-500/30 bg-emerald-500/5" padding="sm">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <PhoneIncoming className="h-4 w-4 text-emerald-600" />
                    <div>
                      <p className="text-[12px] text-[var(--ods-text-tertiary)]">Incoming call</p>
                      <p className="text-[14px] font-semibold">{dialer.incoming.name}</p>
                      <p className="text-[12px] tabular-nums text-[var(--ods-text-secondary)]">{dialer.incoming.number}</p>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button variant="danger" icon={PhoneOff} onClick={dialer.decline}>Decline</Button>
                    <Button variant="call" icon={Phone} onClick={() => void dialer.accept()}>Accept</Button>
                  </div>
                </div>
              </Card>
            )}
            {(current || dialer.state !== "idle") && (
              <>
                <Card padding="sm">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p role="status" className="text-[12px] text-[var(--ods-text-tertiary)]">
                        {dialer.state === "idle" ? "Ready to call" : STATE_LABEL[dialer.state]}
                      </p>
                      <h2 className="truncate text-lg font-semibold">{dialer.target?.name ?? (current ? contactName(current) : "Current call")}</h2>
                      <p className="text-[13px] tabular-nums text-[var(--ods-text-secondary)]">{dialer.target?.phone ?? current?.phone}</p>
                    </div>
                    <Chip icon={Phone}><span className="tabular-nums">{formatDuration(dialer.duration)}</span></Chip>
                  </div>
                  {dialer.failure && <p role="alert" className="mt-3 rounded-[8px] bg-red-500/10 p-2 text-[12px] text-red-700"><b>{dialer.failure.title}.</b> {dialer.failure.detail}</p>}
                  {dialer.recWarning && <p role="status" className="mt-3 rounded-[8px] bg-amber-500/10 p-2 text-[12px] text-amber-700">{dialer.recWarning}</p>}
                  {active ? (
                    <div className="mt-4 space-y-3">
                      <CallControls />
                      <Button block variant="danger" icon={PhoneOff} onClick={dialer.hangup}>End call</Button>
                    </div>
                  ) : dialer.state === "ended" ? (
                    <>
                      <p className="mt-4 text-[13px] font-semibold">Choose a disposition to save this call{running ? " and call the next company" : ""}.</p>
                      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
                        {DISPOSITIONS.map((disposition) => (
                          <Button
                            key={disposition.value}
                            variant={disposition.type === "positive" ? "secondary" : "ghost"}
                            disabled={savingDisposition || dialer.saving}
                            onClick={() => void saveDisposition(disposition.value)}
                            className="h-auto min-h-10 justify-start whitespace-normal text-left"
                          >
                            {disposition.label}
                          </Button>
                        ))}
                      </div>
                    </>
                  ) : (
                    <div className="mt-4 flex flex-wrap gap-2">
                      <Button variant="primary" icon={Phone} disabled={!current?.phone || !!dialer.incoming} onClick={start}>
                        {running ? "Call this company" : "Start calling"}
                      </Button>
                      {running && currentIndex < queue.length - 1 && (
                        <Button variant="secondary" icon={SkipForward} onClick={() => moveTo(currentIndex + 1)}>Skip company</Button>
                      )}
                    </div>
                  )}
                  {dialer.state === "ended" && running && <p className="mt-2 text-[12px] text-[var(--ods-text-tertiary)]">Auto-next is on. Click a disposition once to save and move straight to the next company.</p>}
                  {dialer.notesError && <p role="alert" className="mt-2 text-[12px] text-red-600">Call notes could not be saved: {dialer.notesError} <button className="underline" onClick={dialer.retryNotes}>Retry</button></p>}
                </Card>

                {current && <Card className="min-h-[320px]" padding="sm">
                  <div className="mb-3 flex items-center justify-between gap-2 border-b border-[var(--ods-border)] pb-2">
                    <h2 className="text-[14px] font-semibold">Call script</h2>
                    {current.campaign_id && <Chip>Campaign linked</Chip>}
                  </div>
                  {scriptPanel}
                </Card>}

                {dialer.state !== "idle" && (
                  <Card title="Call notes" padding="sm">
                    <textarea
                      value={dialer.notes}
                      onChange={(event) => dialer.setNotes(event.target.value)}
                      rows={4}
                      placeholder="What was said, next steps…"
                      className="w-full resize-y rounded-[8px] border border-[var(--ods-border-strong)] bg-[var(--ods-bg-primary)] px-3 py-2 text-[13px] outline-none focus:border-[var(--ods-brand-500)]"
                    />
                    <p className="mt-1 text-right text-[11px] text-[var(--ods-text-tertiary)]">
                      {dialer.notesError ? "Not saved" : dialer.notes ? dialer.notesSaved ? "Saved to the call" : "Saving…" : "Call notes save automatically"}
                    </p>
                  </Card>
                )}
              </>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}

function Detail({ icon: Icon, label, value, href }: { icon: typeof Phone; label: string; value?: string | null; href?: string }) {
  if (!value) return null;
  const content = <span className="truncate text-[13px] text-[var(--ods-text-primary)]">{value}</span>;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Icon className="h-3.5 w-3.5 shrink-0 text-[var(--ods-text-tertiary)]" />
      <span className="w-16 shrink-0 text-[12px] text-[var(--ods-text-tertiary)]">{label}</span>
      {href ? <a href={href} target={href.startsWith("http") ? "_blank" : undefined} rel={href.startsWith("http") ? "noopener noreferrer" : undefined} className="min-w-0 hover:underline">{content}</a> : content}
    </div>
  );
}

function EmptyState({ loading, error, onRetry, onStart }: { loading: boolean; error: boolean; onRetry: () => void; onStart: () => void }) {
  return (
    <div className="flex h-full min-h-[280px] flex-col items-center justify-center gap-3 text-center">
      {loading ? (
        <p role="status" className="text-[14px] text-[var(--ods-text-secondary)]">Loading dialer list…</p>
      ) : error ? (
        <>
          <p className="text-[14px] text-[var(--ods-text-secondary)]">The company list could not be loaded.</p>
          <Button onClick={onRetry}>Try again</Button>
        </>
      ) : (
        <>
          <Users className="h-8 w-8 text-[var(--ods-text-tertiary)]" />
          <p className="max-w-sm text-[14px] text-[var(--ods-text-secondary)]">There are no companies in this list. You can check the uncontacted filter again or choose a different company list.</p>
          <Button variant="secondary" icon={RefreshCw} onClick={onStart}>Show uncontacted companies</Button>
        </>
      )}
    </div>
  );
}
