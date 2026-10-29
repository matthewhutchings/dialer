import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright";

test("AI controls preserve permission and named AI reports stay separate from the human operator", { timeout: 60000 }, async (t) => {
  const cwd = process.cwd();
  process.chdir(fileURLToPath(new URL("../", import.meta.url)));
  t.after(() => process.chdir(cwd));
  const server = await createServer({
    root: fileURLToPath(new URL("../", import.meta.url)),
    server: { host: "127.0.0.1", port: 0 },
    define: {
      "import.meta.env.VITE_API_URL": JSON.stringify(""),
      "import.meta.env.VITE_SIP_URI": JSON.stringify(""),
      "import.meta.env.VITE_SIP_PASSWORD": JSON.stringify(""),
    },
  });
  t.after(() => server.close());
  await server.listen();
  const address = server.httpServer.address();
  assert(address && typeof address !== "string");
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const id = "11111111-1111-4111-8111-111111111111";
  const starts = [];
  let activeCall = null;
  let stopped = false;
  let agentName = "Fewzen AI";
  let agentSettings = {
    inboundEnabled: true, outboundEnabled: true, inboundGuidance: "", outboundGuidance: "",
    goalMode: "off", dailyCallGoal: 10, dailyBookingGoal: 10, paused: false,
  };
  const queue = [];
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("cold-dialer-token", `test.${btoa(JSON.stringify({
      userId: "test", workspaceMemberId: "test-member", email: "agent@example.test", exp: 4102444800,
    }))}.test`);
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (!path.startsWith("/api/")) return route.continue();
    let body = [];
    if (path === "/api/auth/me") body = { id: "test", workspaceMemberId: "test-member", fullName: "Test Agent" };
    if (path === `/api/prospects/${id}`) body = {
      id, first_name: "Fictional", last_name: "Company", company: "Fictional Company",
      phone: "+442079460456", status: "new", country: "GB",
    };
    if (path === "/api/prospects/facets") body = { total: 0, type: {}, status: {}, country: {}, industry: {}, campaign: {} };
    if (path === "/api/audio-sessions/config") body = { callMeAvailable: false, dialInAvailable: false };
    if (path === "/api/audio-sessions/inbound-config") body = {
      inboundNumber: "+442079460123", fallbackPhone: "+447700900123",
      holdAudioUrl: "https://example.test/hold.mp3", browserAvailable: true, aiReceptionistEnabled: true,
    };
    if (path === "/api/ai-calls/config") body = { enabled: true, ready: true, reason: null, activeCall };
    if (path === "/api/ai-calls/settings") {
      if (request.method() === "PUT") agentSettings = request.postDataJSON();
      body = agentSettings;
    }
    if (path === "/api/ai-calls/automation") body = {
      schemaReady: true, schedulerConfigured: true, schedulerStalled: false, settings: agentSettings,
      day: "2026-10-29", calls: 1, bookings: 0, target: agentSettings.goalMode === "calls" ? agentSettings.dailyCallGoal : agentSettings.goalMode === "bookings" ? agentSettings.dailyBookingGoal : null,
      goalReached: false, queue, activeCall: activeCall?.active ? activeCall : null,
      lastRun: { checkedAt: "2026-10-29T12:00:00Z", status: "goal_off", detail: "Choose a daily goal." },
    };
    if (path === "/api/ai-calls/queue" && request.method() === "POST") {
      const approval = request.postDataJSON();
      body = { ...approval, id: approval.requestId, name: "Fictional Company", phone: "+442079460456", approvedByMemberId: "test-member", approvedByName: "Test Agent", state: "QUEUED", callId: null, error: null, createdAt: "2026-10-29T12:00:00Z" };
      queue.push(body);
    }
    if (path.startsWith("/api/ai-calls/queue/") && path.endsWith("/cancel")) {
      body = queue.find((entry) => path.includes(entry.id));
      body.state = "CANCELLED";
    }
    if (path === "/api/ai-calls/profile") {
      if (request.method() === "PUT") agentName = request.postDataJSON().name;
      body = { name: agentName };
    }
    if (path === "/api/calls") body = [
      { id: "human-call", direction: "OUTBOUND", status: "COMPLETED", durationSeconds: 120, startedAt: new Date().toISOString(), created_at: new Date().toISOString(), createdBy: { name: "Test Agent" }, isAiVoice: false },
      { id: "ai-call", direction: "OUTBOUND", status: "APPOINTMENT_SET", durationSeconds: 180, startedAt: new Date().toISOString(), created_at: new Date().toISOString(), createdBy: { name: "Test Agent" }, isAiVoice: true },
    ];
    if (path === "/api/ai-calls" && request.method() === "POST") {
      starts.push(request.postDataJSON());
      if (starts.length === 1) return route.fulfill({ status: 502, json: { error: "Call initiation uncertain. Recover the previous request." } });
      activeCall = { id: "test-ai-call", contactId: id, contactType: "prospect", state: "DIALING", active: true, error: null, meetingAt: null, meetingUrl: null };
      body = activeCall;
    }
    if (path === "/api/ai-calls/test-ai-call") body = activeCall;
    if (path === "/api/ai-calls/test-ai-call/stop") {
      stopped = true;
      activeCall = { ...activeCall, state: "ENDED", active: false };
      body = { stopping: false, call: activeCall };
    }
    return route.fulfill({ json: body });
  });
  await page.goto(`http://127.0.0.1:${address.port}/contacts/${id}`);
  const trigger = page.getByRole("button", { name: "Call with AI", exact: true });
  try {
    await trigger.waitFor();
  } catch (error) {
    console.error("Browser state:", page.url(), await page.locator("body").innerText(), errors);
    throw error;
  }
  await trigger.click();
  const authorise = page.getByRole("button", { name: "Authorise and call", exact: true });
  assert(await authorise.isDisabled());
  await page.getByLabel("Calling permission").selectOption("consented");
  await page.getByLabel("Permission evidence (who, when, and how)").fill("Prospect explicitly requested an automated AI call today.");
  await authorise.click();
  await page.getByRole("button", { name: "Recover previous call request", exact: true }).click();
  await page.getByRole("button", { name: "End AI call", exact: true }).waitFor();
  assert.equal(starts.length, 2);
  assert.deepEqual(starts[0], starts[1]);
  assert.equal(starts[0].permission, "consented");
  await page.getByRole("button", { name: "End AI call", exact: true }).click();
  await trigger.waitFor();
  assert.equal(stopped, true);
  await page.getByText("Telnyx confirmed the call ended. The number has been released.", { exact: true }).waitFor();
  assert.equal(await page.getByText("Waiting for Telnyx to confirm the call has ended.", { exact: true }).count(), 0);
  await page.getByRole("button", { name: "Approve for AI queue", exact: true }).click();
  await page.getByLabel("Calling permission").selectOption("consented");
  await page.getByLabel("Permission evidence (who, when, and how)").fill("Prospect gave explicit permission for one automatic AI call.");
  await page.getByRole("button", { name: "Approve one automatic attempt", exact: true }).click();
  await page.getByText("Contact approved for AI queue", { exact: true }).waitFor();
  assert.equal(queue.length, 1);
  assert.equal(starts.length, 2, "queue approval must not immediately dial");
  await page.goto(`http://127.0.0.1:${address.port}/settings?tab=ai`);
  await page.getByRole("tab", { name: "AI Agents", exact: true }).waitFor();
  try {
    await page.getByLabel("Goal mode", { exact: true }).selectOption("bookings", { timeout: 10000 });
  } catch (error) {
    console.error("AI settings browser state:", await page.locator("body").innerText(), errors);
    throw error;
  }
  await page.getByLabel("Daily booking goal", { exact: true }).fill("10");
  await page.getByLabel("Inbound business guidance", { exact: true }).fill("Explain our automation services and offer the four inbound options.");
  await page.getByLabel("Outbound business guidance", { exact: true }).fill("Ask one focused question about manual reporting.");
  await page.getByText("Booking mode has no separate daily call cap.", { exact: false }).waitFor();
  await page.getByRole("button", { name: "Save AI controls", exact: true }).click();
  await page.getByText("AI controls updated for the team.", { exact: true }).waitFor();
  assert.equal(agentSettings.goalMode, "bookings");
  assert.equal(agentSettings.dailyBookingGoal, 10);
  await page.reload();
  assert.equal(await page.getByLabel("Goal mode", { exact: true }).inputValue(), "bookings");
  assert.equal(await page.getByLabel("Outbound business guidance", { exact: true }).inputValue(), "Ask one focused question about manual reporting.");
  await page.getByRole("button", { name: "Pause automation", exact: true }).click();
  await page.getByRole("button", { name: "Resume automation", exact: true }).waitFor();
  assert.equal(agentSettings.paused, true);
  assert.equal(agentSettings.inboundEnabled, true);
  await page.getByRole("button", { name: "Cancel approval", exact: true }).click();
  await page.getByText("cancelled · +442079460456", { exact: true }).waitFor();
  assert.equal(queue[0].state, "CANCELLED");
  await page.goto(`http://127.0.0.1:${address.port}/settings?tab=reports`);
  const nameInput = page.getByLabel("AI agent name", { exact: true });
  await nameInput.fill("Discovery Scout");
  await page.getByRole("button", { name: "Save AI agent name", exact: true }).click();
  await page.getByText("AI agent name saved for the team.", { exact: true }).waitFor();
  assert.equal(agentName, "Discovery Scout");
  await page.reload();
  await nameInput.waitFor();
  assert.equal(await nameInput.inputValue(), "Discovery Scout");
  await page.goto(`http://127.0.0.1:${address.port}/reports`);
  await page.getByRole("tab", { name: "Team Performance", exact: true }).click();
  const aiRow = page.getByRole("row").filter({ has: page.getByRole("cell", { name: "Discovery Scout (AI)", exact: true }) });
  const humanRow = page.getByRole("row").filter({ has: page.getByRole("cell", { name: "Test Agent", exact: true }) });
  await aiRow.waitFor();
  await humanRow.waitFor();
  assert.equal(await aiRow.getByRole("cell").nth(1).innerText(), "1");
  assert.equal(await humanRow.getByRole("cell").nth(1).innerText(), "1");
  assert.equal(await aiRow.getByRole("cell").last().innerText(), "1");
  assert.equal(await humanRow.getByRole("cell").last().innerText(), "0");
  await page.goto(`http://127.0.0.1:${address.port}/settings?tab=inbound`);
  await page.getByText(/AI reception is enabled: callers can chat/).waitFor();
  await page.getByLabel("Matthew's private transfer mobile", { exact: true }).waitFor();
  assert.deepEqual(errors, []);
});
