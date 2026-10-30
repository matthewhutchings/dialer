import { analyzeCallTranscript, isAiConfigured } from "./index.js";
import { syncFollowUpTasks } from "./followUpTasks.js";
import { updateTwenty } from "../../twenty/client/index.js";
import { createLogger } from "../../logger/index.js";
import type { AgencyCall } from "../../../routes/calls/types.js";

const log = createLogger("recording-analysis");

export async function analyzeSavedTranscript(callId: string, transcript: string, call: AgencyCall): Promise<void> {
  if (!isAiConfigured()) {
    log.warn(`AI analysis skipped for call=${callId}: OPENAI_API_KEY not configured`);
    return;
  }
  try {
    const analysis = await analyzeCallTranscript(transcript, call);
    await updateTwenty("agencyCalls", callId, {
      aiSummary: analysis.summary,
      aiSentiment: analysis.sentiment,
      aiScore: analysis.score,
      aiKeyPoints: JSON.stringify(analysis.keyPoints),
      aiScores: JSON.stringify(analysis.scores),
      aiConfidence: analysis.confidence,
      aiModel: analysis.model,
      aiAnalyzedAt: new Date().toISOString(),
      summary: analysis.summary,
    });
    await syncFollowUpTasks(call, analysis.tasks);
  } catch (err) {
    log.error(`AI analysis failed for call=${callId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
