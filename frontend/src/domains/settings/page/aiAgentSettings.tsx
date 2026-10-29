import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { AiAgentProfile } from "@dialer/shared";
import { api } from "@/domains/api/client";
import { describeError } from "@/domains/feedback/describeError";
import { AI_AGENT_PROFILE_KEY, useAiAgentProfile } from "@/domains/reports/data";
import { Button } from "@/domains/ui/button";
import { inputClass } from "@/domains/ui/input";

function AgentForm({ profile }: { profile: AiAgentProfile }) {
  const [name, setName] = useState(profile.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const queryClient = useQueryClient();
  return (
    <form className="space-y-3" onSubmit={async (event) => {
      event.preventDefault();
      setSaving(true);
      setError(null);
      setSaved(false);
      try {
        const updated = await api.aiCalls.saveProfile({ name: name.trim() });
        queryClient.setQueryData(AI_AGENT_PROFILE_KEY, updated);
        setSaved(true);
      } catch (err) {
        setError(describeError(err).detail);
      } finally {
        setSaving(false);
      }
    }}>
      <p className="text-[13px] text-[var(--ods-text-secondary)]">
        One shared reporting identity for the team, not a login account. AI calls appear
        separately from humans in Reports, including past AI calls. Renaming does not
        change the human recorded as triggering the call or the spoken introduction.
      </p>
      <label className="block text-[13px] font-medium">
        AI agent name
        <input required maxLength={80} className={`${inputClass} mt-1 w-full`}
          value={name} onChange={(event) => { setName(event.target.value); setSaved(false); }} />
      </label>
      <Button type="submit" disabled={saving || !name.trim()}>{saving ? "Saving..." : "Save AI agent name"}</Button>
      {error && <p role="alert" className="text-[13px] text-red-600">{error}</p>}
      {saved && <p role="status" className="text-[13px] text-emerald-600">AI agent name saved for the team.</p>}
    </form>
  );
}

export function AiAgentSettings() {
  const query = useAiAgentProfile();
  return (
    <section className="space-y-3">
      {query.isPending && <p role="status">Loading AI agent settings...</p>}
      {query.error && <div role="alert">
        <p>{describeError(query.error).detail}</p>
        <Button variant="secondary" onClick={() => void query.refetch()}>Retry</Button>
      </div>}
      {query.data && <AgentForm profile={query.data} />}
    </section>
  );
}
