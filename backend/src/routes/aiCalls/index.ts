import { Router, type Response } from "express";
import { authMiddleware, requireMember, type AuthRequest } from "../../middleware/auth.js";
import { resolveActor } from "../../lib/twenty/actor/index.js";
import { activeVoiceCall, callView, getVoiceCall, reconcileVoiceCall, runVoiceTool, startVoiceCall, stopVoiceCall } from "../../lib/aiVoice/index.js";
import { configurationError, validCallToken, validSetupToken, VoiceError, voiceConfig } from "../../lib/aiVoice/config.js";
import { createLogger } from "../../lib/logger/index.js";
import { verifyVoiceSchema } from "../../lib/aiVoice/locks.js";
import { setupVoiceSchema } from "../../lib/aiVoice/schema.js";
import { telnyxClient } from "../../lib/telnyx/index.js";
import { listTwentyAll } from "../../lib/twenty/client/index.js";
import type { AgencyPhone } from "../twenty/phones/types.js";
import { meetingDetails } from "../../lib/aiVoice/booking.js";

const router = Router();
const log = createLogger("ai-calls");

function failure(res: Response, error: unknown): void {
  const status = error instanceof VoiceError ? error.status : 502;
  const message = error instanceof VoiceError ? error.message : "AI calling could not complete this operation. Check the backend configuration and provider.";
  log.error(message, error instanceof Error ? error.message : "unknown failure");
  res.status(status).json({ error: message });
}

// Remote bootstrap uses deployment-side Twenty credentials. It is additive, authenticated,
// and unavailable once live calling is enabled; no CRM secrets are exported.
router.post("/setup", async (req, res) => {
  try {
    const token = (req.get("Authorization") || "").replace(/^Bearer /, "");
    if (!validSetupToken(token)) {
      res.status(401).json({ error: "Invalid voice setup credential." });
      return;
    }
    if (voiceConfig().enabled) throw new VoiceError(409, "Disable AI calling before schema setup.");
    const problem = configurationError(false);
    if (problem) throw new VoiceError(503, problem);
    await setupVoiceSchema((item) => log.info(`Voice schema ${item.object}.${item.name}: ${item.status}`));
    const config = voiceConfig();
    const client = telnyxClient();
    const app = await client.callControlApplications.retrieve(config.appId);
    const hook = app.data?.webhook_event_url ? new URL(app.data.webhook_event_url) : null;
    if (!hook || hook.origin !== new URL(config.publicUrl).origin ||
        !["/api/webhooks/telnyx", "/api/telnyx-webhook"].includes(hook.pathname) ||
        hook.searchParams.get("token") !== process.env.TELNYX_WEBHOOK_TOKEN) {
      throw new VoiceError(503, "The Telnyx Call Control webhook does not match the backend URL and token.");
    }
    await client.ai.assistants.retrieve(config.assistantId);
    const phones = await listTwentyAll<AgencyPhone>("agencyPhones");
    if (!phones.some((phone) => phone.phoneNumber === config.caller && phone.state === "ACTIVE")) {
      throw new VoiceError(503, "The configured agency caller is not an active Twenty phone.");
    }
    if (!(await meetingDetails()).connected) throw new VoiceError(503, "The booking calendar is not connected.");
    res.json({ schemaReady: true, configurationVerified: true, callingEnabled: false });
  } catch (error) {
    failure(res, error);
  }
});

// Tool callbacks have per-call credentials, not browser JWTs; credentials never appear in tool arguments.
router.post("/tools/:tool", async (req, res) => {
  try {
    const callId = req.get("X-AI-Call-Id") || "";
    const token = (req.get("Authorization") || "").replace(/^Bearer /, "");
    if (!validCallToken(callId, token)) {
      res.status(401).json({ error: "Invalid AI tool credentials." });
      return;
    }
    res.json(await runVoiceTool(callId, String(req.params.tool), req.body || {}));
  } catch (error) {
    failure(res, error);
  }
});

router.use(authMiddleware);
router.get("/config", async (_req, res) => {
  try {
    const reason = configurationError();
    if (!reason) await verifyVoiceSchema();
    res.json({ enabled: voiceConfig().enabled, ready: !reason, reason, activeCall: voiceConfig().enabled ? await activeVoiceCall() : null });
  } catch (error) {
    failure(res, error);
  }
});
router.post("/", async (req: AuthRequest, res) => {
  const member = requireMember(req, res);
  if (!member) return;
  try {
    res.status(202).json(await startVoiceCall(req.body, member.id, await resolveActor(req)));
  } catch (error) {
    failure(res, error);
  }
});
router.get("/:id", async (req, res) => {
  try {
    res.json(callView(await reconcileVoiceCall(await getVoiceCall(String(req.params.id)))));
  } catch (error) {
    failure(res, error);
  }
});
router.post("/:id/stop", async (req: AuthRequest, res) => {
  if (!requireMember(req, res)) return;
  try {
    const call = callView(await stopVoiceCall(await getVoiceCall(String(req.params.id))));
    res.json({ stopping: call.active, call });
  } catch (error) {
    failure(res, error);
  }
});

export default router;
