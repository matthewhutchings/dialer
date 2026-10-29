import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AiAgentSettings, AiAutomationView } from "@dialer/shared";
import { api } from "@/domains/api/client";
import { describeError } from "@/domains/feedback/describeError";
import { Button } from "@/domains/ui/button";
import { inputClass } from "@/domains/ui/input";

const AUTOMATION_KEY = ["ai-automation"];
const cardClass = "space-y-3 rounded-[10px] border border-[var(--ods-border)] bg-[var(--ods-bg-primary)] p-4";

function Controls({ initial, save, busy }: { initial: AiAgentSettings; save: (settings: AiAgentSettings) => Promise<void>; busy: boolean }) {
  const [settings, setSettings] = useState(initial);
  const update = <K extends keyof AiAgentSettings>(key: K, value: AiAgentSettings[K]) => setSettings((old) => ({ ...old, [key]: value }));
  return <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void save(settings); }}>
    <fieldset disabled={busy} className={cardClass}>
      <legend className="font-semibold">Inbound reception</legend>
      <label className="flex items-center gap-2"><input type="checkbox" checked={settings.inboundEnabled} onChange={(event) => update("inboundEnabled", event.target.checked)} />Enable inbound AI receptionist</label>
      <p className="text-[13px] text-[var(--ods-text-secondary)]">Chat, booking, messages and screened transfers. Turning this off restores the existing non-AI inbound routing. Outbound goals do not affect inbound reception.</p>
      <label className="block text-[13px]">Inbound business guidance
        <textarea aria-label="Inbound business guidance" className={`${inputClass} mt-1 w-full min-h-28`} maxLength={8000} value={settings.inboundGuidance} onChange={(event) => update("inboundGuidance", event.target.value)} placeholder="Services, FAQs, useful details and preferred tone..." />
      </label>
    </fieldset>
    <fieldset disabled={busy} className={cardClass}>
      <legend className="font-semibold">Outbound discovery</legend>
      <label className="flex items-center gap-2"><input type="checkbox" checked={settings.outboundEnabled} onChange={(event) => update("outboundEnabled", event.target.checked)} />Enable outbound AI calls</label>
      <p className="text-[13px] text-[var(--ods-text-secondary)]">Master switch for manual and automatic outbound AI calls. Switching off prevents new calls, but does not end a live conversation.</p>
      <label className="block text-[13px]">Outbound business guidance
        <textarea aria-label="Outbound business guidance" className={`${inputClass} mt-1 w-full min-h-28`} maxLength={8000} value={settings.outboundGuidance} onChange={(event) => update("outboundGuidance", event.target.value)} placeholder="Discovery priorities, business context, preferred questions..." />
      </label>
    </fieldset>
    <fieldset disabled={busy} className={cardClass}>
      <legend className="font-semibold">Automatic daily goal</legend>
      <label className="block text-[13px]">Goal mode
        <select aria-label="Goal mode" className={`${inputClass} mt-1 w-full`} value={settings.goalMode} onChange={(event) => {
          const value = event.target.value;
          if (value === "off" || value === "calls" || value === "bookings") update("goalMode", value);
        }}>
          <option value="off">Off - manual calling only</option>
          <option value="calls">Daily calls</option>
          <option value="bookings">Daily confirmed bookings</option>
        </select>
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-[13px]">Daily call goal
          <input type="number" min={1} max={1000} required className={`${inputClass} mt-1 w-full`} value={settings.dailyCallGoal} onChange={(event) => update("dailyCallGoal", Number(event.target.value))} />
        </label>
        <label className="block text-[13px]">Daily booking goal
          <input type="number" min={1} max={1000} required className={`${inputClass} mt-1 w-full`} value={settings.dailyBookingGoal} onChange={(event) => update("dailyBookingGoal", Number(event.target.value))} />
        </label>
      </div>
      <p className="text-[13px] text-[var(--ods-text-secondary)]">
        Only the selected goal is active. Saving a goal automatically enables the approved queue unless paused.
        Calls run Monday to Friday, 9 am to 5 pm London time, excluding England and Wales bank holidays.
        One attempt per approval; no automatic retries.
      </p>
      {settings.goalMode === "bookings" && <p className="text-[13px] font-medium">
        Booking mode has no separate daily call cap. It may call the entire approved queue to reach the booking target.
      </p>}
      <label className="flex items-center gap-2"><input type="checkbox" checked={settings.paused} onChange={(event) => update("paused", event.target.checked)} />Pause future automatic calls</label>
    </fieldset>
    <p className="text-[12px] text-[var(--ods-text-secondary)]">Guidance applies from the next assistant start. AI disclosure, permission, booking confirmation and commercial/transfer safeguards remain fixed. Provider credentials and deployment kill switches stay server-side.</p>
    <Button type="submit" busy={busy}>Save AI controls</Button>
  </form>;
}

