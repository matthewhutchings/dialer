import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type InboundRoutingConfig } from "@/domains/api/client";
import { useDialer } from "@/domains/dialer/provider";
import { Button } from "@/domains/ui/button";
import { inputClass } from "@/domains/ui/input";
import { describeError } from "@/domains/feedback/describeError";

export function InboundAvailability() {
  const { inboundEnabled, inboundOnline, inboundError, setInboundEnabled } = useDialer();
  return (
    <div className="space-y-2">
      <Button
        variant={inboundEnabled ? "primary" : "secondary"}
        aria-pressed={inboundEnabled}
        onClick={() => setInboundEnabled(!inboundEnabled)}
        title="Inbound calls ring this browser independently of outbound audio"
      >
        Inbound: {inboundOnline ? "Online" : inboundEnabled ? inboundError ? "Unavailable" : "Connecting" : "Offline"}
      </Button>
      {inboundError && <p role="alert" className="text-[13px] text-red-600">{inboundError}</p>}
    </div>
  );
}

function RoutingForm({ config }: { config: InboundRoutingConfig }) {
  const queryClient = useQueryClient();
  const [fallbackPhone, setFallbackPhone] = useState(config.fallbackPhone);
  const [holdAudioUrl, setHoldAudioUrl] = useState(config.holdAudioUrl);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  return (
    <form className="space-y-3" onSubmit={async (event) => {
      event.preventDefault();
      setSaving(true);
      setError(null);
      setSaved(false);
      try {
        const settings = await api.audioSessions.saveInboundConfig({
          fallbackPhone: fallbackPhone.trim(), holdAudioUrl: holdAudioUrl.trim(),
        });
        queryClient.setQueryData(["inbound-routing-config"], { ...config, ...settings });
        setSaved(true);
      } catch (err) {
        setError(describeError(err).detail);
      } finally {
        setSaving(false);
      }
    }}>
      <p className="text-[13px] text-[var(--ods-text-secondary)]">
        {config.aiReceptionistEnabled
          ? `AI reception answers ${config.inboundNumber} first. This private mobile is used only when a caller requests Matthew during UK business hours. Saving changes affects the whole workspace.`
          : `Shared routing for ${config.inboundNumber}. Calls ring online browsers. Only when none are online do they go to this mobile. Saving changes affects the whole workspace.`}
      </p>
      <label className="block text-[13px] font-medium">
        {config.aiReceptionistEnabled ? "Matthew's private transfer mobile" : "Fallback mobile"}
        <input required type="tel" pattern="\+[1-9][0-9]{6,14}" className={`${inputClass} mt-1 w-full`}
          value={fallbackPhone} onChange={(e) => { setFallbackPhone(e.target.value); setSaved(false); }}
          placeholder="+447700900123" />
      </label>
      <label className="block text-[13px] font-medium">
        Hold audio (public HTTPS URL)
        <input required type="url" pattern="https://.*" className={`${inputClass} mt-1 w-full`}
          value={holdAudioUrl} onChange={(e) => { setHoldAudioUrl(e.target.value); setSaved(false); }} />
      </label>
      <Button type="submit" disabled={saving}>{saving ? "Saving..." : "Save inbound routing"}</Button>
      {error && <p role="alert" className="text-[13px] text-red-600">{error}</p>}
      {saved && <p role="status" className="text-[13px] text-emerald-600">Inbound routing saved.</p>}
    </form>
  );
}

export function InboundSettings() {
  const query = useQuery({
    queryKey: ["inbound-routing-config"],
    queryFn: api.audioSessions.inboundConfig,
  });
  return (
    <section className="space-y-4">
      <h3 className="text-[15px] font-semibold">Inbound calls</h3>
      {query.data?.aiReceptionistEnabled && (
        <p role="status" className="text-[13px] text-[var(--ods-text-secondary)]">
          AI reception is enabled: callers can chat, book a free meeting, leave a CRM message,
          or request Matthew Monday to Friday, 9 am to 5 pm UK time, excluding England and Wales
          bank holidays. Matthew must press 1 to accept; unanswered calls return to the AI.
          Browser online/offline does not bypass the AI receptionist.
        </p>
      )}
      <p className="text-[13px] text-[var(--ods-text-secondary)]">
        Start offline after signing in. Go online to receive calls in this browser,
        even if outbound audio uses Call me or Dial in. Going offline does not end an active call.
        Other online browser sessions remain available.
      </p>
      <InboundAvailability />
      {query.isPending && <p role="status">Loading inbound routing...</p>}
      {query.error && (
        <div role="alert">
          <p>{describeError(query.error).detail}</p>
          <Button variant="secondary" onClick={() => void query.refetch()}>Retry</Button>
        </div>
      )}
      {query.data && !query.data.browserAvailable && (
        <p role="alert">Browser inbound routing needs a Telnyx application and SIP destination configured on the server.</p>
      )}
      {query.data && <RoutingForm config={query.data} />}
    </section>
  );
}
