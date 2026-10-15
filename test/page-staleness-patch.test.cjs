const assert = require("node:assert/strict");
const test = require("node:test");
const loadTs = require("./load-ts.cjs");

const { applyReviewedPatch, parseReviewedPagePatches } = loadTs("page-staleness-patch.ts");
const target = "wiki:wiki/a.md";
const patch = "--- a/wiki/a.md\n+++ b/wiki/a.md\n@@ -1,2 +1,2 @@\n # API\n-old\n+new\n@@ -4,2 +4,2 @@\n # More\n-old again\n+new again\n";

test("reviewed patch response must name the exact report, page, and editor hash", () => {
	const response = { runId: "R1", target, snapshotSha256: "sha256", patches: [{ allegationId: "S1", bundleId: "B1", patchHash: "hash", anchor: "api", patch }] };
	assert.equal(parseReviewedPagePatches(JSON.stringify(response), "R1", target, "sha256").patches[0].bundleId, "B1");
	assert.throws(() => parseReviewedPagePatches(JSON.stringify({ ...response, target: "wiki:wiki/b.md" }), "R1", target, "sha256"), /do not match/);
	assert.throws(() => parseReviewedPagePatches(JSON.stringify(response), "R1", target, "new hash"), /do not match/);
	assert.throws(() => parseReviewedPagePatches(JSON.stringify({ ...response, patches: [{}] }), "R1", target, "sha256"), /invalid reviewed patch/);
});

test("two reviewed hunks change only the selected page and reject drift or structural edits", () => {
	const original = "# API\nold\n\n# More\nold again\n";
	assert.equal(applyReviewedPatch(original, patch, "wiki/a.md"), "# API\nnew\n\n# More\nnew again\n");
	assert.throws(() => applyReviewedPatch(original.replace("old again", "later edit"), patch, "wiki/a.md"), /editor text changed/);
	assert.throws(() => applyReviewedPatch(original, patch, "wiki/b.md"), /different page/);
	assert.throws(() => applyReviewedPatch(original, patch + "--- a/wiki/b.md\n+++ b/wiki/b.md\n", "wiki/a.md"), /another file/);
	assert.throws(() => applyReviewedPatch(original, patch.replace("@@ -4,2 +4,2 @@", "@@ -4,2 +4,3 @@"), "wiki/a.md"), /line counts differ/);
});
