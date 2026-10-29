import { test } from "node:test";
import assert from "node:assert/strict";
import { incomingCaller } from "./incomingCaller";

test("forwarded inbound calls display the original caller, not the business number", () => {
  assert.deepEqual(incomingCaller({
    request: { getHeader: (name) => name === "X-Dialer-Original-Caller" ? "+447700900123" : undefined },
    remoteIdentity: { uri: { user: "+441234567890" }, displayName: "Business" },
  }), { number: "+447700900123", name: "+447700900123" });
});

test("direct SIP calls and simulations retain their caller identity", () => {
  assert.deepEqual(incomingCaller({
    remoteIdentity: { uri: { user: "+447700900123" }, displayName: "Caller" },
  }), { number: "+447700900123", name: "Caller" });
});

test("invalid forwarding headers do not replace SIP caller identity", () => {
  assert.deepEqual(incomingCaller({
    request: { getHeader: () => "invalid\r\nheader" },
    remoteIdentity: { uri: { user: "123" } },
  }), { number: "123", name: "123" });
});
