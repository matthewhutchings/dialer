import { Router } from "express";
import { authMiddleware, AuthRequest } from "../../middleware/auth.js";
import { listTwentyAll, createTwenty, updateTwenty, getTwenty } from "../../lib/twenty/client/index.js";
import { resolveActor } from "../../lib/twenty/actor/index.js";
import { telnyxClient, telnyxErrorMessage } from "../../lib/telnyx/index.js";
import { analyzeCallTranscript, isAiConfigured } from "../../lib/ai/analysis/index.js";
import { listCallTasks, repairCallTaskLinks, syncFollowUpTasks } from "../../lib/ai/analysis/followUpTasks.js";
import { transcribeRecording } from "../../lib/ai/analysis/transcribeRecording.js";
import { analyzeSavedTranscript } from "../../lib/ai/analysis/analyzeSavedTranscript.js";
import { createLogger } from "../../lib/logger/index.js";
import type { AgencyCall } from "./types.js";
import { mapCall, sortNewestFirst, splitStatus } from "./helpers/index.js";
import { callResultMachine } from "@dialer/shared";
import { forgetLastCalls } from "../../lib/twenty/lastCall/index.js";

const router = Router();
router.use(authMiddleware);

const log = createLogger('calls');

// GET /api/calls — newest first. The walk returns calls in id order, and
// Twenty ids are random UUIDs, so reversing it was not time order: today's
// calls landed mid-list and Recents / Call History never showed them.
router.get("/", async (_req, res) => {
  try {
    const calls = await listTwentyAll<AgencyCall>('agencyCalls');
    res.json(sortNewestFirst(calls.map(mapCall)));
  } catch (err: any) {
    log.error("Failed to fetch calls:", err.message);
    res.status(500).json({ error: "Failed to fetch calls", details: err.message });
  }
});

// GET /api/calls/:id
router.get("/:id", async (req, res) => {
  try {
    const call = await getTwenty<AgencyCall>('agencyCalls', req.params.id as string);
    res.json(mapCall(call));
  } catch (err: any) {
    res.status(404).json({ error: "Call not found" });
  }
});

router.get("/:id/tasks", async (req, res) => {
  try {
    await getTwenty<AgencyCall>("agencyCalls", req.params.id as string);
    res.json(await listCallTasks(req.params.id as string));
  } catch (err) {
    log.error("Failed to load call tasks:", err instanceof Error ? err.message : String(err));
    res.status(502).json({ error: "Could not load follow-up tasks from Twenty. Please try again." });
  }
});

// GET /api/calls/:id/audio — redirect to a fresh Telnyx mp3.
// Telnyx download URLs expire (~10 min), so playback always re-resolves here.
// The API key never leaves the server.
// ?format=json returns { url } instead of redirecting: an <audio> element
// cannot send the Bearer token this router requires, so the player asks for
// the URL with fetch and then plays it directly.
router.get("/:id/audio", async (req, res) => {
  try {
    const call = await getTwenty<AgencyCall>('agencyCalls', req.params.id as string);
    if (!call.telnyxRecordingId) {
      res.status(404).json({ error: "No Telnyx recording for this call yet" });
      return;
    }
    let tx;
    try {
      tx = telnyxClient();
    } catch (err: any) {
      res.status(500).json({ error: err.message });
      return;
    }
    let retrieved: any;
    try {
      retrieved = await tx.recordings.retrieve(call.telnyxRecordingId);
    } catch (err: any) {
      const message = telnyxErrorMessage(err);
      log.info(`Telnyx recording lookup failed: ${message}`);
      const authFailed = /401|authentication failed/i.test(message);
      res.status(502).json({
        error: authFailed
          ? "Telnyx rejected the server's API key (check TELNYX_API_KEY)"
          : "Telnyx could not find this recording",
      });
      return;
    }
    const url = retrieved?.data?.download_urls?.mp3 || retrieved?.data?.download_urls?.wav;
    if (!url) {
      res.status(404).json({ error: "Recording has no download URL yet" });
      return;
    }
    if (req.query.format === "json") {
      res.json({ url });
      return;
    }
    res.redirect(url);
  } catch (err: any) {
    log.error("Failed to resolve call audio:", err.message);
    res.status(500).json({ error: "Failed to resolve call audio", details: err.message });
  }
});

