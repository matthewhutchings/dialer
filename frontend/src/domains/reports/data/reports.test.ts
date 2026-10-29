import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bucketsFor, dispositionBreakdown, filterCalls, healthFor, isConnected, isConversation,
  memberGrid, numberHealth, rangeFor, totalsFor, type ReportCall,
  agentOf, teamStats,
} from "./reports";

const call = (over: Partial<ReportCall>): ReportCall => ({
  id: Math.random().toString(36),
  direction: "OUTBOUND",
  status: "INTERESTED",
  fromNumber: "+15550000001",
  durationSeconds: 90,
  startedAt: "2026-06-03T15:00:00",
  created_at: "2026-06-03T15:00:00",
  createdBy: { name: "McKenna Davies" },
  ...over,
});

test("no-answer, busy and failed calls are not connected even with ringing time", () => {
  assert.equal(isConnected(call({ status: "NO_ANSWER", durationSeconds: 17 })), false);
  assert.equal(isConnected(call({ status: "BUSY", durationSeconds: 4 })), false);
  assert.equal(isConnected(call({ status: "FAILED", durationSeconds: 3 })), false);
  assert.equal(isConnected(call({ status: "LEFT_VOICEMAIL", durationSeconds: 25 })), true);
});

test("a conversation is an outbound connected call at or over the threshold", () => {
  assert.equal(isConversation(call({ durationSeconds: 60 }), 60), true);
  assert.equal(isConversation(call({ durationSeconds: 59 }), 60), false);
  assert.equal(isConversation(call({ direction: "INBOUND", durationSeconds: 300 }), 60), false);
  assert.equal(isConversation(call({ durationSeconds: 45 }), 30), true);
});

test("last 7 days covers today plus six days back, one bucket per day", () => {
  const range = rangeFor("last7", new Date(2026, 5, 7, 12));
  const buckets = bucketsFor(range);
  assert.deepEqual(buckets.map((b) => b.label), ["6/1", "6/2", "6/3", "6/4", "6/5", "6/6", "6/7"]);
});

test("ranges longer than two weeks are bucketed by week", () => {
  const buckets = bucketsFor(rangeFor("last30", new Date(2026, 5, 30, 12)));
  assert.equal(buckets.length, 5);
  assert.ok(buckets[0].label.startsWith("Wk "));
});

test("totals, member grid and range filter agree on the same calls", () => {
  const calls = [
    call({ durationSeconds: 120 }),
    call({ status: "NO_ANSWER", durationSeconds: 15 }),
    call({ createdBy: { name: "Abel" }, status: "APPOINTMENT_SET", durationSeconds: 30 }),
    call({ direction: "INBOUND", status: "COMPLETED", durationSeconds: 60 }),
    call({ startedAt: "2026-05-20T10:00:00", created_at: "2026-05-20T10:00:00" }), // outside range
  ];
  const range = rangeFor("last7", new Date(2026, 5, 7, 12));
  const inRange = filterCalls(calls, range, null);
  assert.equal(inRange.length, 4);
  const t = totalsFor(inRange, 60);
  assert.equal(t.outbound, 3);
  assert.equal(t.inbound, 1);
  assert.equal(t.conversations, 1);
  assert.equal(t.appointments, 1);
  assert.equal(t.outboundMinutes, 2.5); // 120s + 30s connected outbound; no-answer excluded
  const grid = memberGrid(inRange, bucketsFor(range), (c) => c.direction === "OUTBOUND");
  assert.deepEqual(grid.map((r) => [r.member, r.total]), [["McKenna Davies", 2], ["Abel", 1]]);
  assert.equal(filterCalls(calls, range, "Abel").length, 1);
});

test("number health needs enough calls before judging a number", () => {
  assert.equal(healthFor(5, 0), "low-data");
  assert.equal(healthFor(20, 0.25), "good");
  assert.equal(healthFor(20, 0.15), "watch");
  assert.equal(healthFor(20, 0.05), "risk");
  const rows = numberHealth([call({}), call({ status: "BAD_NUMBER", durationSeconds: 5 })], 60);
  assert.equal(rows[0].badOrWrong, 1);
  assert.equal(rows[0].connected, 2);
});

test("disposition breakdown lists WAVV dispositions first with shares", () => {
  const rows = dispositionBreakdown([call({ status: "NO_ANSWER" }), call({}), call({}), call({ status: "BUSY" })]);
  assert.deepEqual(rows.map((r) => r.label), ["Interested", "No Answer", "Busy"]);
  assert.equal(rows[0].share, 0.5);
});

test("AI calls use a named reporting identity instead of the triggering human across reports", () => {
  const calls = [
    call({ createdBy: { name: "Scout" }, durationSeconds: 120 }),
    call({ createdBy: { name: "Scout" }, isAiVoice: true, aiAgentName: "Scout", status: "APPOINTMENT_SET", durationSeconds: 180 }),
    call({ createdBy: { name: "Another human" }, isAiVoice: true, aiAgentName: "Scout", status: "NO_ANSWER", durationSeconds: 20 }),
  ];
  assert.equal(agentOf(calls[0]), "Scout");
  assert.equal(agentOf(calls[1]), "Scout (AI)");
  const rows = teamStats(calls, 60);
  assert.equal(rows.length, 2);
  const ai = rows.find((row) => row.member === "Scout (AI)")!;
  assert.equal(ai.outbound, 2);
  assert.equal(ai.conversations, 1);
  assert.equal(ai.appointments, 1);
  assert.equal(ai.outboundMinutes, 3);
  const range = rangeFor("last7", new Date(2026, 5, 7, 12));
  assert.equal(filterCalls(calls, range, "Scout").length, 1);
  assert.equal(filterCalls(calls, range, "Scout (AI)").length, 2);
  assert.equal(memberGrid(calls, bucketsFor(range), () => true).find((row) => row.member === "Scout (AI)")!.total, 2);
  const renamed = calls.map((item) => item.isAiVoice ? { ...item, aiAgentName: "Discovery" } : item);
  assert.equal(teamStats(renamed, 60).find((row) => row.member === "Discovery (AI)")!.outbound, 2);
  assert.equal(totalsFor(calls, 60).outbound, totalsFor(renamed, 60).outbound);
});