function Queue({ view, action, busy }: { view: AiAutomationView; action: (operation: () => Promise<unknown>) => Promise<void>; busy: boolean }) {
  const requests = useRef(new Map<string, string>());
  return <section className={cardClass}>
    <h3 className="font-semibold">Approved AI queue</h3>
    <p className="text-[13px] text-[var(--ods-text-secondary)]">Open a contact and choose Approve for AI queue to record permission. Pending entries carry forward to the next working day. Cancel prevents dispatch; End AI call stops an active conversation.</p>
    {!view.schemaReady && <p role="status">Save AI controls once to prepare the approval queue.</p>}
    {view.schemaReady && !view.queue.length && <p>No approved contacts yet. No calls will be placed until you add them.</p>}
    <ul className="space-y-3">
      {view.queue.map((entry) => <li key={entry.id} className="rounded-md border border-[var(--ods-border)] p-3 space-y-2 text-[13px]">
        <div className="flex flex-wrap justify-between gap-2">
          <Link className="ods-link font-semibold" to={`/contacts/${entry.contactId}`}>{entry.name}</Link>
          <span>{entry.state.toLowerCase()} · {entry.phone}</span>
        </div>
        <p>Approved by {entry.approvedByName}: {entry.consentEvidence}</p>
        {entry.error && <p role="alert" className="text-red-600">{entry.error}</p>}
        {entry.state === "QUEUED" && <Button variant="secondary" disabled={busy} onClick={() => void action(() => api.aiCalls.cancelQueue(entry.id))}>Cancel approval</Button>}
        {["COMPLETE", "FAILED"].includes(entry.state) && <Button variant="secondary" disabled={busy} onClick={() => {
          if (!window.confirm(`Approve ONE more AI call to ${entry.name} on ${entry.phone}, using the recorded permission? Only continue if that permission is still valid.`)) return;
          const requestId = requests.current.get(entry.id) || crypto.randomUUID();
          requests.current.set(entry.id, requestId);
          void action(async () => {
            await api.aiCalls.retryQueue(entry.id, requestId);
            requests.current.delete(entry.id);
          });
        }}>Approve another attempt</Button>}
      </li>)}
    </ul>
  </section>;
}

export function AiAutomationSettings() {
  const client = useQueryClient();
  const query = useQuery({ queryKey: AUTOMATION_KEY, queryFn: api.aiCalls.automation, refetchInterval: 15_000 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const refresh = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: AUTOMATION_KEY }),
      client.invalidateQueries({ queryKey: ["ai-voice-config"] }),
      client.invalidateQueries({ queryKey: ["inbound-routing-config"] }),
    ]);
  };
  const action = async (operation: () => Promise<unknown>) => {
    setBusy(true); setError(null); setSaved(false);
    try { await operation(); await refresh(); setSaved(true); }
    catch (err) { setError(describeError(err).detail); }
    finally { setBusy(false); }
  };
  const view = query.data;
  return <div className="space-y-5">
    {query.isPending && <p role="status">Loading shared AI controls...</p>}
    {query.error && <div role="alert"><p>{describeError(query.error).detail}</p><Button variant="secondary" onClick={() => void query.refetch()}>Retry</Button></div>}
    {error && <p role="alert" className="text-red-600">{error}</p>}
    {saved && <p role="status" className="text-emerald-600">AI controls updated for the team.</p>}
    {view && <>
      <section className={cardClass}>
        <h3 className="font-semibold">Today in London · {view.day}</h3>
        <p>{view.calls} outbound AI calls · {view.bookings} confirmed outbound bookings</p>
        <p>{view.settings.goalMode === "off" ? "Automation off - choose a daily goal below." : `${view.settings.paused ? "Paused" : !view.settings.outboundEnabled ? "Outbound disabled" : view.goalReached ? "Goal reached" : "Automatic calling enabled"} · ${view.target} ${view.settings.goalMode} per day`}</p>
        <p className="text-[12px] text-[var(--ods-text-secondary)]">Includes manual and automatic outbound AI calls, not inbound or human calls. Uncertain dial attempts count for safety; preparation failures do not. Booking totals use confirmation time, not the future appointment date. Older bookings without a confirmation timestamp are excluded.</p>
        {!view.schedulerConfigured && <p role="alert" className="text-red-600">The background scheduler is not configured. Contact the deployment administrator.</p>}
        {view.lastRun ? <p className="text-[13px]">Last background check: {new Date(view.lastRun.checkedAt).toLocaleString("en-GB", { timeZone: "Europe/London" })} London · {view.lastRun.detail}</p> : <p>No background check recorded yet.</p>}
        <p className="text-[12px] text-[var(--ods-text-secondary)]">GitHub checks roughly every five minutes during daytime, even with this page closed. GitHub may delay runs. Goals reset at London midnight; calls only resume within working hours.</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" disabled={busy || !view.schemaReady} onClick={() => void action(() => api.aiCalls.saveSettings({ ...view.settings, paused: !view.settings.paused }))}>{view.settings.paused ? "Resume automation" : "Pause automation"}</Button>
          {view.activeCall && <Button variant="danger" disabled={busy} onClick={() => void action(() => api.aiCalls.stop(view.activeCall!.id))}>End AI call</Button>}
          {view.schedulerStalled &&
            <Button variant="secondary" disabled={busy} onClick={() => void action(api.aiCalls.recoverAutomation)}>Recover stalled scheduler</Button>}
        </div>
        {view.activeCall?.error && <p role="alert" className="text-red-600">{view.activeCall.error}</p>}
      </section>
      <Controls key={JSON.stringify(view.settings)} initial={view.settings} busy={busy} save={(settings) => action(() => api.aiCalls.saveSettings(settings))} />
      <Queue view={view} action={action} busy={busy} />
    </>}
  </div>;
}
