export interface LinkedNote {
  id: string;
  title?: string | null;
  bodyV2?: { markdown?: string | null; blocknote?: string | null } | null;
  createdAt?: string | null;
  createdBy?: { name?: string | null } | null;
}

function blockText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(blockText).join("");
  if (!value || typeof value !== "object") return "";
  if ("text" in value && typeof value.text === "string") return value.text;
  const content = "content" in value ? blockText(value.content) : "";
  const children = "children" in value ? blockText(value.children) : "";
  return `${content}${children ? `\n${children}` : ""}\n`;
}

type Block = { type?: string; props?: { url?: unknown; name?: unknown } };

function isImage(block: Block): block is Block & { props: { url: string } } {
  return block?.type === "image" && typeof block.props?.url === "string" && /^https:\/\//.test(block.props.url);
}

// Twenty re-signs BlockNote image URLs on every read; the markdown copy keeps a token that expires
// after 24h, so notes with images are rebuilt from BlockNote.
function blocksWithImages(blocks: Block[]): string {
  return blocks
    .map((block) => {
      if (!isImage(block)) return blockText(block).trim();
      const alt = String(block.props.name ?? "image").replace(/[[\]\\]/g, "");
      return `![${alt}](<${block.props.url.replace(/[<>]/g, encodeURIComponent)}>)`;
    })
    .filter(Boolean)
    .join("\n\n");
}

export function mapLinkedNote(note: LinkedNote) {
  let body = note.bodyV2?.markdown;
  if (note.bodyV2?.blocknote) {
    const blocks: unknown = JSON.parse(note.bodyV2.blocknote);
    if (Array.isArray(blocks) && blocks.some(isImage)) body = blocksWithImages(blocks);
    else if (body == null) body = blockText(blocks).trim();
  }
  return {
    id: note.id,
    title: note.title || "Untitled note",
    body: body ?? "",
    at: note.createdAt ?? null,
    author: note.createdBy?.name ?? null,
  };
}

export function noteTargetField(type: unknown): string | null {
  return type === "prospect" ? "targetAgencyProspectId" : type === "lead" ? "targetAgencyLeadId" : null;
}
