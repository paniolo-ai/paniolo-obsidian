const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const test = require("node:test");
const loadTs = require("./load-ts.cjs");

const {
	assertSavedEditor, closeVaultReview, inspectVaultReview, parseStoredVaultReviewPlan,
	parseVaultReviewPlan, showVaultReview, submitVaultReview,
} = loadTs("non-git-review.ts", {
	"./non-git-vault": { deviceStatePath: () => "C:/device/vault-state" },
	"./paniolo": { resolveBinary: () => "paniolo" },
});

const id = `S-${"a".repeat(16)}`;
const reviewId = `VR-${"b".repeat(64)}`;
const saved = "---\npaniolo_page_id: test\n---\nCorrected claim.\n";
const hash = createHash("sha256").update(saved, "utf8").digest("hex");
const current = {
	vaultId: "c".repeat(32), pageId: "d".repeat(32), page: "note.md",
	source: "active-writer", generation: 7, count: 1,
	entries: [{ id, revision: 2, state: "pending-verification", anchor: "intro" }],
};
const rawPlan = {
	id: reviewId, vaultId: current.vaultId, pageId: current.pageId, page: current.page,
	savedSha256: hash, maximumRoleInvocations: 6,
	subjects: [{ id, revision: 2, state: "pending-verification", packet: { claim: "old" } }],
};

test("saved review rejects cross-page, changed revision, unsaved editor, and undo", () => {
	const plan = parseVaultReviewPlan(rawPlan, current);
	assert.equal(plan.id, reviewId);
	assertSavedEditor(saved, saved, plan);
	assert.throws(() => assertSavedEditor(`${saved}unsaved`, saved, plan), /save/);
	assert.throws(() => assertSavedEditor("old", "old", plan), /save/);
	assert.throws(() => parseVaultReviewPlan({ ...rawPlan, pageId: "e".repeat(32) }, current), /does not match/);
	assert.throws(() => parseVaultReviewPlan(rawPlan, { ...current, entries: [{ ...current.entries[0], revision: 3 }] }), /changed/);
	assert.deepEqual(parseStoredVaultReviewPlan(plan), plan);
	assert.equal(parseStoredVaultReviewPlan({ ...plan, id: "PR-invalid" }), null);
});

test("inspect, detached submit, reload poll, and current-writer closure preserve one exact review", async () => {
	const calls = [];
	const run = async (_binary, args) => {
		calls.push(args);
		const responses = {
			plan: rawPlan,
			submit: { reviewId, state: "queued", joined: false, savedSha256: hash, subjects: 1 },
			show: {
				request: rawPlan, state: "complete", subjects: [{ id, revision: 2, outcome: "fresh" }],
			},
			close: { state: "complete", count: 0, generation: 8, reason: null },
		};
		return { code: 0, stdout: JSON.stringify(responses[args[2]]), stderr: "" };
	};
	const plan = await inspectVaultReview("C:/vault", "note.md", "paniolo", current, run);
	assert.equal(await submitVaultReview("C:/vault", "paniolo", plan, run), reviewId);
	assert.deepEqual((await showVaultReview("C:/vault", "paniolo", plan, run)).results,
		[{ id, revision: 2, outcome: "fresh" }]);
	assert.deepEqual(await closeVaultReview("C:/vault", "paniolo", plan, run),
		{ state: "complete", count: 0, generation: 8, reason: null });
	assert.deepEqual(calls.map((args) => args.slice(1, 3)),
		[["vault-review", "plan"], ["vault-review", "submit"],
			["vault-review", "show"], ["vault-review", "close"]]);
	assert.equal(calls[3][calls[3].indexOf("--device-state") + 1], "C:/device/vault-state");
});

test("a refused writer or nonzero closure cannot be displayed as zero", async () => {
	const plan = parseVaultReviewPlan(rawPlan, current);
	await assert.rejects(closeVaultReview("C:/vault", "paniolo", plan,
		async () => ({ code: 1, stdout: "", stderr: "writer refused" })), /writer refused/);
	await assert.rejects(closeVaultReview("C:/vault", "paniolo", plan,
		async () => ({ code: 0, stdout: JSON.stringify({ state: "complete", count: 1, generation: 8, reason: null }), stderr: "" })), /invalid/);
});
