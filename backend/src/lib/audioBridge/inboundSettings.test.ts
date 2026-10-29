import { before, test } from "node:test";
import assert from "node:assert/strict";
import { readInboundSettings, saveInboundSettings, validateInboundSettings } from "./inboundSettings.js";

const NUMBER = "+441234567890";
const DEFAULTS = { fallbackPhone: "+447700900123", holdAudioUrl: "https://dialer.example/hold.mp3" };
const SAVED = { fallbackPhone: "+447700900456", holdAudioUrl: "https://dialer.example/other.mp3" };
const metadata = (fields = [{ name: "inboundRouting", type: "RAW_JSON", isActive: true, options: null }]) => ({
  data: { objects: { edges: [{ node: { id: "phone-object", nameSingular: "agencyPhone",
    namePlural: "agencyPhones", fields: { edges: fields.map((node) => ({ node })) } } }] } },
});

before(() => {
  process.env.TWENTY_BASE_URL = "https://twenty.invalid";
  process.env.TWENTY_API_KEY = "test-only";
});

test("inbound settings validate both fields and only expose routing settings", () => {
  assert.deepEqual(validateInboundSettings({ ...SAVED, appId: "not-public" }), SAVED);
  for (const value of [
    null, {}, { ...SAVED, fallbackPhone: "07700900123" }, { ...SAVED, fallbackPhone: 123 },
    { ...SAVED, holdAudioUrl: "http://example.com/hold.mp3" },
    { ...SAVED, holdAudioUrl: "https://user:password@example.com/hold.mp3" },
    { ...SAVED, holdAudioUrl: "not-a-url" }, { ...SAVED, holdAudioUrl: null },
  ]) assert.throws(() => validateInboundSettings(value));
  assert.throws(() => validateInboundSettings({ ...SAVED, fallbackPhone: NUMBER }, NUMBER), /must not be/);
});

test("unsaved inbound settings use environment defaults without exposing other config", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: string) => {
    const url = new URL(input);
    assert.equal(url.searchParams.get("filter"), `phoneNumber[eq]:"${NUMBER}"`);
    assert.equal(url.searchParams.get("limit"), "1");
    return Response.json({ data: { agencyPhones: [{ id: "phone-1" }] } });
  });
  const config = { ...DEFAULTS, appId: "private" };
  assert.deepEqual(await readInboundSettings(NUMBER, config), DEFAULTS);
});

test("missing phone record preserves existing environment routing until settings are saved", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: { agencyPhones: [] } }));
  assert.deepEqual(await readInboundSettings(NUMBER, DEFAULTS), DEFAULTS);
  await assert.rejects(saveInboundSettings(NUMBER, SAVED, null), /no agency phone record/);
});

test("saved routing overrides environment defaults durably across reads", async (t) => {
  let routing: unknown = null;
  t.mock.method(globalThis, "fetch", async (input: string, init?: RequestInit) => {
    if (new URL(input).pathname === "/metadata") return Response.json(metadata());
    if (init?.method === "PATCH") {
      assert.equal(new URL(input).pathname, "/rest/agencyPhones/phone-1");
      const body = JSON.parse(String(init.body));
      assert.deepEqual(body.createdBy, { source: "API", workspaceMemberId: "member-1", name: "Agent" });
      routing = body.inboundRouting;
      return Response.json({ data: { agencyPhone: { id: "phone-1", inboundRouting: routing } } });
    }
    return Response.json({ data: { agencyPhones: [{ id: "phone-1", inboundRouting: routing }] } });
  });
  assert.deepEqual(await readInboundSettings(NUMBER, DEFAULTS), DEFAULTS);
  await saveInboundSettings(NUMBER, SAVED, {
    createdBy: { source: "API", workspaceMemberId: "member-1", name: "Agent" },
  });
  assert.deepEqual(await readInboundSettings(NUMBER, DEFAULTS), SAVED);
  assert.deepEqual(await readInboundSettings(NUMBER, DEFAULTS), SAVED);
});

test("corrupt saved settings are reported rather than silently replaced by defaults", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ data: { agencyPhones: [{ id: "phone-1", inboundRouting: { fallbackPhone: "broken" } }] } }),
  );
  await assert.rejects(readInboundSettings(NUMBER, DEFAULTS), /international format/);
});

test("Twenty read and schema write failures propagate to the API caller", async (t) => {
  const mocked = t.mock.method(globalThis, "fetch", async () => new Response("read failed", { status: 400 }));
  await assert.rejects(readInboundSettings(NUMBER, DEFAULTS), /Failed to fetch/);
  mocked.mock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) =>
    new URL(String(input)).pathname === "/metadata" ? Response.json(metadata()) : init?.method === "PATCH"
      ? new Response("Unknown field inboundRouting", { status: 400 })
      : Response.json({ data: { agencyPhones: [{ id: "phone-1" }] } }),
  );
  await assert.rejects(saveInboundSettings(NUMBER, SAVED, null), /Unknown field inboundRouting/);
});

test("saving provisions only the inbound routing field using deployed credentials", async (t) => {
  let created = false;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    if (new URL(String(input)).pathname === "/metadata") {
      const body = JSON.parse(String(init?.body));
      if (body.query.includes("mutation CreateField")) {
        assert.equal(body.variables.input.field.name, "inboundRouting");
        assert.equal(body.variables.input.field.type, "RAW_JSON");
        assert.equal(body.variables.input.field.objectMetadataId, "phone-object");
        created = true;
        return Response.json({ data: { createOneField: { id: "routing-field", name: "inboundRouting" } } });
      }
      return Response.json(metadata([]));
    }
    if (init?.method === "PATCH") {
      assert.equal(created, true);
      return Response.json({ data: { agencyPhone: { id: "phone-1", inboundRouting: SAVED } } });
    }
    return Response.json({ data: { agencyPhones: [{ id: "phone-1" }] } });
  });
  await saveInboundSettings(NUMBER, SAVED, null);
});

test("unconfigured inbound number fails before making a store request", async (t) => {
  const mocked = t.mock.method(globalThis, "fetch", async () => { throw new Error("Must not fetch"); });
  await assert.rejects(readInboundSettings("", DEFAULTS), /TELNYX_INBOUND_NUMBER/);
  assert.equal(mocked.mock.callCount(), 0);
});
