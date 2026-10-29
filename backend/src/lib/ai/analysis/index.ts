import { createLogger } from "../../logger/index.js";
import type { AiSentiment, CallAnalysis, FollowUpTask } from "./types.js";

export type { AiSentiment, CallAnalysis, CallQualityScores, FollowUpTask } from "./types.js";

const log = createLogger('ai-analysis');

const SENTIMENTS: AiSentiment[] = ["POSITIVE", "NEUTRAL", "NEGATIVE", "MIXED"];

function normalizeSentiment(raw: unknown): AiSentiment {
  const s = String(raw ?? "").trim().toUpperCase();
  return (SENTIMENTS as string[]).includes(s) ? (s as AiSentiment) : "NEUTRAL";
}

function clamp(n: unknown, min: number, max: number, fallback: number): number {
  const v = typeof n === "string" ? Number(n) : (n as number);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

function clampInt(n: unknown, min: number, max: number, fallback: number): number {
  return Math.round(clamp(n, min, max, fallback));
}

/** Single AI key (OpenAI-compatible). Any base URL works — OpenAI default. */
export function aiConfig(): { apiKey: string; baseUrl: string; model: string } {
  return {
    apiKey: process.env.OPENAI_API_KEY || "",
    baseUrl: (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, ""),
    model: process.env.OPENAI_ANALYSIS_MODEL || "gpt-4o-mini",
  };
}

export function isAiConfigured(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}

const SYSTEM_PROMPT = [
  "You analyze cold-call transcripts for a sales dialer.",
  "Reply with JSON only, no markdown, no commentary:",
  '{"summary": string (1-2 sentences), "sentiment": "POSITIVE"|"NEUTRAL"|"NEGATIVE"|"MIXED",',
  '"score": number 0-100 (how well the call went / how the prospect felt),',
  '"scores": {"conversion": 1-5 (conversion probability), "politeness": 1-5 (agent politeness and rapport),',
  '"questioning": 1-5 (questioning effectiveness), "engagement": 1-5 (contact engagement), "sentiment": 1-5 (prospect sentiment)},',
  '"keyPoints": string[] (max 5 short bullets),',
  '"tasks": [{"title": string (imperative, max 80 chars), "description": string (one sentence of context), "due": "YYYY-MM-DD" or null}] (max 5),',
  '"confidence": number 0-1}.',
  "Tasks are only follow-ups explicitly agreed or requested on the call (send info, call back, book a meeting, prepare a quote).",
  "Set due only when a day or date was stated or clearly implied, resolved against today's date. Never invent tasks: return [] when nothing was agreed.",
  "Sentiment reflects the PROSPECT, not the agent. Score <40 = bad, 40-69 = neutral, 70+ = good.",
].join(" ");

/** Validates model-proposed tasks: trimmed, capped, and a due date only when it is a real, not-long-past day. */
export function normalizeTasks(raw: unknown, now = new Date()): FollowUpTask[] {
  if (!Array.isArray(raw)) return [];
  const out: FollowUpTask[] = [];
  for (const item of raw) {
    const title = String((item as any)?.title ?? "").trim().slice(0, 120);
    if (!title) continue;
    const description = String((item as any)?.description ?? "").trim().slice(0, 1000);
    const due = String((item as any)?.due ?? "").trim();
    let dueAt: string | null = null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(due)) {
      const d = new Date(`${due}T09:00:00.000Z`);
      if (!Number.isNaN(d.getTime()) && d.getTime() > now.getTime() - 86_400_000 && d.getTime() < now.getTime() + 366 * 86_400_000) dueAt = d.toISOString();
    }
    out.push({ title, description, dueAt });
    if (out.length === 5) break;
  }
  return out;
}

/** Strip code fences in case the model wraps the JSON anyway. */
function extractJson(text: string): string {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = (fence ? fence[1] : text).trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  return start >= 0 && end > start ? raw.slice(start, end + 1) : raw;
}

/**
 * Analyze one call transcript with a single OpenAI-compatible key.
 * Works against OpenAI or any compatible gateway (base URL override).
 * Throws when unconfigured or when the provider call fails — callers
 * decide whether to surface (manual /analyze) or swallow (webhook).
 */
export async function analyzeCallTranscript(
  transcript: string,
  meta?: { direction?: string | null; durationSeconds?: number | null },
): Promise<CallAnalysis> {
  const { apiKey, baseUrl, model } = aiConfig();
  if (!apiKey) throw new Error("OPENAI_API_KEY not configured");
  const clean = transcript.trim().slice(0, 12_000);
  if (clean.length < 10) throw new Error("Transcript too short to analyze");

  const user = [
    `Direction: ${meta?.direction || "unknown"}.`,
    `Today: ${new Date().toISOString().slice(0, 10)}.`,
    typeof meta?.durationSeconds === "number" ? `Duration: ${meta.durationSeconds}s.` : null,
    "Transcript:",
    clean,
  ].filter(Boolean).join("\n");

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_tokens: 900,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`AI provider ${res.status}: ${body.slice(0, 200)}`);
  }
  const json: any = await res.json();
  const content: string = json?.choices?.[0]?.message?.content ?? "";
  let parsed: any;
  try {
    parsed = JSON.parse(extractJson(content));
  } catch {
    throw new Error("AI provider returned non-JSON analysis");
  }

  const summary = String(parsed?.summary ?? "").trim().slice(0, 1000) || "No summary returned.";
  const keyPoints = Array.isArray(parsed?.keyPoints)
    ? parsed.keyPoints.map((k: unknown) => String(k).trim()).filter(Boolean).slice(0, 5)
    : [];
  const rawScores = (parsed?.scores ?? {}) as Record<string, unknown>;
  // Fall back to the overall score mapped onto 1-5 when the model omits parts.
  const fallback15 = Math.min(5, Math.max(1, Math.round(clamp(parsed?.score, 0, 100, 50) / 20)));
  const result: CallAnalysis = {
    summary,
    sentiment: normalizeSentiment(parsed?.sentiment),
    score: Math.round(clamp(parsed?.score, 0, 100, 50)),
    scores: {
      conversion: clampInt(rawScores.conversion, 1, 5, fallback15),
      politeness: clampInt(rawScores.politeness, 1, 5, fallback15),
      questioning: clampInt(rawScores.questioning, 1, 5, fallback15),
      engagement: clampInt(rawScores.engagement, 1, 5, fallback15),
      sentiment: clampInt(rawScores.sentiment, 1, 5, fallback15),
    },
    keyPoints,
    tasks: normalizeTasks(parsed?.tasks),
    confidence: clamp(parsed?.confidence, 0, 1, 0.5),
    model,
  };
  log.info(`Analyzed call transcript (${clean.length} chars): sentiment=${result.sentiment} score=${result.score}`);
  return result;
}
