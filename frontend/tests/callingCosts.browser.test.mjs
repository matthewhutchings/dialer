import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright";

test("Calling costs follows Team Activity and reports separate currencies even when Twenty is unavailable", { timeout: 60000 }, async (t) => {
  const cwd = process.cwd();
  process.chdir(fileURLToPath(new URL("../", import.meta.url)));
  t.after(() => process.chdir(cwd));
  const server = await createServer({
    root: fileURLToPath(new URL("../", import.meta.url)),
    server: { host: "127.0.0.1", port: 0 },
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
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  const queries = [];
  let mode = "data";
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("cold-dialer-token", `test.${btoa(JSON.stringify({
      userId: "test", workspaceMemberId: "test-member", email: "agent@example.test", exp: 4102444800,
    }))}.test`);
  });
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (url.pathname === "/api/auth/me") return route.fulfill({ json: {
      id: "test", workspaceMemberId: "test-member", email: "agent@example.test", fullName: "Test Agent",
    } });
    if (url.pathname === "/api/admin/activity") return route.fulfill({ status: 500, json: { error: "Twenty unavailable" } });
    if (url.pathname === "/api/prospects/facets") return route.fulfill({ json: { type: { prospect: 0, lead: 0 }, creator: {} } });
    if (url.pathname === "/api/admin/calling-balance") return route.fulfill({ json: {
      balance: 12.34, availableCredit: 22.34, creditLimit: 10, pending: 0.1234, currency: "USD", fetchedAt: "2026-10-29T12:00:00Z",
    } });
    if (url.pathname === "/api/admin/calling-costs") {
      queries.push(url.searchParams);
      if (mode === "error") return route.fulfill({ status: 502, json: { error: "Telnyx usage unavailable" } });
      const date = url.searchParams.get("since");
      return route.fulfill({ json: {
        rows: mode === "empty" ? [] : [
          { date, product: "call-control", service: "Voice API", direction: "inbound", currency: "USD", cost: 0.0032 },
          { date, product: "sip-trunking", service: "SIP / PSTN", direction: "outbound", currency: "USD", cost: 0.0068 },
          { date, product: "sip-trunking", service: "SIP / PSTN", direction: "outbound", currency: "GBP", cost: 0.02 },
        ],
        services: [{ product: "call-control", label: "Voice API" }, { product: "sip-trunking", label: "SIP / PSTN" }],
        fetchedAt: "2026-10-29T12:00:00Z", timezone: "UTC",
      } });
    }
    return route.fulfill({ json: [] });
  });
  await page.goto(`http://127.0.0.1:${address.port}/admin`);
  await page.getByRole("tab", { name: "Calling costs", exact: true }).click();
  const labels = await page.getByRole("tab").allTextContents();
  assert(labels.findIndex((text) => text.includes("Calling costs")) === labels.findIndex((text) => text.includes("Team Activity")) + 1);
  const usd = page.getByRole("region", { name: "USD calling costs" });
  const gbp = page.getByRole("region", { name: "GBP calling costs" });
  await usd.waitFor();
  await gbp.waitFor();
  assert.match(await page.locator("body").innerText(), /USD\s*12\.3400/);
  assert.match(await usd.innerText(), /USD\s*0\.0100/);
  assert.match(await usd.innerText(), /USD\s*0\.0032/);
  assert.match(await gbp.innerText(), /GBP\s*0\.0200/);
  assert.equal(queries.length, 1);
  assert.match(queries[0].get("since"), /^\d{4}-\d{2}-\d{2}$/);
  assert.match(queries[0].get("until"), /^\d{4}-\d{2}-\d{2}$/);
  assert.match(await page.locator("body").innerText(), /not just this dialer/);
  mode = "empty";
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByText("No calling usage reported by Telnyx", { exact: false }).waitFor();
  mode = "error";
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "Could not load calling costs" }).waitFor();
  assert.equal(await usd.count(), 0);
  assert.match(await page.locator("body").innerText(), /USD\s*12\.3400/);
  assert.deepEqual(errors, []);
});
