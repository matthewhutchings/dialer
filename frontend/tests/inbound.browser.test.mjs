import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright";

const company = {
  id: "11111111-1111-4111-8111-111111111111",
  type: "prospect",
  name: "Example Ltd",
  company: "Example Ltd",
  email: "hello@example.test",
  jobTitle: null,
  prospectId: "11111111-1111-4111-8111-111111111111",
  leadId: null,
  country: "GB",
  campaignId: null,
};

test("inbound availability, caller details, navigation and late CRM association", { timeout: 60000 }, async (t) => {
  const cwd = process.cwd();
  process.chdir(fileURLToPath(new URL("../", import.meta.url)));
  t.after(() => process.chdir(cwd));
  const server = await createServer({
    root: fileURLToPath(new URL("../", import.meta.url)),
    server: { host: "127.0.0.1", port: 0, strictPort: false },
    define: {
      "import.meta.env.VITE_API_URL": JSON.stringify(""),
      "import.meta.env.VITE_SIP_URI": JSON.stringify("sip:test@example.invalid"),
      "import.meta.env.VITE_SIP_PASSWORD": JSON.stringify("test-only"),
      "import.meta.env.VITE_SIP_WS_URL": JSON.stringify("wss://example.invalid"),
    },
  });
  t.after(() => server.close());
  await server.listen();
  const address = server.httpServer.address();
  assert(address && typeof address !== "string");
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  const presence = [];
  const calls = [];
  let matches = [company];
  let lookupFailure = false;
  let delayLookup = false;
  let releaseLookup;
  page.on("pageerror", (err) => errors.push(err.message));
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("cold-dialer-token", `test.${btoa(JSON.stringify({
      userId: "test", workspaceMemberId: "test-member", email: "agent@example.test", exp: 4102444800,
    }))}.test`);
    localStorage.setItem("audio-source", JSON.stringify("call_me"));
  });
  await page.route("**/src/domains/dialer/sip/sipSession.ts*", (route) => route.fulfill({
    contentType: "application/javascript",
    body: `
      export async function startAgent(handlers) {
        window.__sipHandlers = handlers;
        return { ua: {}, registerer: {}, domain: 'example.invalid', stop: async () => {} };
      }
      export async function loadSip() {
        return { SessionState: { Established: 'Established', Terminated: 'Terminated' } };
      }
      export async function getMicStream() { return new MediaStream(); }
      export function attachRemoteMedia() {}
      export function sendSessionDtmf() {}
    `,
  }));
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (!path.startsWith("/api/")) return route.continue();
    let body = [];
    if (path === "/api/auth/me") body = {
      id: "test", workspaceMemberId: "test-member", email: "agent@example.test", fullName: "Test Agent",
    };
    if (path === "/api/audio-sessions/inbound-config") body = {
      inboundNumber: "+441234567890", fallbackPhone: "+447700900456",
      holdAudioUrl: "https://example.test/hold.mp3", browserAvailable: true,
    };
    if (path === "/api/audio-sessions/config") body = { callMeAvailable: true, dialInAvailable: true };
    if (path === "/api/audio-sessions/presence") {
      presence.push(request.postDataJSON());
      return route.fulfill({ status: 204 });
    }
    if (path === "/api/twenty/phones") body = [{ id: "line", phoneNumber: "+441234567890", callState: "IDLE" }];
    if (path === "/api/contacts/caller") {
      if (delayLookup) await new Promise((resolve) => { releaseLookup = resolve; });
      return route.fulfill(lookupFailure
        ? { status: 502, json: { error: "CRM lookup unavailable" } } : { json: { matches } });
    }
    if (path.startsWith("/api/calls") && request.method() !== "GET") {
      calls.push({ path, body: request.postDataJSON() });
      body = { id: "test-call" };
    }
    if (path === "/api/prospects/facets") body = {
      total: 0, type: { prospect: 0, lead: 0 }, status: {}, country: {}, industry: {}, campaign: {}, creator: 0,
    };
    if (path === "/api/prospects/ids") body = { ids: [], truncated: false };
    await route.fulfill({ json: body });
  });
  const invite = (number = "+447700900123") => page.evaluate((number) => {
    const listeners = [];
    window.__testSession = {
      request: { getHeader: (name) => name === "X-Dialer-Original-Caller" ? number : undefined },
      remoteIdentity: { uri: { user: "+441234567890" } },
      stateChange: { addListener: (fn) => listeners.push(fn) },
      accept: async () => { window.__accepted = true; listeners.forEach((fn) => fn("Established")); },
      reject: async () => { window.__rejected = true; listeners.forEach((fn) => fn("Terminated")); },
      bye: async () => listeners.forEach((fn) => fn("Terminated")),
    };
    window.__sipHandlers.onInvite(window.__testSession);
  }, number);
  const button = (name) => page.getByRole("button", { name, exact: true });

  await page.goto(`http://127.0.0.1:${address.port}/settings?tab=inbound`);
  await button("Save inbound routing").waitFor();
  assert.equal(await page.evaluate(() => !!window.__sipHandlers), false);
  assert.equal(presence.some((p) => p.registered), false);
  await button("Inbound: Offline").first().click();
  await page.waitForFunction(() => !!window.__sipHandlers);
  assert.equal(await button("Inbound: Online").count(), 0);
  await page.evaluate(() => window.__sipHandlers.onRegistered(true));
  await button("Inbound: Online").first().waitFor();
  assert(presence.some((p) => p.registered));
  assert.equal(await page.evaluate(() => localStorage.getItem("audio-source")), '"call_me"');

  await invite();
  await button("Open prospect record").waitFor();
  assert(await page.getByText("hello@example.test", { exact: true }).isVisible());
  await button("Open prospect record").click();
  assert(page.url().endsWith(`/contacts/${company.id}`));
  assert(await button("Accept").isVisible());
  await button("Decline").click();

  matches = [company, { ...company, id: "other", name: "Another company" }];
  await invite();
  await page.getByText("Multiple records share this number. Call not automatically linked.", { exact: true }).waitFor();
  assert.equal(await button("Open prospect record").count(), 2);
  await button("Decline").click();
  matches = [];
  await invite();
  await page.getByText("No matching CRM record", { exact: true }).waitFor();
  await button("Decline").click();
  await invite("anonymous");
  await page.getByText("Withheld caller", { exact: true }).waitFor();
  await page.getByText("Caller number unavailable for CRM matching", { exact: true }).waitFor();
  await button("Decline").click();

  lookupFailure = true;
  await invite();
  await page.getByText(/CRM lookup unavailable/).waitFor();
  assert(await button("Accept").isVisible());
  await button("Decline").click();
  lookupFailure = false;
  matches = [company];
  delayLookup = true;
  await invite();
  await page.getByText("Looking up caller in CRM...", { exact: true }).waitFor();
  await button("Accept").click();
  await page.waitForFunction(() => window.__accepted === true);
  assert(releaseLookup);
  const association = page.waitForRequest((request) =>
    request.method() === "PATCH" && request.postDataJSON()?.agencyProspectId === company.id);
  releaseLookup();
  await association;
  await button("Open prospect record").waitFor();
  assert(calls.some((call) => call.body.agencyProspectId === company.id));
  await button("Inbound: Online").first().click();
  await button("Inbound: Offline").first().waitFor();
  assert.equal(presence.at(-1).registered, false);
  const dockToggle = page.locator("[data-dialer-toggle]");
  if (await dockToggle.getAttribute("aria-pressed") !== "true") await dockToggle.click();
  assert(await page.getByText("Inbound · Connected", { exact: true }).isVisible(), await page.locator("body").innerText());
  await page.getByRole("link", { name: "Dialer", exact: true }).click();
  const workspace = page.getByRole("region", { name: "Call workspace" });
  await workspace.getByText("Connected", { exact: true }).waitFor();
  assert(await workspace.getByRole("button", { name: "End call", exact: true }).isVisible());
  await workspace.getByRole("button", { name: "End call", exact: true }).click();
  await workspace.getByText("Call ended", { exact: true }).waitFor();
  assert(await workspace.getByRole("button", { name: "No Answer", exact: true }).isVisible());
  assert.deepEqual(errors, []);
});
