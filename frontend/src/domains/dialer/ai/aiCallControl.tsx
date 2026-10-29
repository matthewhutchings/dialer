import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AiCallInput, AiCallView } from "@dialer/shared";
import { api } from "@/domains/api/client";
import type { Contact } from "@/domains/contact/model";
import { describeError } from "@/domains/feedback/describeError";
import { Button } from "@/domains/ui/button";
import { inputClass } from "@/domains/ui/input";
import { Modal } from "@/domains/ui/modal";
import { useToast } from "@/domains/ui/toast";

export function AiCallControl({ contact }: { contact: Contact }) {
  const [open, setOpen] = useState(false);
  const [queueApproval, setQueueApproval] = useState(false);
  const [permission, setPermission] = useState<AiCallInput["permission"]>("internal_test");
  const [evidence, setEvidence] = useState("");
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [latest, setLatest] = useState<AiCallView | null>(null);
  const request = useRef<AiCallInput | null>(null);
  const { error: toastError, success } = useToast();
  const queryClient = useQueryClient();
  const config = useQuery({
    queryKey: ["ai-voice-config"],
    queryFn: api.aiCalls.config,
    refetchInterval: (query) => query.state.data?.enabled ? 15_000 : false,
  });
  const callId = config.data?.activeCall?.id || latest?.id;
  const status = useQuery({
    queryKey: ["ai-voice-call", callId],
    queryFn: () => api.aiCalls.get(callId!),
    enabled: !!callId,
    refetchInterval: (query) => query.state.data?.active ? 5000 : false,
  });
  const call = status.data || config.data?.activeCall || latest;
  const active = call?.active === true;
  const blocked = ["DO_NOT_CONTACT", "OPTED_OUT", "DNC"].includes((contact.status || "").toUpperCase()) ||
    contact.outboundState === "OPTED_OUT" || contact.outboundLabel === "DO_NOT_CONTACT";
  const reason = config.error ? describeError(config.error).detail : config.data?.reason;

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["ai-voice-config"] }),
      queryClient.invalidateQueries({ queryKey: ["calls"] }),
    ]);
  };
  const start = async () => {
    setBusy(true);
    try {
      request.current ??= {
        requestId: crypto.randomUUID(), contactId: contact.id, contactType: contact.type,
        permission, consentEvidence: evidence.trim(),
      };
      const result = await api.aiCalls.start(request.current);
      setLatest(result);
      setOpen(false);
      if (result.state === "UNKNOWN") {
        toastError("Call initiation is uncertain", result.error || "Wait for Telnyx events before trying another call.");
      } else {
        success(result.active ? "AI call requested" : "Previous call recovered", result.active
          ? "The call continues if you close this page."
          : "The previous request has already finished. No new call was placed.");
      }
      await refresh();
    } catch (error) {
      toastError("AI call not confirmed", describeError(error).detail);
      await refresh();
    } finally {
      setBusy(false);
    }
  };
  const approve = async () => {
    setBusy(true);
    try {
      request.current ??= {
        requestId: crypto.randomUUID(), contactId: contact.id, contactType: contact.type,
        permission, consentEvidence: evidence.trim(),
      };
      await api.aiCalls.approveQueue(request.current);
      setOpen(false);
      success("Contact approved for AI queue", "If a daily goal is enabled and automation is not paused, the agent can call during UK business hours.");
      await queryClient.invalidateQueries({ queryKey: ["ai-automation"] });
    } catch (error) {
      toastError("Queue approval not confirmed", describeError(error).detail);
    } finally { setBusy(false); }
  };
  const stop = async () => {
    if (!call) return;
    setStopping(true);
    try {
      const result = await api.aiCalls.stop(call.id);
      queryClient.setQueryData(["ai-voice-call", call.id], result.call);
      setLatest(result.call);
      success(result.stopping ? "End call requested" : "AI call ended", result.stopping
        ? "Telnyx is still reporting a live call. Its status will refresh automatically."
        : "Telnyx confirmed the call ended. The number has been released.");
      await queryClient.invalidateQueries({ queryKey: ["ai-voice-call", call.id] });
      await refresh();
    } catch (error) {
      toastError("Could not end AI call", describeError(error).detail);
    } finally {
      setStopping(false);
    }
  };

  return (
    <section className="space-y-2 border border-[var(--ods-border)] rounded-[8px] p-3">
      <p className="text-[13px] font-semibold">AI discovery call</p>
      <p className="text-[12px] text-[var(--ods-text-secondary)]">
        Telnyx discusses requirements and offers a free meeting with Matthew. UK test numbers or explicitly consented leads only.
      </p>
      {reason && <p className="text-[12px] text-[var(--ods-text-secondary)]">{reason}</p>}
      {blocked && <p className="text-[12px]" role="alert">This contact has opted out. Calling is blocked.</p>}
      {call && (
        <div className="text-[12px] space-y-1" role="status">
          <p>AI call: {call.state.toLowerCase()}{call.contactId !== contact.id ? " (another contact)" : ""}</p>
          {call.error && <p>{call.error}</p>}
          {call.meetingAt && <p>Meeting: {new Date(call.meetingAt).toLocaleString()}</p>}
          {call.meetingUrl && <a className="ods-link" href={call.meetingUrl} target="_blank" rel="noreferrer">Open meeting</a>}
        </div>
      )}
      {status.error && <p className="text-[12px]" role="alert">Call status could not be refreshed: {describeError(status.error).detail}</p>}
      {active ? (
        <Button block variant="danger" busy={stopping} onClick={() => void stop()}>End AI call</Button>
      ) : (
        <Button block disabled={!config.data?.ready || !contact.phone || blocked || config.isError} onClick={() => {
          request.current = null;
          setQueueApproval(false);
          setEvidence("");
          setOpen(true);
        }}>Call with AI</Button>
      )}
      <Button block variant="secondary" disabled={!contact.phone || blocked || busy} onClick={() => {
        request.current = null;
        setQueueApproval(true);
        setEvidence("");
        setOpen(true);
      }}>Approve for AI queue</Button>
      <Modal open={open} onClose={() => !busy && setOpen(false)} title={queueApproval ? "Approve automatic AI call" : "Authorise AI call"}>
        <div className="space-y-4">
          <p className="text-[14px]">Call {contact.company || contact.name} on {contact.phone}. The assistant identifies itself as AI. It may book a free meeting, but cannot agree discounts or contracts.</p>
          <label className="block text-[13px] space-y-1">
            <span>Calling permission</span>
            <select className={inputClass} value={permission} disabled={busy || !!request.current} onChange={(event) => setPermission(event.target.value === "consented" ? "consented" : "internal_test")}>
              <option value="internal_test">Internal test number (server allowlist)</option>
              <option value="consented">Explicit consent to an automated AI sales call</option>
            </select>
          </label>
          <label className="block text-[13px] space-y-1">
            <span>Permission evidence (who, when, and how)</span>
            <textarea className={inputClass} value={evidence} maxLength={1000} disabled={busy || !!request.current} onChange={(event) => setEvidence(event.target.value)} />
          </label>
          <p className="text-[12px] text-[var(--ods-text-secondary)]">A public company phone number is not consent. This permission record is saved with the call. Recording is not enabled by this feature.</p>
          {queueApproval && <p className="text-[13px]">This approves one automatic attempt. A configured daily goal starts the approved queue automatically during UK working hours, without this page open. Manage or cancel approvals in Settings → AI Agents.</p>}
          <Button block variant="primary" busy={busy} disabled={evidence.trim().length < 10} onClick={() => void (queueApproval ? approve() : start())}>
            {queueApproval ? (request.current ? "Recover queue approval" : "Approve one automatic attempt") : request.current ? "Recover previous call request" : "Authorise and call"}
          </Button>
        </div>
      </Modal>
    </section>
  );
}
