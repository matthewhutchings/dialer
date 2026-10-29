import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCallerIndex, callerCandidateFilters, canonicalPhone } from "./helpers.js";

test("caller normalization handles E.164, international prefixes and country-aware national formats", () => {
  for (const raw of ["+44 7700 900123", "0044 7700 900123", "+44 (0)7700 900123"]) {
    assert.equal(canonicalPhone(raw), "+447700900123");
  }
  for (const country of ["GB", "UK", "United Kingdom", "England"]) {
    assert.equal(canonicalPhone("07700 900123", country), "+447700900123");
  }
  assert.equal(canonicalPhone("(202) 555-0123", "United States"), "+12025550123");
  for (const value of ["07700900123", "anonymous", "Withheld", "123", "phone +447700900123", ""]) {
    assert.equal(canonicalPhone(value), null);
  }
});

test("prospects match all stored phone fields, with formatting normalized and no repeated records", () => {
  const index = buildCallerIndex([{
    id: "company", name: "Example Ltd", country: "UK", email: "hello@example.test",
    phone: "07700 900123",
    phoneNumber: { primaryPhoneNumber: "07700900123", primaryPhoneCallingCode: "+44",
      additionalPhones: [{ number: "07700 900456", callingCode: "+44" }] },
    primaryPhone: { primaryPhoneNumber: "+447700900789" },
  }], [], []);
  for (const number of ["+447700900123", "+447700900456", "+447700900789"]) {
    assert.equal(index.get(number)?.length, 1);
    assert.equal(index.get(number)?.[0].prospectId, "company");
    assert.equal(index.get(number)?.[0].email, "hello@example.test");
  }
});

test("leads and people retain record identity, company details and call associations", () => {
  const index = buildCallerIndex(
    [{ id: "company", name: "Example Ltd", country: "GB", campaignIdId: "campaign" }],
    [{ id: "lead", name: "A Lead", phone: { primaryPhoneNumber: "2025550123", primaryPhoneCallingCode: "1",
      additionalPhones: ["+12025550124"] }, email: { primaryEmail: "lead@example.test" } }],
    [{ id: "person", name: "Alex", jobTitle: "Owner", prospectId: "company",
      phones: { primaryPhoneNumber: "07700 900123" }, emails: { primaryEmail: "alex@example.test" } }],
  );
  const person = index.get("+447700900123")?.[0];
  assert.equal(person?.type, "person");
  assert.equal(person?.company, "Example Ltd");
  assert.equal(person?.prospectId, "company");
  assert.equal(person?.campaignId, "campaign");
  assert.equal(person?.jobTitle, "Owner");
  for (const number of ["+12025550123", "+12025550124"]) {
    assert.equal(index.get(number)?.[0].leadId, "lead");
  }
});

test("shared numbers return every candidate; suffix collisions and unknown callers do not match", () => {
  const index = buildCallerIndex([
    { id: "a", phone: "+447700900123" }, { id: "b", phone: "+447700900123" },
    { id: "other-country", phone: "+33770900123" },
  ], [{ id: "lead", phone: "+447700900123" }], []);
  assert.deepEqual(index.get("+447700900123")?.map((m) => m.id), ["a", "b", "lead"]);
  assert.equal(index.get("+447700900456"), undefined);
  assert.equal(index.get("+33770900123")?.length, 1);
});

test("database prefilter includes formatted primary and additional phone values", () => {
  const filters = callerCandidateFilters("+447700900123");
  const pattern = "%0%9%0%0%1%2%3%";
  assert.deepEqual(filters.lead, { or: [
    { phone: { primaryPhoneNumber: { like: pattern } } }, { phone: { additionalPhones: { like: pattern } } },
  ] });
  assert.equal(filters.prospect.or.length, 5);
  assert.throws(() => callerCandidateFilters("anonymous"), /international/);
});

test("phone-level country metadata normalizes national numbers even without a record country", () => {
  const index = buildCallerIndex([], [{
    id: "lead", phone: { primaryPhoneNumber: "07700 900123", primaryPhoneCountryCode: "GB",
      additionalPhones: [{ number: "(202) 555-0123", countryCode: "US" }] },
  }], []);
  assert.equal(index.get("+447700900123")?.[0].leadId, "lead");
  assert.equal(index.get("+12025550123")?.[0].leadId, "lead");
});
