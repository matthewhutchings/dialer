import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright";

test("call review shows native tasks, sync failures, retries and saved Twenty status", { timeout: 60000 }, async (t) => {
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
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("cold-dialer-token", `test.${btoa(JSON.stringify({
      userId: "test", workspaceMemberId: "test-member", email: "agent@example.test", exp: 4102444800,
    }))}.test`);
  });
  const call = {
    id: "11111111-1111-4111-8111-111111111111", status: "GOOD_NUMBER", direction: "OUTBOUND",
    created_at: "2026-10-30T11:01:00Z", createdBy: { name: "Test Agent" },
    transcript: "Please send the details to office@example.test. I will forward them.",
    aiSummary: "Agreed to send information.", aiAnalyzedAt: "2026-10-30T11:03:00Z",
    aiScore: 72, durationSeconds: 73,
  };
  let tasks = [];
  let syncFailure = false;
  let readFailure = false;
  let emptyAnalysis = false;
  const task = {
    id: "task-1", title: "Send Tech and AI information to Vanessa",
    description: "Send the agreed details to office@example.test.", status: "TODO",
    dueAt: "2026-10-31T09:00:00Z", assigneeId: "test-member",
    contacts: [{ type: "prospect", id: "contact-1" }],
  };
  const syncError = "The AI review was saved, but follow-up tasks could not all be saved in Twenty. Check the linked tasks and re-analyze to retry.";
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith("/api/")) return route.continue();
    let body = [];
    if (path === "/api/auth/me") body = { id: "test", workspaceMemberId: "test-member", email: "agent@example.test", fullName: "Test Agent" };
    if (path === "/api/prospects/facets") body = { type: { prospect: 0, lead: 0 }, creator: 0 };
    if (path === "/api/admin/activity") body = { activities: [], members: {}, totalCount: 0, truncated: false };
    if (path === `/api/calls/${call.id}`) body = call;
    if (path === "/api/calls") body = [call];
    if (path === "/api/twenty/meta/agencyProspects") body = { baseUrl: "https://crm.example.test" };
    if (path === `/api/calls/${call.id}/tasks`) {
      if (readFailure) return route.fulfill({ status: 502, json: { error: "Task access denied" } });
      body = tasks;
    }
    if (path === `/api/calls/${call.id}/analyze`) {
      if (!syncFailure && !emptyAnalysis) tasks = [{ ...task }];
      body = {
        ok: !syncFailure, call,
        analysis: { tasks: emptyAnalysis ? [] : [task] },
        taskSync: { created: syncFailure ? null : emptyAnalysis ? 0 : 1, error: syncFailure ? syncError : null },
      };
    }
    await route.fulfill({ json: body });
  });
  await page.goto(`http://127.0.0.1:${address.port}/history/${call.id}`);
  const panel = page.getByRole("region", { name: "Follow-up tasks", exact: true });
  const analyze = panel.getByRole("button", { name: "Re-analyze & sync tasks", exact: true });
  await panel.getByText(/No tasks are linked/).waitFor({ timeout: 10000 }).catch(async (err) => {
    console.error({ errors, body: await page.locator("body").innerText() });
    throw err;
  });
  syncFailure = true;
  await analyze.click();
  await panel.getByRole("alert").filter({ hasText: syncError }).waitFor();
  assert(await page.getByText("Review saved; task sync incomplete", { exact: true }).isVisible());
  syncFailure = false;
  await analyze.click();
  const taskLink = panel.getByRole("link", { name: task.title, exact: true });
  await taskLink.waitFor();
  assert.equal(await taskLink.getAttribute("href"), "https://crm.example.test/object/task/task-1");
  assert.equal(await panel.getByRole("link", { name: "Open linked contact", exact: true }).getAttribute("href"), "/contacts/contact-1");
  assert(await panel.getByText(task.description, { exact: true }).isVisible());
  assert.match(await panel.innerText(), /To do.*Due.*Assigned in Twenty/);
  assert.equal(await panel.getByRole("alert").count(), 0);
  for (const tab of ["AI Review", "Activity", "Overview"]) {
    await page.getByRole("tab", { name: tab, exact: true }).click();
    await panel.getByRole("link", { name: task.title, exact: true }).waitFor();
  }
  tasks[0].status = "DONE";
  await page.reload();
  await panel.getByText(/DONE.*Due/).waitFor();
  readFailure = true;
  await page.reload();
  await panel.getByRole("alert").filter({ hasText: "Task access denied" }).waitFor();
  assert.equal(await panel.getByText(/No tasks are linked/).count(), 0);
  readFailure = false;
  await panel.getByRole("button", { name: "Retry tasks", exact: true }).click();
  await panel.getByRole("link", { name: task.title, exact: true }).waitFor();
  tasks = [];
  emptyAnalysis = true;
  await analyze.click();
  await page.getByText("The AI review is ready. No explicitly agreed follow-up tasks were found.", { exact: true }).waitFor();
  await panel.getByText(/No tasks are linked/).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await analyze.scrollIntoViewIfNeeded();
  assert(await analyze.isVisible());
  call.transcript = "";
  call.transcriptionStatus = "FAILED";
  await page.reload();
  await panel.waitFor();
  assert.equal(await panel.getByRole("button", { name: /analyze/i }).count(), 0);
  await page.getByRole("tab", { name: "Recording", exact: true }).click();
  await page.getByText(/Transcription failed or its result is uncertain/).waitFor();
  call.transcriptionStatus = "PENDING";
  call.telnyxRecordingId = "recording-test";
  await page.goto(`http://127.0.0.1:${address.port}/history/${call.id}?tab=recording`);
  await page.getByText(/Waiting for the single Telnyx Whisper transcription/).waitFor();
  assert.deepEqual(errors, []);
});
