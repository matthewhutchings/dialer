import { useMemo, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { BookOpen, Edit3, Plus, Users } from "@/domains/ui/icons";
import { Button } from "@/domains/ui/button";
import { Card } from "@/domains/ui/card";
import { Input } from "@/domains/ui/input";
import { Modal } from "@/domains/ui/modal";
import { StatusBadge } from "@/domains/ui/status";
import { useToast } from "@/domains/ui/toast";
import { describeError } from "@/domains/feedback/describeError";
import { useContactFacets } from "@/domains/contact/list";
import { useScripts } from "@/domains/scripts/data";
import { useCampaigns, useCreateCampaign, useUpdateCampaign, type Campaign } from "../data/useCampaigns";

const TYPES = [
  { value: "outbound", label: "Outbound" },
  { value: "inbound", label: "Inbound" },
  { value: "blended", label: "Blended" },
  { value: "referral", label: "Referral" },
  { value: "cold-call", label: "Cold call" },
  { value: "website", label: "Website" },
  { value: "other", label: "Other" },
];

type CampaignDraft = { id?: string; name: string; type: string; status: Campaign["status"] };

function typeLabel(value: string) {
  return TYPES.find((type) => type.value === value)?.label ?? value;
}

export function CampaignsPage() {
  const navigate = useNavigate();
  const { success, error: toastError } = useToast();
  const campaignsQuery = useCampaigns();
  const scriptsQuery = useScripts();
  const facetsQuery = useContactFacets();
  const create = useCreateCampaign();
  const update = useUpdateCampaign();
  const [draft, setDraft] = useState<CampaignDraft | null>(null);

  const campaigns = campaignsQuery.data ?? [];
  const scriptsByCampaign = useMemo(() => {
    const counts = new Map<string, number>();
    for (const script of scriptsQuery.data ?? []) {
      if (script.campaignId) counts.set(script.campaignId, (counts.get(script.campaignId) ?? 0) + 1);
    }
    return counts;
  }, [scriptsQuery.data]);

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!draft?.name.trim()) return;
    try {
      if (draft.id) {
        await update.mutateAsync({ id: draft.id, name: draft.name.trim(), type: draft.type, status: draft.status });
      } else {
        await create.mutateAsync({ name: draft.name.trim(), type: draft.type, status: draft.status, settings: null });
      }
      success(draft.id ? "Campaign updated" : "Campaign created", `${draft.name.trim()} is ready to use.`);
      setDraft(null);
    } catch (err) {
      toastError("Campaign not saved", describeError(err).detail);
    }
  };

  return (
    <div className="flex flex-col h-full min-h-0 bg-[var(--ods-bg-primary)]">
      <header className="flex flex-wrap items-center justify-between gap-3 px-6 py-5 border-b border-[var(--ods-border)]">
        <div>
          <h1 className="text-xl font-semibold text-[var(--ods-text-primary)]">Campaigns</h1>
          <p className="mt-1 text-[13px] text-[var(--ods-text-secondary)]">
            Group contacts and connect the call script agents should use.
          </p>
        </div>
        <Button variant="primary" icon={Plus} onClick={() => setDraft({ name: "", type: "outbound", status: "active" })}>
          New campaign
        </Button>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto p-6">
        {(scriptsQuery.error || facetsQuery.error) && (
          <p role="status" className="mb-4 text-[13px] text-amber-700">
            Campaign usage counts may be incomplete.
            {scriptsQuery.error && ` Scripts: ${describeError(scriptsQuery.error).detail}`}
            {facetsQuery.error && ` Contacts: ${describeError(facetsQuery.error).detail}`}
          </p>
        )}
        {campaignsQuery.isLoading ? (
          <p className="text-sm text-[var(--ods-text-secondary)]">Loading campaigns…</p>
        ) : campaignsQuery.error ? (
          <Card>
            <p className="text-sm text-red-600">Campaigns could not be loaded: {describeError(campaignsQuery.error).detail}</p>
          </Card>
        ) : campaigns.length === 0 ? (
          <Card className="max-w-2xl">
            <div className="flex items-start gap-3">
              <BookOpen className="mt-1 h-5 w-5 text-[var(--ods-brand-600)]" />
              <div>
                <h2 className="font-semibold text-[var(--ods-text-primary)]">Start with a campaign</h2>
                <p className="mt-1 text-sm text-[var(--ods-text-secondary)]">
                  Create a campaign, link a script to it, then assign contacts from the Contacts page.
                </p>
                <Button className="mt-4" variant="primary" icon={Plus} onClick={() => setDraft({ name: "", type: "outbound", status: "active" })}>
                  Create campaign
                </Button>
              </div>
            </div>
          </Card>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {campaigns.map((campaign) => {
              const scriptCount = scriptsByCampaign.get(campaign.id) ?? 0;
              const contactCount = facetsQuery.data?.campaign?.[campaign.id];
              return (
                <Card key={campaign.id} className="flex flex-col">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h2 className="truncate text-base font-semibold text-[var(--ods-text-primary)]">{campaign.name}</h2>
                      <p className="mt-1 text-[13px] text-[var(--ods-text-secondary)]">{typeLabel(campaign.type)}</p>
                    </div>
                    <StatusBadge status={campaign.status} />
                  </div>
                  <div className="mt-5 flex flex-wrap gap-4 text-[13px] text-[var(--ods-text-secondary)]">
                    <span className="inline-flex items-center gap-1.5"><Users className="h-3.5 w-3.5" />{contactCount ?? (facetsQuery.isLoading ? "…" : "—")} contacts</span>
                    <span className="inline-flex items-center gap-1.5"><BookOpen className="h-3.5 w-3.5" />{scriptsQuery.isLoading ? "…" : scriptsQuery.error ? "—" : scriptCount} {scriptCount === 1 ? "script" : "scripts"}</span>
                  </div>
                  <div className="mt-5 flex items-center justify-between border-t border-[var(--ods-border)] pt-3">
                    <Button variant="ghost" size="sm" icon={Edit3} onClick={() => setDraft({ id: campaign.id, name: campaign.name, type: campaign.type, status: campaign.status })}>
                      Edit
                    </Button>
                    <Button variant="secondary" size="sm" onClick={() => navigate("/scripts")}>
                      {scriptCount ? "Manage scripts" : "Add a script"}
                    </Button>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </main>

      <Modal
        open={draft !== null}
        onClose={() => setDraft(null)}
        title={draft?.id ? "Edit campaign" : "New campaign"}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setDraft(null)}>Cancel</Button>
            <Button variant="primary" type="submit" form="campaign-form" busy={create.isPending || update.isPending} busyLabel="Saving…">
              Save campaign
            </Button>
          </div>
        }
      >
        {draft && (
          <form id="campaign-form" className="space-y-4" onSubmit={save}>
            <Input
              label="Campaign name"
              autoFocus
              required
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              placeholder="e.g. Spring outbound"
            />
            <label className="block text-[14px] font-medium text-[var(--ods-text-primary)]">
              Campaign type
              <select
                className="mt-1 block w-full rounded-[8px] border border-[var(--ods-border-strong)] bg-[var(--ods-bg-primary)] px-3 py-2 text-[14px]"
                value={draft.type}
                onChange={(event) => setDraft({ ...draft, type: event.target.value })}
              >
                {TYPES.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
              </select>
            </label>
            <label className="block text-[14px] font-medium text-[var(--ods-text-primary)]">
              Status
              <select
                className="mt-1 block w-full rounded-[8px] border border-[var(--ods-border-strong)] bg-[var(--ods-bg-primary)] px-3 py-2 text-[14px]"
                value={draft.status}
                onChange={(event) => setDraft({ ...draft, status: event.target.value as Campaign["status"] })}
              >
                <option value="active">Active</option>
                <option value="paused">Paused</option>
                <option value="draft">Draft</option>
              </select>
            </label>
          </form>
        )}
      </Modal>
    </div>
  );
}
