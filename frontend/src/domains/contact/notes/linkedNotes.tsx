import { Markdown } from "@/domains/ui/markdown";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/domains/api/client";
import { Button } from "@/domains/ui/button";

export function useLinkedNotes(contact: { id: string; type: "prospect" | "lead" }) {
  return useQuery({
    queryKey: ["linked-notes", contact.type, contact.id],
    queryFn: () => api.notes.list(contact.type, contact.id),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

export function LinkedNotes({ contact }: { contact: { id: string; type: "prospect" | "lead" } }) {
  const { data: notes, isLoading, error, refetch } = useLinkedNotes(contact);
  return (
    <section className="space-y-2" aria-label="Linked Twenty notes">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[13px] font-semibold">Linked Twenty notes{notes ? ` (${notes.length})` : ""}</h3>
        <Button size="sm" variant="ghost" onClick={() => void refetch()}>Refresh</Button>
      </div>
      {isLoading && <p role="status" className="text-[13px]">Loading linked notes...</p>}
      {error && <p role="alert" className="text-[13px] text-red-600">Linked notes could not be loaded: {error.message}</p>}
      {!isLoading && !error && !notes?.length && <p className="text-[12px] text-[var(--ods-text-tertiary)]">No separate notes linked to this contact.</p>}
      {notes?.map((note) => (
        <article key={note.id} className="rounded-[8px] border border-[var(--ods-border)] p-3 space-y-1">
          <h4 className="text-[13px] font-semibold">{note.title}</h4>
          <p className="text-[12px] text-[var(--ods-text-tertiary)]">
            {[note.author, note.at ? new Date(note.at).toLocaleString() : null].filter(Boolean).join(" · ")}
          </p>
          <Markdown className="text-[13px]">{note.body}</Markdown>
        </article>
      ))}
    </section>
  );
}
