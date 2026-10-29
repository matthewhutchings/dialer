import { before, test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import callsRouter from "./index.js";
import { generateToken } from "../../middleware/auth.js";

const request = globalThis.fetch;
const PROSPECT = "11111111-1111-4111-8111-111111111111";

before(() => {
  process.env.JWT_SECRET = "test-only-caller-association-secret-long-enough";
  process.env.TWENTY_BASE_URL = "https://twenty.invalid";
  process.env.TWENTY_API_KEY = "test-only";
});

test("the call update API persists late caller associations and rejects invalid ids", async (t) => {
  const writes: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    writes.push(body);
    return Response.json({ data: { agencyCall: { id: "call", ...body } } });
  });
  const app = express();
  app.use(express.json());
  app.use("/api/calls", callsRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/calls/call`;
  const headers = { Authorization: `Bearer ${generateToken({ userId: "test-agent" })}`, "Content-Type": "application/json" };
  const response = await request(url, {
    method: "PATCH", headers, body: JSON.stringify({ agencyProspectId: PROSPECT, agencyLeadId: null }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(writes, [{ agencyProspectId: PROSPECT, agencyLeadId: null }]);
  const invalid = await request(url, {
    method: "PATCH", headers, body: JSON.stringify({ agencyProspectId: "not-an-id" }),
  });
  assert.equal(invalid.status, 400);
  assert.equal(writes.length, 1);
  const unauthenticated = await request(url, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(unauthenticated.status, 401);
});
