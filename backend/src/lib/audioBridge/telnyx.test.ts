import { test } from "node:test";
import assert from "node:assert/strict";
import { inboundCallerHeaders } from "./telnyx.js";
import { encodeState, handleIncomingCall, type IncomingCallDeps } from "./index.js";

test("the actual inbound SIP dial state carries the original caller header", async () => {
  let headers: ReturnType<typeof inboundCallerHeaders> = [];
  const deps: IncomingCallDeps = {
    store: { list: async () => [] },
    calls: {
      answer: async () => {},
      playback: async () => {},
      stopPlayback: async () => {},
      dial: async (params) => {
        headers = inboundCallerHeaders(params);
        return "browser-leg";
      },
    },
    now: () => new Date(),
  };
  await handleIncomingCall("call.answered", {
    call_control_id: "caller-leg",
    client_state: encodeState({
      kind: "inbound", sessionId: "caller-leg", target: "sip:agent@sip.telnyx.com",
      callerNumber: "+447716427509",
    }),
  }, {
    inboundNumber: "+441202161024", fallbackPhone: "+447716427509",
    agentSipUri: "sip:agent@sip.telnyx.com", holdAudioUrl: "https://example.test/hold.mp3",
  }, deps);
  assert.deepEqual(headers, [{ name: "X-Dialer-Original-Caller", value: "+447716427509" }]);
});

test("missing and invalid caller numbers are explicitly withheld on browser legs", () => {
  for (const callerNumber of [undefined, "anonymous", "invalid\r\nheader"]) {
    assert.deepEqual(inboundCallerHeaders({
      to: "sip:agent@sip.telnyx.com", state: { kind: "inbound_agent" }, callerNumber,
    }), [{ name: "X-Dialer-Original-Caller", value: "anonymous" }]);
  }
});

test("mobile fallback and unrelated outbound calls never receive inbound identity headers", () => {
  assert.deepEqual(inboundCallerHeaders({
    to: "+447716427509", state: { kind: "inbound_fallback" }, callerNumber: "+447700900123",
  }), []);
  assert.deepEqual(inboundCallerHeaders({
    to: "sip:agent@sip.telnyx.com", state: { kind: "agent" }, callerNumber: "+447700900123",
  }), []);
});
