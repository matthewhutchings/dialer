import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright";

test("contact AI controls require permission, preserve request identity and stop without browser audio", { timeout: 60000 }, async (t) => {
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
    if (path === "/api/ai-calls/config") body = { enabled: true, ready: true, reason: null, activeCall };
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
      body = { stopping: true };
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
  assert.deepEqual(errors, []);
});
