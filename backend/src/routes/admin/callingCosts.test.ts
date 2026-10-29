import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import Telnyx from "telnyx";
import { CALLING_SERVICES, callingCostRange, loadCallingBalance, loadCallingCosts } from "./callingCosts.js";
import router from "./index.js";
import { generateToken } from "../../middleware/auth.js";

const range = callingCostRange("2026-10-01", "2026-11-01");

test("billing dates are validated and converted to an inclusive Telnyx end", () => {
  assert.equal(range.startDate, "2026-10-01T00:00:00Z");
  assert.equal(range.endDate, "2026-10-31T23:59:59Z");
  for (const [since, until] of [
    [undefined, undefined], ["2026-02-30", "2026-03-01"], ["2026-10-01", "2026-10-01"],
    ["2026-10-02", "2026-10-01"], ["2026-10-01", "2026-11-02"],
    ["2026-10-01T00:00:00Z", "2026-11-01"], [["2026-10-01"], "2026-11-01"],
  ]) assert.throws(() => callingCostRange(since, until), RangeError);
});

function clientWith(fetch: typeof globalThis.fetch) {
  return new Telnyx({ apiKey: "test-only", maxRetries: 0, fetch });
}

test("balance reports current account amounts without inventing missing balances", async () => {
  const result = await loadCallingBalance(clientWith(async (input) => {
    assert.equal(new URL(input instanceof Request ? input.url : String(input)).pathname, "/v2/balance");
    return Response.json({ data: {
      balance: "-1.25", available_credit: "8.75", credit_limit: "10.00", pending: "0.0032", currency: "USD",
    } });
  }));
  assert.equal(result.balance, -1.25);
  assert.equal(result.availableCredit, 8.75);
  assert.equal(result.creditLimit, 10);
  assert.equal(result.pending, 0.0032);
  assert.equal(result.currency, "USD");
  for (const bad of [{ balance: null }, { pending: "" }, { currency: "invalid" }, { available_credit: "no" }]) {
    await assert.rejects(loadCallingBalance(clientWith(async () => Response.json({ data: {
      balance: "1", available_credit: "1", credit_limit: "0", pending: "0", currency: "USD", ...bad,
    } }))), /Invalid Telnyx balance/);
  }
});

test("fetches every service and page without filtering connections, preserving currency, sub-cent costs and credits", async () => {
  const requests: URL[] = [];
  const client = clientWith(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requests.push(url);
    const product = url.searchParams.get("product");
    const page = Number(url.searchParams.get("page[number]"));
    const data = product === "sip-trunking" ? [{
      date: "2026-10-26T00:00:00", cost: page === 1 ? "0.0032" : "-0.0001",
      currency: page === 1 ? "USD" : "GBP", direction: page === 1 ? "outbound" : "inbound",
    }] : product === "call-control-features" ? [{ date: "2026-10-26", cost: 0, currency: "USD" }] : [];
    return Response.json({ data, meta: { page_number: page, total_pages: product === "sip-trunking" ? 2 : 1 } });
  });
  const result = await loadCallingCosts(range, client);
  assert.equal(requests.length, CALLING_SERVICES.length + 1);
  assert.deepEqual(result.rows.map((row) => [row.cost, row.currency, row.direction]).sort(),
    [[0.0032, "USD", "outbound"], [-0.0001, "GBP", "inbound"], [0, "USD", null]].sort());
  assert.equal(result.timezone, "UTC");
  assert.equal(result.services.length, CALLING_SERVICES.length);
  for (const url of requests) {
    assert.equal(url.searchParams.get("start_date"), range.startDate);
    assert.equal(url.searchParams.get("end_date"), range.endDate);
    assert.equal(url.searchParams.has("filter"), false);
    assert.equal(url.searchParams.get("metrics"), "cost");
  }
});

test("missing costs or currencies and invalid reporting dates fail instead of appearing free", async () => {
  for (const bad of [
    { cost: null }, { cost: "" }, { cost: "garbage" }, { cost: Infinity }, { currency: null },
    { date: "2026-09-30" }, { date: "2026-11-01" }, { date: "2026-02-30" }, { direction: null },
  ]) {
    const client = clientWith(async () => Response.json({
      data: [{ date: "2026-10-26", cost: 0.0032, currency: "USD", direction: "inbound", ...bad }],
      meta: { page_number: 1, total_pages: 1 },
    }));
    await assert.rejects(loadCallingCosts(range, client), /Invalid Telnyx cost row/);
  }
});

test("pagination gaps, limits and upstream errors never return partial totals", async () => {
  for (const meta of [{}, { page_number: 2, total_pages: 2 }, { page_number: 1, total_pages: 2 }]) {
    await assert.rejects(loadCallingCosts(range, clientWith(async () => Response.json({ data: [], meta }))), /pagination/);
  }
  await assert.rejects(loadCallingCosts(range, clientWith(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return Response.json({
      data: [{ date: "2026-10-26", cost: 0.01, currency: "USD", direction: "inbound" }],
      meta: { page_number: Number(url.searchParams.get("page[number]")), total_pages: 11 },
    });
  })), /pagination limit/);
  await assert.rejects(loadCallingCosts(range, clientWith(async () => Response.json({
    error: { message: "No usage reporting access" },
  }, { status: 403 }))));
});

test("cost endpoint requires authentication, validates dates and surfaces Telnyx failure", async (t) => {
  process.env.JWT_SECRET = "test-only-calling-costs-secret-long-enough";
  process.env.TELNYX_API_KEY = "test-only";
  const request = globalThis.fetch;
  let upstreamFailure = false;
  let upstreamCalls = 0;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    upstreamCalls++;
    const url = new URL(input instanceof Request ? input.url : String(input));
    return upstreamFailure ? Response.json({ error: "No access" }, { status: 403 }) :
      url.pathname === "/v2/balance" ? Response.json({ data: {
        balance: "5", available_credit: "5", credit_limit: "0", pending: "0", currency: "USD",
      } }) :
      Response.json({ data: [], meta: { page_number: 1, total_pages: 0 } });
  });
  const app = express();
  app.use("/api/admin", router);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/admin/calling-costs`;
  const headers = { Authorization: `Bearer ${generateToken({ userId: "test-agent" })}` };
  assert.equal((await request(url)).status, 401);
  const balanceUrl = url.replace("calling-costs", "calling-balance");
  assert.equal((await request(balanceUrl)).status, 401);
  assert.equal((await request(`${url}?since=2026-02-30&until=2026-03-01`, { headers })).status, 400);
  assert.equal(upstreamCalls, 0);
  const response = await request(`${url}?since=2026-10-01&until=2026-11-01`, { headers });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).rows, []);
  const balanceResponse = await request(balanceUrl, { headers });
  assert.equal(balanceResponse.status, 200);
  assert.equal((await balanceResponse.json()).balance, 5);
  upstreamFailure = true;
  assert.equal((await request(`${url}?since=2026-10-01&until=2026-11-01`, { headers })).status, 502);
  assert.equal((await request(balanceUrl, { headers })).status, 502);
});
