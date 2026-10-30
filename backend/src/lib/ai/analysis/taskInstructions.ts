import type { FollowUpTask } from "./types.js";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error(`AI task ${field} must be non-empty text of at most ${max} characters.`);
  }
  return value.trim();
}

function lines(value: unknown, field: string, max: number): string[] {
  if (!Array.isArray(value) || !value.length || value.length > max) {
    throw new Error(`AI task ${field} must contain 1-${max} items.`);
  }
  return value.map((item) => text(item, field, 500));
}

const sourceText = (value: string) => value.toLowerCase().replace(/\s+/g, " ").trim();
const emailText = (value: string) => sourceText(value)
  .replace(/\s+(?:at sign|at)\s+/g, "@")
  .replace(/\s+(?:dot|full stop)\s+/g, ".")
  .replace(/\s*@\s*/g, "@");

/** Render model facts into a stable execution brief; never invent missing inputs. */
export function taskInstructions(value: unknown, transcript: string): FollowUpTask {
  const task = record(value);
  const title = text(task.title, "title", 120);
  if (/^(?:follow[- ]?up|send (?:info(?:rmation)?|details)|contact (?:the )?prospect)[.!]?$/i.test(title)) {
    throw new Error("AI task title must identify the action, specific deliverable and recipient.");
  }
  const objective = text(task.objective, "objective", 500);
  const recipient = record(task.recipient);
  const name = recipient.name === null ? null : text(recipient.name, "recipient name", 150);
  const email = recipient.email === null ? null : text(recipient.email, "recipient email", 254);
  const steps = lines(task.steps, "steps", 8);
  const completion = lines(task.completionCriteria, "completion criteria", 5);
  const evidence = lines(task.evidence, "evidence", 5);
  const missing = task.missingInformation;
  if (!Array.isArray(missing) || missing.length > 8) throw new Error("AI task missingInformation must be an array of at most 8 items.");
  const blockers = missing.map((item) => text(item, "missing information", 500));
  const source = sourceText(transcript);
  for (const quote of evidence) {
    if (!source.includes(sourceText(quote))) throw new Error("AI task evidence does not match the call transcript.");
  }
  const mentionedEmails = [title, objective, ...steps, ...completion, ...blockers].join("\n").match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) ?? [];
  for (const address of new Set([...(email ? [email] : []), ...mentionedEmails])) {
    const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address);
    const escaped = address.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const exactAddress = new RegExp(`(^|[^a-z0-9._%+@-])${escaped}(?![a-z0-9_%+@-]|\\.[a-z0-9])`, "i");
    if (!valid || !exactAddress.test(emailText(evidence.join("\n")))) {
      throw new Error("AI task recipient email is not confirmed by its transcript evidence.");
    }
  }
  // Imperative procedural steps use short sentences. Proper names and email addresses remain unchanged.
  for (const step of [...steps, ...completion]) {
    if (step.split(/\s+/).length > 20) throw new Error("AI task instructions must use at most 20 words per item.");
  }
  const description = [
    "## Objective", objective,
    "## Recipient", `Name: ${name ?? "Not stated in the call."}`, `Email: ${email ?? "Not confirmed. Check the call before you send email."}`,
    "## Procedure", ...steps.map((step, index) => `${index + 1}. ${step}`),
    "## Completion criteria", ...completion.map((item) => `- ${item}`),
    "## Call evidence", ...evidence.map((quote) => `> ${quote}`),
    "## Missing information", ...(blockers.length ? blockers.map((item) => `- ${item}`) : ["None reported."]),
    "## Execution control",
    "Check the source records and the call evidence before you act.",
    "Do not guess missing information. Ask the task owner if a required input is missing.",
    "This task does not grant permission to send messages or use external tools. Check the execution policy first.",
  ].join("\n\n");
  return { title, description, dueAt: null };
}
