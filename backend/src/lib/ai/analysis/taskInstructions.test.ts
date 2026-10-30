import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeTasks } from "./index.js";

const transcript = "Vanessa: Please send the AI service overview to office@example.test. I will forward it to our technology team. Agent: I will send it today.";
const task = {
  title: "Email the AI service overview to Vanessa",
  objective: "Give Vanessa the AI service overview for the technology team.",
  recipient: { name: "Vanessa", email: "office@example.test" },
  steps: [
    "Get the approved AI service overview.",
    "Send the overview to office@example.test for Vanessa to forward to the technology team.",
    "Save the sent-message reference on the linked contact.",
  ],
  completionCriteria: [
    "The sent-message record identifies office@example.test and the AI service overview.",
    "The contact record contains the sent-message reference.",
  ],
  evidence: ["Vanessa: Please send the AI service overview to office@example.test.", "I will forward it to our technology team."],
  missingInformation: ["Confirm the approved service overview and sender account."],
  due: null,
};

test("execution brief has a specific title, exact email, short steps, evidence and completion checks", () => {
  const [result] = normalizeTasks([task], new Date(), transcript);
  assert.equal(result.title, task.title);
  assert(result.title.length <= 120);
  for (const heading of ["Objective", "Recipient", "Procedure", "Completion criteria", "Call evidence", "Missing information", "Execution control"]) {
    assert(result.description.includes(`## ${heading}`));
  }
  assert.match(result.description, /Email: office@example.test/);
  assert.match(result.description, /1\. Get the approved AI service overview/);
  assert.match(result.description, /sender account/);
  assert.match(result.description, /does not grant permission/);
  assert(!result.description.includes("[object Object]"));
});

test("spoken at and dot are accepted only with matching call evidence", () => {
  const quote = "Send the overview to office at example dot test";
  const [result] = normalizeTasks([{ ...task, evidence: [quote] }], new Date(), quote);
  assert.match(result.description, /Email: office@example.test/);
  const spelled = "Send the overview to office at sign example dot test";
  assert.match(normalizeTasks([{ ...task, evidence: [spelled] }], new Date(), spelled)[0].description, /Email: office@example.test/);
  assert.throws(() => normalizeTasks([{ ...task, recipient: { name: "Vanessa", email: "ceo@example.test" } }], new Date(), transcript), /email is not confirmed/);
  assert.throws(() => normalizeTasks([task], new Date(), transcript.replace("office@example.test", "notoffice@example.test")), /evidence does not match/);
});

test("re-analysis retains a stated overdue date and rejects an impossible date", () => {
  const [result] = normalizeTasks([{ ...task, due: "2026-10-28" }], new Date("2026-11-03"), transcript);
  assert.equal(result.dueAt, "2026-10-28T09:00:00.000Z");
  assert.throws(() => normalizeTasks([{ ...task, due: "2026-02-30" }], new Date(), transcript), /valid calendar date/);
});
test("missing recipient details stay explicit and fabricated evidence is rejected", () => {
  const [result] = normalizeTasks([{ ...task, recipient: { name: null, email: null }, missingInformation: ["Confirm the recipient address."] }], new Date(), transcript);
  assert.match(result.description, /Email: Not confirmed/);
  assert.throws(() => normalizeTasks([{ ...task, evidence: ["Invented call quote."] }], new Date(), transcript), /evidence does not match/);
});

test("malformed or overlong instructions fail explicitly instead of creating incomplete briefs", () => {
  assert.throws(() => normalizeTasks([{ ...task, steps: [] }], new Date(), transcript), /steps/);
  assert.throws(() => normalizeTasks([{ ...task, steps: [Array(21).fill("word").join(" ")] }], new Date(), transcript), /at most 20 words/);
  assert.throws(() => normalizeTasks([{ title: "Send information", description: "As discussed." }], new Date(), transcript), /title must identify/);
  assert.throws(() => normalizeTasks([{ ...task, steps: ["Send the overview to guessed@example.test."] }], new Date(), transcript), /email is not confirmed/);
  assert.throws(() => normalizeTasks(null, new Date(), transcript), /tasks array/);
});
