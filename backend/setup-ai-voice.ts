import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { assistantConfiguration, ASSISTANT_NAME } from "./src/lib/aiVoice/assistant.js";
import { telnyxClient } from "./src/lib/telnyx/index.js";
import { setupVoiceSchema } from "./src/lib/aiVoice/schema.js";
import { setupToken } from "./src/lib/aiVoice/config.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(root, ".env.local"), quiet: true });

async function main() {
  if (process.argv.includes("--schema")) {
    if (!process.argv.includes("--apply")) throw new Error("Use --schema --apply to add the voice schema. Use --dry-run to inspect.");
    if (process.argv.includes("--remote")) {
      const base = process.env.AI_VOICE_PUBLIC_URL;
      if (!base) throw new Error("Set AI_VOICE_PUBLIC_URL for remote setup.");
      assistantConfiguration(base);
      const response = await fetch(`${base}/api/ai-calls/setup`, {
        method: "POST",
        headers: { Authorization: `Bearer ${setupToken()}` },
        signal: AbortSignal.timeout(240_000),
      });
      const body: unknown = await response.json();
      if (!response.ok || !body || typeof body !== "object" || !("schemaReady" in body) || body.schemaReady !== true) {
        throw new Error(`Remote voice schema setup failed (${response.status}). Check deployment logs; calling remains disabled.`);
      }
    } else {
      await setupVoiceSchema((item) => console.log(`${item.status} ${item.object}.${item.name}${item.note ? `: ${item.note}` : ""}`));
    }
    console.log("Voice schema and unique reservation fields verified.");
    return;
  }
  const base = process.env.AI_VOICE_PUBLIC_URL;
  if (!base) throw new Error("Set AI_VOICE_PUBLIC_URL to the deployed backend HTTPS origin.");
  const definition = assistantConfiguration(base);
  if (!process.argv.includes("--apply")) {
    console.log(JSON.stringify(definition, null, 2));
    console.log("Dry run only. Use --apply to provision the assistant. No calls are placed.");
    return;
  }
  if (!process.env.TELNYX_API_KEY) throw new Error("TELNYX_API_KEY is required for provisioning.");
  if (!process.env.TELNYX_CALL_CONTROL_APP_ID) {
    throw new Error("Configure TELNYX_CALL_CONTROL_APP_ID first using setup-telnyx-call-control.ts.");
  }
  const client = telnyxClient();
  const app = await client.callControlApplications.retrieve(process.env.TELNYX_CALL_CONTROL_APP_ID);
  const actualHook = app.data?.webhook_event_url;
  const hook = actualHook ? new URL(actualHook) : null;
  if (!hook || hook.origin !== new URL(base).origin ||
      !["/api/webhooks/telnyx", "/api/telnyx-webhook"].includes(hook.pathname) ||
      !hook.searchParams.get("token") ||
      (process.env.TELNYX_WEBHOOK_TOKEN && process.env.TELNYX_WEBHOOK_TOKEN !== hook.searchParams.get("token"))) {
    throw new Error("Call Control webhook does not match the deployed AI backend. Update it explicitly before provisioning; this script never repoints existing human calling.");
  }
  const assistants = await client.ai.assistants.list();
  const candidates = assistants.data.filter((assistant) => assistant.name === ASSISTANT_NAME);
  const configuredId = process.env.TELNYX_AI_ASSISTANT_ID;
  if (!configuredId && candidates.length > 1) throw new Error("Multiple Fewzen assistants found. Set TELNYX_AI_ASSISTANT_ID explicitly.");
  const id = configuredId || candidates[0]?.id;
  const assistant = id
    ? await client.ai.assistants.update(id, definition)
    : await client.ai.assistants.create(definition);
  const verified = await client.ai.assistants.retrieve(assistant.id);
  if (verified.name !== ASSISTANT_NAME || verified.instructions !== definition.instructions) {
    throw new Error("Assistant read-back verification failed.");
  }
  console.log(`Assistant ${id ? "updated" : "created"} and verified.`);
  console.log(`TELNYX_AI_ASSISTANT_ID=${assistant.id}`);
  console.log("No numbers reassigned and no phone calls placed. Deploy the backend and schema before enabling AI_VOICE_ENABLED.");
}

main().catch((error: unknown) => {
  // Provider response objects may contain credentials; only print the bounded message.
  console.error("AI voice setup failed:", error instanceof Error ? error.message.slice(0, 300) : "Unknown error");
  process.exitCode = 1;
});
