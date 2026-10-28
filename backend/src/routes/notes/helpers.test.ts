import { test } from "node:test";
import assert from "node:assert/strict";
import { mapLinkedNote, noteTargetField } from "./helpers.js";

test("native notes retain individual titles, markdown, author and timestamp", () => {
  assert.deepEqual(mapLinkedNote({
    id: "n1", title: "Research", bodyV2: { markdown: "Two\nlines" },
    createdAt: "2026-10-28T13:00:00Z", createdBy: { name: "Matt" },
  }), { id: "n1", title: "Research", body: "Two\nlines", at: "2026-10-28T13:00:00Z", author: "Matt" });
});

test("BlockNote-only bodies are readable without rendering untrusted HTML", () => {
  const body = JSON.stringify([{ content: [{ text: "First" }], children: [{ content: [{ text: "Nested" }] }] }]);
  assert.equal(mapLinkedNote({ id: "n", bodyV2: { blocknote: body } }).body, "First\nNested");
  assert.throws(() => mapLinkedNote({ id: "n", bodyV2: { blocknote: "invalid" } }));
});

test("image notes use the freshly signed BlockNote URL instead of the expiring markdown one", () => {
  const blocknote = JSON.stringify([
    { type: "paragraph", content: [{ type: "text", text: "Homepage of example.com" }] },
    { type: "image", props: { url: "https://api.twenty.com/file/files-field/f1?token=fresh", name: "shot [1].jpg" } },
    { type: "image", props: { url: "javascript:alert(1)", name: "bad" } },
  ]);
  const markdown = "Homepage\n\n![shot](https://api.twenty.com/file/files-field/f1?token=stale)";
  assert.equal(
    mapLinkedNote({ id: "n", bodyV2: { markdown, blocknote } }).body,
    "Homepage of example.com\n\n![shot 1.jpg](<https://api.twenty.com/file/files-field/f1?token=fresh>)",
  );
  const plain = JSON.stringify([{ type: "paragraph", content: [{ text: "Plain" }] }]);
  assert.equal(mapLinkedNote({ id: "n", bodyV2: { markdown: "**md**", blocknote: plain } }).body, "**md**");
});

test("only supported contact types select target fields", () => {
  assert.equal(noteTargetField("prospect"), "targetAgencyProspectId");
  assert.equal(noteTargetField("lead"), "targetAgencyLeadId");
  assert.equal(noteTargetField("arbitrary"), null);
});
