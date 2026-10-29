import { test } from "node:test";
import assert from "node:assert/strict";
import { callerRecordPath, callerTarget } from "./callerMatch";
import type { CallerMatch } from "@/domains/api/client";

const company: CallerMatch = {
  id: "company", type: "prospect", name: "Example Ltd", company: "Example Ltd",
  email: null, jobTitle: null, prospectId: "company", leadId: null, country: "GB", campaignId: "campaign",
};

test("unique caller matches provide the contact target and record navigation", () => {
  const target = callerTarget("+447700900123", "Caller", [company]);
  assert.equal(target.contactType, "prospect");
  assert.equal(target.contactId, "company");
  assert.equal(target.phone, "+447700900123");
  assert.equal(target.name, "Example Ltd");
  assert.equal(target.campaignId, "campaign");
  assert.equal(callerRecordPath(company), "/contacts/company");
  const lead: CallerMatch = { ...company, id: "lead", type: "lead", leadId: "lead", prospectId: null };
  assert.equal(callerRecordPath(lead), "/leads/lead");
  assert.equal(callerTarget("+447700900123", "Caller", [lead]).contactType, "lead");
});

test("matched people open their company's page and log calls against that company", () => {
  const person: CallerMatch = { ...company, id: "person", type: "person", name: "Alex" };
  assert.equal(callerRecordPath(person), "/contacts/company");
  assert.equal(callerTarget("+447700900123", "Caller", [person]).contactId, "company");
  assert.equal(callerTarget("+447700900123", "Caller", [person]).name, "Alex");
  assert.equal(callerRecordPath({ ...person, prospectId: null }), null);
});

test("ambiguous and unknown callers never attach to an arbitrary record", () => {
  for (const matches of [[], [company, { ...company, id: "another" }]]) {
    const target = callerTarget("+447700900123", "Caller", matches);
    assert.equal(target.name, "Caller");
    assert.equal(target.contactType, null);
    assert.equal(target.contactId, null);
  }
});
