import test from "node:test";
import assert from "node:assert/strict";
import { normalizeTasks } from "./index.js";

const now = new Date("2026-10-28T12:00:00Z");

test("keeps valid tasks and resolves due dates", () => {
  const r = normalizeTasks([{ title: " Send pricing ", description: "As discussed", due: "2026-10-30" }], now);
  assert.equal(r[0].title, "Send pricing");
  assert.equal(r[0].dueAt, "2026-10-30T09:00:00.000Z");
});

test("drops empty titles, bad or past dates, and caps at five", () => {
  const r = normalizeTasks([{ title: "" }, { title: "A", due: "2020-01-01" }, { title: "B", due: "soon" }, ...Array.from({ length: 8 }, (_, i) => ({ title: `T${i}` }))], now);
  assert.equal(r.length, 5);
  assert.equal(r[0].dueAt, null);
  assert.equal(r[1].dueAt, null);
});

test("non-array input yields no tasks", () => {
  assert.deepEqual(normalizeTasks("nope", now), []);
});
