import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright";

const companies = [
  { id: "company-1", type: "prospect", company: "Example Ltd", phone: "+441234567890", country: "GB", lastCall: null },
  { id: "company-2", type: "prospect", company: "Next Ltd", phone: "+441234567891", country: "GB", lastCall: null },
];

test("dialer workspace and popup share call controls", { timeout: 60000 }, async (t) => {
  const cwd = process.cwd();
  process.chdir(fileURLToPath(new URL("../", import.meta.url)));
  t.after(() => process.chdir(cwd));
  const server = await createServer({
    root: fileURLToPath(new URL("../", import.meta.url)),
    server: { host: "127.0.0.1", port: 0, strictPort: false },
    define: { "import.meta.env.VITE_API_URL": JSON.stringify("") },
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

  for (const source of ["computer", "call_me"]) {
    await t.test(source, async (t) => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      t.after(() => context.close());
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.addInitScript((source) => {
        localStorage.clear();
        localStorage.setItem("cold-dialer-token", `test.${btoa(JSON.stringify({
          userId: "test", workspaceMemberId: "test-member", email: "agent@example.test", exp: 4102444800,
        }))}.test`);
        localStorage.setItem("audio-source", JSON.stringify(source));
        window.__tones = [];
      }, source);
      await page.route("**/src/domains/dialer/sip/sipSession.ts*", (route) => route.fulfill({
        contentType: "application/javascript",
        body: `
          export async function startAgent() { throw new Error("Simulation must not start SIP"); }
          export async function loadSip() { throw new Error("Simulation must not load SIP"); }
          export async function getMicStream() { throw new Error("Simulation must not use a microphone"); }
          export function attachRemoteMedia() {}
          export function sendSessionDtmf(session, tone) { window.__tones.push(tone); }
        `,
      }));
      await page.route("**/api/**", async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (!path.startsWith("/api/")) return route.continue();
        let body = [];
        if (path === "/api/auth/me") body = {
          id: "test", workspaceMemberId: "test-member", email: "agent@example.test", fullName: "Test Agent",
        };
        if (path === "/api/prospects/ids") body = {
          ids: companies.map(({ id, type }) => ({ id, type })), truncated: false,
        };
        if (path === "/api/prospects/lookup") body = companies;
        if (path === "/api/twenty/phones") body = [
          { id: "line", phoneNumber: "+441234567899", countryCode: "GB", callState: "IDLE" },
        ];
        if (path === "/api/audio-sessions/config") body = { callMeAvailable: true, dialInAvailable: true };
        if (path === "/api/audio-sessions/inbound-config") body = { browserAvailable: false };
        if (path === "/api/prospects/facets") body = {
          total: 2, type: { prospect: 2, lead: 0 }, status: {}, country: {}, industry: {}, campaign: {}, creator: 0,
        };
        await route.fulfill({ json: body });
      });

      await page.goto(`http://127.0.0.1:${address.port}/dialer?simulate=1`);
      const workspace = page.getByRole("region", { name: "Call workspace" });
      const popup = page.getByRole("dialog", { name: "Dialer", exact: true });
      const button = (scope, name) => scope.getByRole("button", { name, exact: true });
      await button(workspace, "Start calling").click();
      await popup.waitFor();
      assert(await button(popup, "Mute").isDisabled());
      assert(await button(popup, "Hold").isDisabled());
      assert(await button(popup, "Keypad").isDisabled());
      await popup.getByTitle("Minimise (the call keeps going)", { exact: true }).click();
      assert(await button(workspace, "Mute").isDisabled());
      assert(await button(workspace, "Hold").isDisabled());
      assert(await button(workspace, "Keypad").isDisabled());
      await workspace.getByText("Connected", { exact: true }).waitFor();

      if (source === "computer") {
        await button(workspace, "Mute").click();
        assert.equal(await button(workspace, "Unmute").getAttribute("aria-pressed"), "true");
        await button(workspace, "Hold").click();
        await workspace.getByText("On hold", { exact: true }).waitFor();
        await button(workspace, "Keypad").click();
        await button(workspace, "1").click();
        await button(workspace, "*").click();
        await button(workspace, "#").click();
        assert.deepEqual(await page.evaluate(() => window.__tones), ["1", "*", "#"]);
        await button(page, "Open call popup").click();
        assert.equal(await button(popup, "Unmute").getAttribute("aria-pressed"), "true");
        assert.equal(await button(popup, "Resume").getAttribute("aria-pressed"), "true");
        await button(popup, "Unmute").click();
        await button(popup, "Resume").click();
        await button(popup, "Keypad").click();
        await button(popup, "2").click();
        assert.deepEqual(await page.evaluate(() => window.__tones), ["1", "*", "#", "2"]);
        await popup.getByTitle("Minimise (the call keeps going)", { exact: true }).click();
        assert.equal(await button(workspace, "Mute").getAttribute("aria-pressed"), "false");
        assert.equal(await button(workspace, "Hold").getAttribute("aria-pressed"), "false");
      } else {
        for (const name of ["Mute", "Hold", "Keypad"]) assert(await button(workspace, name).isDisabled());
        assert(await workspace.getByText("Use your phone to mute, hold or enter keypad digits.").isVisible());
      }

      await button(page, "Stop auto-next").click();
      assert(await button(workspace, "End call").isVisible());
      await page.setViewportSize({ width: 390, height: 844 });
      await button(workspace, "End call").scrollIntoViewIfNeeded();
      const bounds = await button(workspace, "End call").boundingBox();
      assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390 && bounds.y + bounds.height <= 844);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
      await button(workspace, "End call").click();
      await workspace.getByText("Call ended", { exact: true }).waitFor();
      await button(workspace, "No Answer").click();
      await button(workspace, "Start calling").waitFor();
      assert.equal(await popup.count(), 0);

      if (source === "computer") {
        await page.setViewportSize({ width: 1440, height: 900 });
        await button(workspace, "Start calling").click();
        await popup.waitFor();
        await popup.getByText("Connected", { exact: true }).waitFor();
        await button(popup, "End call").click();
        await button(popup, "Interested").click();
        await button(popup, "Save & next").click();
        await workspace.getByRole("heading", { name: "Next Ltd", exact: true }).waitFor();
        await popup.getByText("Next Ltd", { exact: true }).waitFor();
        assert(await button(popup, "End call").isVisible());
        await popup.getByTitle("Minimise (the call keeps going)", { exact: true }).click();
        await button(page, "Stop auto-next").click();
        await button(workspace, "End call").click();
        await workspace.getByText("Call ended", { exact: true }).waitFor();
      }
      assert.deepEqual(errors, []);
    });
  }
});
