import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { assistantConfiguration } from "./assistant.js";
import { callToken, decryptState, encryptState, setupToken, ukNumber, validCallToken, validSetupToken } from "./config.js";
import { ensureCallable, validateCallInput } from "./index.js";

const originalSecret = process.env.AI_VOICE_SECRET;
afterEach(() => {
  if (originalSecret === undefined) delete process.env.AI_VOICE_SECRET;
  else process.env.AI_VOICE_SECRET = originalSecret;
});

test("tool credentials are scoped to one call and encrypted state rejects tampering", () => {
  process.env.AI_VOICE_SECRET = "test-only-voice-secret-with-at-least-32-characters";
  const first = "11111111-1111-4111-8111-111111111111";
  const second = "22222222-2222-4222-8222-222222222222";
  assert.equal(validCallToken(first, callToken(first)), true);
  assert.equal(validCallToken(second, callToken(first)), false);
  assert.equal(validCallToken(first, "bad-token"), false);
  assert.equal(validSetupToken(setupToken()), true);
  assert.equal(validSetupToken(callToken(first)), false);
  assert.equal(validCallToken(first, setupToken()), false);
  const privateData = { manageUrl: "https://booking.example.test/#manage=private", key: "private-retry-key" };
  const encrypted = encryptState(privateData);
  assert.equal(encrypted.includes("private"), false);
  assert.deepEqual(decryptState(encrypted), privateData);
  const parts = encrypted.split(".");
  parts[1] = Buffer.alloc(16).toString("base64url");
  assert.throws(() => decryptState(parts.join(".")));
});

test("calling is UK-only and opt-out representations all block calling", () => {
  assert.equal(ukNumber("020 7946 0456"), "+442079460456");
  assert.throws(() => ukNumber("+12025550123"), /United Kingdom/);
  assert.throws(() => ukNumber("not a number"), /United Kingdom/);
  for (const contact of [
    { coldCallStatus: "DO_NOT_CONTACT" },
    { status: "do_not_contact" },
    { outboundState: { value: "OPTED_OUT" } },
    { outboundLabel: { value: "DO_NOT_CONTACT" } },
  ]) assert.throws(() => ensureCallable(contact), /opted out/);
});

test("calling requires explicit bounded permission evidence and valid references", () => {
  const input = {
    requestId: "11111111-1111-4111-8111-111111111111",
    contactId: "22222222-2222-4222-8222-222222222222",
    contactType: "prospect" as const, permission: "consented" as const,
    consentEvidence: "Agreed to an automated AI call during our discovery enquiry.",
  };
  validateCallInput(input);
  assert.throws(() => validateCallInput({ ...input, consentEvidence: "" }), /permission record/);
  assert.throws(() => validateCallInput({ ...input, contactId: "invalid" }), /permission record/);
});

test("assistant tools keep per-call credentials outside model arguments", () => {
  const definition = assistantConfiguration("https://dialer.example.test");
  assert.equal(definition.tools?.length, 6);
  for (const tool of definition.tools || []) {
    assert.equal(tool.type, "webhook");
    if (tool.type !== "webhook") continue;
    assert.equal(tool.webhook.method, "POST");
    assert.deepEqual(tool.webhook.headers, [
      { name: "Authorization", value: "Bearer {{tool_token}}" },
      { name: "X-AI-Call-Id", value: "{{call_id}}" },
    ]);
    assert.equal("tool_token" in (tool.webhook.body_parameters?.properties || {}), false);
  }
  assert.throws(() => assistantConfiguration("http://dialer.example.test"), /HTTPS/);
  assert.throws(() => assistantConfiguration("https://dialer.example.test/path"), /origin/);
});