// POST /api/calls/:id/record — record only; recording.saved starts one Whisper pass.
// for the live call. Plain SIP-trunked calls are NOT auto-recorded; this is
// what creates the recording object that later arrives via call.recording.saved.
router.post("/:id/record", async (req, res) => {
  try {
    const call = await getTwenty<AgencyCall>('agencyCalls', req.params.id as string);
    if (!call.telnyxCallId) {
      res.status(400).json({ error: "Call has no telnyxCallId yet (not answered?)" });
      return;
    }
    let tx;
    try {
      tx = telnyxClient();
    } catch (err: any) {
      res.status(500).json({ error: err.message });
      return;
    }
    let started: any;
    try {
      started = await tx.calls.actions.startRecording(call.telnyxCallId, {
        format: "mp3",
        channels: "dual",
        transcription: false,
      });
    } catch (err: any) {
      log.info(`Telnyx record_start failed: ${telnyxErrorMessage(err)}`);
      res.status(502).json({ error: "Telnyx record_start failed", details: telnyxErrorMessage(err) });
      return;
    }
    const recordingId: string | null =
      started?.data?.recording_id || started?.data?.id || null;
    if (recordingId) {
      try {
        await updateTwenty<AgencyCall>('agencyCalls', call.id, {
          telnyxRecordingId: recordingId,
          transcriptionStatus: "PENDING",
        });
      } catch (err: any) {
        log.info(`Could not stamp telnyxRecordingId: ${err.message}`);
      }
    }
    log.info(`Server recording started: call=${call.id} rec=${recordingId || "?"}`);
    res.json({ ok: true, telnyxRecordingId: recordingId });
  } catch (err: any) {
    log.error("Failed to start server recording:", err.message);
    res.status(500).json({ error: "Failed to start server recording", details: err.message });
  }
});

// POST /api/calls/:id/reconcile — Telnyx-side fallback: when the browser never
// captured a call-control-id, find the call's recording by from/to/connection
// + time window and attach it. Returns { attached: boolean }.
router.post("/:id/reconcile", async (req, res) => {
  try {
    const call = await getTwenty<AgencyCall>('agencyCalls', req.params.id as string);
    if (call.telnyxRecordingId) {
      const text = await transcribeRecording(call.id);
      if (text) await analyzeSavedTranscript(call.id, text, call);
      res.json({ attached: true, already: true });
      return;
    }
    let tx;
    try {
      tx = telnyxClient();
    } catch (err: any) {
      res.status(500).json({ error: err.message });
      return;
    }
    const since = new Date(new Date(call.createdAt || Date.now()).getTime() - 15 * 60_000).toISOString();
    let items: any[] = [];
    try {
      const page: any = await tx.recordings.list({
        filter: {
          ...(call.fromNumber ? { from: call.fromNumber } : {}),
          ...(call.toNumber ? { to: call.toNumber } : {}),
        },
      } as any);
      items = page?.data ?? [];
    } catch (err: any) {
      res.status(502).json({ error: "Telnyx recordings lookup failed", details: telnyxErrorMessage(err) });
      return;
    }
    const match = items.find((rec: any) =>
      rec?.status === "completed" && (!rec?.created_at || rec.created_at >= since)
    );
    if (!match) {
      res.json({ attached: false });
      return;
    }
    const patch: Record<string, unknown> = {
      telnyxRecordingId: match.id,
      transcriptionStatus: call.transcript?.trim() ? "READY" : "PENDING",
    };
    if (match?.download_urls?.mp3) patch.recordingUrl = match.download_urls.mp3;
    else if (match?.download_urls?.wav) patch.recordingUrl = match.download_urls.wav;
    if (match?.call_control_id) patch.telnyxCallId = match.call_control_id;
    await updateTwenty<AgencyCall>('agencyCalls', call.id, patch);
    const text = await transcribeRecording(call.id);
    if (text) await analyzeSavedTranscript(call.id, text, call);
    const updated = await getTwenty<AgencyCall>('agencyCalls', call.id);
    log.info(`Reconciled recording: call=${call.id} rec=${match.id}`);
    res.json({ attached: true, telnyxRecordingId: match.id, call: mapCall(updated) });
  } catch (err: any) {
    log.error("Failed to reconcile recording:", err.message);
    res.status(500).json({ error: "Failed to reconcile recording", details: err.message });
  }
});

