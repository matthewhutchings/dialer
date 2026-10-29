import { before, test } from "node:test";
import assert from "node:assert/strict";
import { matchCaller } from "./index.js";

before(() => {
  process.env.TWENTY_BASE_URL = "https://twenty.invalid";
  process.env.TWENTY_API_KEY = "test-only";
});

const edges = (nodes: object[]) => ({ edges: nodes.map((node) => ({ node })) });

test("lookup filters in Twenty, loads a person's company and verifies the entire phone number", async (t) => {
  let queries = 0;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/graphql") {
      queries++;
      const body = JSON.parse(String(init?.body));
      assert.match(body.query, /additionalPhones/);
      assert.match(JSON.stringify(body), /%0%9%0%0%1%2%3%/);
      return Response.json({ data: {
        agencyProspects: edges([{ id: "wrong-country", phone: "+33770900123" }]),
        agencyLeads: edges([]),
        agencyPeople: edges([{ id: "person", name: "Alex", prospectId: "company",
          phones: { primaryPhoneNumber: "07700900123" } }]),
      } });
    }
    assert.equal(url.pathname, "/rest/agencyProspects/company");
    return Response.json({ data: { agencyProspect: { id: "company", name: "Example Ltd", country: "UK" } } });
  });
  const matches = await matchCaller("+447700900123");
  assert.equal(queries, 1);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].name, "Alex");
  assert.equal(matches[0].company, "Example Ltd");
  assert.equal(matches[0].prospectId, "company");
});

test("lookup preserves duplicates on later pages rather than guessing a unique match", async (t) => {
  let queries = 0;
  t.mock.method(globalThis, "fetch", async () => {
    const nodes = queries++ === 0
      ? Array.from({ length: 200 }, (_, i) => ({ id: `p-${i}`, phone: i === 0 ? "+447700900123" : "+33770900123" }))
      : [{ id: "later-page", phone: "+447700900123" }];
    return Response.json({ data: {
      agencyProspects: edges(nodes), agencyLeads: edges([]), agencyPeople: edges([]),
    } });
  });
  assert.deepEqual((await matchCaller("+447700900123")).map((m) => m.id), ["p-0", "later-page"]);
  assert.equal(queries, 2);
});

test("lookup reports upstream failure, including incomplete responses, rather than a false no-match", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: { agencyProspects: edges([]) } }));
  await assert.rejects(matchCaller("+447700900123"), /incomplete/);
});

test("unknown callers return no records and withheld callers never query CRM", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    return Response.json({ data: {
      agencyProspects: edges([]), agencyLeads: edges([]), agencyPeople: edges([]),
    } });
  });
  assert.deepEqual(await matchCaller("+447700900123"), []);
  await assert.rejects(matchCaller("anonymous"), /international/);
  assert.equal(requests, 1);
});
