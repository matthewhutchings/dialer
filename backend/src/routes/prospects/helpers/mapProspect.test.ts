import { test } from "node:test";
import assert from "node:assert/strict";
import { mapProspectDetail, mapProspectListItem } from "./mapProspect.js";

test("prospect list and profile responses include the saved call opener", () => {
  const prospect = { id: "prospect-1", name: "Example Company", callOpener: "Hi, this is the opener." } as any;

  assert.equal(mapProspectListItem(prospect).callOpener, "Hi, this is the opener.");
  assert.equal(mapProspectDetail(prospect).callOpener, "Hi, this is the opener.");
});

test("prospect responses leave a missing call opener empty", () => {
  const prospect = { id: "prospect-1", name: "Example Company" } as any;

  assert.equal(mapProspectListItem(prospect).callOpener, null);
  assert.equal(mapProspectDetail(prospect).callOpener, null);
});