// POST /api/calls — log a finished call (recording arrives later via Telnyx webhook)
router.post("/", async (req: AuthRequest, res) => {
  try {
    const {
      direction, status, disposition, notes, fromNumber, toNumber, startedAt, endedAt,
      durationSeconds, telnyxCallId, telnyxRecordingId, recordingUrl,
      transcript, transcriptionStatus, summary,
      aiSummary, aiSentiment, aiScore, aiKeyPoints, aiScores, aiConfidence, aiModel, aiAnalyzedAt,
      agencyPhoneId, agencyProspectId, agencyLeadId,
    } = req.body as Partial<AgencyCall>;

    if (!toNumber) {
      res.status(400).json({ error: "toNumber is required" });
      return;
    }

    const split = splitStatus(status || "COMPLETED");
    const payload: Record<string, unknown> = {
      name: `${direction || "OUTBOUND"} ${toNumber} ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
      direction: direction || "OUTBOUND",
      status: split.status,
      fromNumber: fromNumber || "",
      toNumber,
      durationSeconds: durationSeconds ?? 0,
    };
    // Own-field member attribution (queryable UUID next to the system Actor).
    // Omitted for legacy/fallback sessions without a resolved member.
    if (req.workspaceMemberId) payload.createdByMemberId = req.workspaceMemberId;
    if (disposition || split.disposition) payload.disposition = disposition || split.disposition;
    if (notes) payload.notes = notes;
    if (startedAt) payload.startedAt = startedAt;
    if (endedAt) payload.endedAt = endedAt;
    if (telnyxCallId) payload.telnyxCallId = telnyxCallId;
    if (telnyxRecordingId) payload.telnyxRecordingId = telnyxRecordingId;
    if (recordingUrl) payload.recordingUrl = recordingUrl;
    if (transcript) payload.transcript = transcript;
    if (transcriptionStatus) payload.transcriptionStatus = transcriptionStatus;
    if (summary) payload.summary = summary;
    if (aiSummary) payload.aiSummary = aiSummary;
    if (aiSentiment) payload.aiSentiment = aiSentiment;
    if (typeof aiScore === "number") payload.aiScore = aiScore;
    if (aiKeyPoints) payload.aiKeyPoints = aiKeyPoints;
    if (aiScores) payload.aiScores = aiScores;
    if (typeof aiConfidence === "number") payload.aiConfidence = aiConfidence;
    if (aiModel) payload.aiModel = aiModel;
    if (aiAnalyzedAt) payload.aiAnalyzedAt = aiAnalyzedAt;
    if (agencyPhoneId) payload.agencyPhoneId = agencyPhoneId;
    if (agencyProspectId) payload.agencyProspectId = agencyProspectId;
    if (agencyLeadId) payload.agencyLeadId = agencyLeadId;

    const created = await createTwenty<AgencyCall>('agencyCalls', payload, await resolveActor(req));
    log.info(
      `Call logged: ${created.id} ${payload.direction} ${payload.fromNumber || "?"} -> ${toNumber} ` +
      `status=${payload.status} dur=${payload.durationSeconds}s ` +
      `telnyx=${payload.telnyxCallId || "-"} phone=${payload.agencyPhoneId || "-"} ` +
      `prospect=${payload.agencyProspectId || "-"} lead=${payload.agencyLeadId || "-"}`
    );

    // Point the phone row at its latest call (traceability; claim stays until release)
    if (agencyPhoneId) {
      try {
        await updateTwenty('agencyPhones', agencyPhoneId as string, { currentCallId: created.id });
      } catch (err: any) {
        log.info(`Could not stamp currentCallId: ${err.message}`);
      }
    }

    forgetLastCalls();
    res.status(201).json(mapCall(created));
  } catch (err: any) {
    log.error("Failed to log call:", err.message);
    res.status(500).json({ error: "Failed to log call", details: err.message });
  }
});

// PATCH /api/calls/:id — enrich (webhook: recordingUrl/transcript/meeting link/AI analysis)
router.patch("/:id", async (req, res) => {
  try {
    const allowed = [
      "status", "disposition", "notes", "endedAt", "durationSeconds", "telnyxCallId", "telnyxRecordingId", "recordingUrl",
      "transcript", "transcriptionStatus", "summary", "debugLog",
      "agencyProspectId", "agencyLeadId",
      "meetingUrl", "meetingProvider", "meetingAt", "meetingStatus", "meetingBookingId",
      "aiSummary", "aiSentiment", "aiScore", "aiKeyPoints", "aiScores", "aiConfidence", "aiModel", "aiAnalyzedAt",
    ] as const;
    const patch: Record<string, unknown> = {};
    for (const key of allowed) {
      if (req.body?.[key] !== undefined) patch[key] = req.body[key];
    }
    for (const key of ["agencyProspectId", "agencyLeadId"] as const) {
      if (patch[key] !== undefined && patch[key] !== null &&
        (typeof patch[key] !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(patch[key]))) {
        res.status(400).json({ error: `${key} must be a record id or null` });
        return;
      }
    }
    if (patch.status !== undefined) {
      const split = splitStatus(patch.status);
      patch.status = split.status;
      if (split.disposition && patch.disposition === undefined) patch.disposition = split.disposition;
      // A finished call never goes back to In progress (a late keepalive or
      // retry must not reopen it): drop that one field, keep the rest.
      const current = await getTwenty<AgencyCall>('agencyCalls', req.params.id as string);
      if (!callResultMachine.transition(current.status ?? "IN_PROGRESS", patch.status).ok) {
        log.info(`call ${req.params.id}: ignored status ${current.status} -> ${patch.status}`);
        delete patch.status;
      }
    }
    if (patch.disposition === "") patch.disposition = null;
    if (Object.keys(patch).length === 0) {
      res.status(400).json({ error: "Nothing to update" });
      return;
    }
    const actor = await resolveActor(req);
    const updated = await updateTwenty<AgencyCall>('agencyCalls', req.params.id as string, patch, actor);
    forgetLastCalls();
    if (patch.agencyProspectId !== undefined || patch.agencyLeadId !== undefined) {
      try {
        await repairCallTaskLinks(updated.id);
      } catch (err) {
        log.error("Call contact saved, but task links failed:", err instanceof Error ? err.message : String(err));
        res.status(502).json({ error: "The call contact was saved, but its task links could not be updated. Retry the contact association or re-analyze the call." });
        return;
      }
    }
    res.json(mapCall(updated));
  } catch (err: any) {
    log.error("Failed to update call:", err.message);
    res.status(500).json({ error: "Failed to update call", details: err.message });
  }
});

// POST /api/calls/:id/analyze — run OpenAI-compatible analysis over the
// stored transcript and write the rating back onto the same call row.
// Manual trigger (UI button) and backfill path; the Telnyx transcription
// webhook also calls this best-effort when a transcript lands.
router.post("/:id/analyze", async (req, res) => {
  try {
    if (!isAiConfigured()) {
      res.status(500).json({ error: "OPENAI_API_KEY not configured" });
      return;
    }
    const call = await getTwenty<AgencyCall>('agencyCalls', req.params.id as string);
    if (!call.transcript || call.transcript.trim().length < 10) {
      res.status(400).json({ error: "Call has no transcript to analyze yet" });
      return;
    }
    let analysis;
    try {
      analysis = await analyzeCallTranscript(call.transcript, {
        direction: call.direction,
        durationSeconds: call.durationSeconds,
        startedAt: call.startedAt,
      });
    } catch (err: any) {
      log.info(`AI analysis failed for call=${call.id}: ${err.message}`);
      res.status(502).json({ error: "AI analysis failed", details: String(err.message).slice(0, 200) });
      return;
    }
    const patch: Record<string, unknown> = {
      aiSummary: analysis.summary,
      aiSentiment: analysis.sentiment,
      aiScore: analysis.score,
      aiKeyPoints: JSON.stringify(analysis.keyPoints),
      aiScores: JSON.stringify(analysis.scores),
      aiConfidence: analysis.confidence,
      aiModel: analysis.model,
      aiAnalyzedAt: new Date().toISOString(),
      // Keep legacy summary in sync so old UI surfaces still show something.
      summary: analysis.summary,
    };
    const updated = await updateTwenty<AgencyCall>('agencyCalls', call.id, patch, await resolveActor(req));
    log.info(`AI analysis stored: call=${call.id} sentiment=${analysis.sentiment} score=${analysis.score}`);
    const taskSync = await syncFollowUpTasks(call, analysis.tasks);
    res.json({ ok: !taskSync.error, analysis, call: mapCall(updated), taskSync });
  } catch (err: any) {
    log.error("Failed to analyze call:", err.message);
    res.status(500).json({ error: "Failed to analyze call", details: err.message });
  }
});

export default router;
