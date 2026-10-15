const assert = require("node:assert/strict");
const test = require("node:test");
const loadTs = require("./load-ts.cjs");

const { readPageCompletion, parsePageReviewTracking } = loadTs("page-staleness-completion.ts", {
	"./paniolo": { runPaniolo: () => { throw new Error("use fixture runner"); } },
});

const id = `PR-${"a".repeat(64)}`;
const base = "b".repeat(40);
const head = "c".repeat(40);
const tracked = { key: "wiki:branch@head#scope", id, repo: "wiki", prNumber: 12, base, head };

test("persisted tracking rejects malformed or ambiguous identities", () => {
	assert.deepEqual(parsePageReviewTracking(tracked), tracked);
	assert.equal(parsePageReviewTracking({ ...tracked, head: "other" }), null);
	assert.equal(parsePageReviewTracking({ ...tracked, prNumber: 0 }), null);
});

test("snapshot zero is not closure, while current-writer zero updates without a restart", async () => {
	const never = async () => { throw new Error("should not call a provider"); };
	assert.equal((await readPageCompletion(tracked, 0, "snapshot", "C:/root", "C:/repo", "paniolo", never)).state, "snapshot");
	assert.equal((await readPageCompletion(tracked, 0, "active-writer", "C:/root", "C:/repo", "paniolo", never)).state, "current-writer-zero");
});

test("an exact reviewed PR moves through awaiting merge, pending closure, and retained", async () => {
	let providerState = "OPEN";
	let gateState = "passing";
	const run = async (binary, args) => {
		if (args.includes("review-show")) return { code: 0, stdout: JSON.stringify({ request: { id, repo: "wiki", prNumber: 12, base, head }, state: "complete" }), stderr: "" };
		if (binary === "gh") return { code: 0, stdout: JSON.stringify({ number: 12, state: providerState, headRefOid: head }), stderr: "" };
		if (args.includes("pr-check")) return { code: gateState === "passing" ? 0 : 1, stdout: JSON.stringify({ state: gateState, head, reviewId: id, reasons: gateState === "passing" ? [] : ["still-stale"] }), stderr: "" };
		throw new Error(`unexpected ${binary} ${args.join(" ")}`);
	};
	assert.equal((await readPageCompletion(tracked, 2, "active-writer", "C:/root", "C:/repo", "paniolo", run)).state, "awaiting-merge");
	gateState = "failing";
	assert.equal((await readPageCompletion(tracked, 2, "active-writer", "C:/root", "C:/repo", "paniolo", run)).state, "retained");
	providerState = "MERGED";
	assert.equal((await readPageCompletion(tracked, 2, "active-writer", "C:/root", "C:/repo", "paniolo", run)).state, "pending-verification");
});

test("a replaced review or changed PR identity cannot appear ready to merge", async () => {
	const run = async (binary, args) => {
		if (args.includes("review-show")) return { code: 0, stdout: JSON.stringify({ request: { id, repo: "wiki", prNumber: 12, base, head }, state: "complete" }), stderr: "" };
		if (binary === "gh") return { code: 0, stdout: JSON.stringify({ number: 12, state: "OPEN", headRefOid: head }), stderr: "" };
		return { code: 1, stdout: JSON.stringify({ state: "pending", head, reviewId: "other", reasons: ["new-allegation"] }), stderr: "" };
	};
	assert.equal((await readPageCompletion(tracked, 1, "active-writer", "C:/root", "C:/repo", "paniolo", run)).state, "pending-verification");
	const changedScope = async (binary, args) => {
		if (args.includes("pr-check")) return { code: 1, stdout: JSON.stringify({ state: "failing", head, reviewId: "other", reasons: ["new-allegation"] }), stderr: "" };
		return run(binary, args);
	};
	assert.equal((await readPageCompletion(tracked, 1, "active-writer", "C:/root", "C:/repo", "paniolo", changedScope)).state, "pending-verification");
	await assert.rejects(readPageCompletion(tracked, 1, "active-writer", "C:/root", "C:/repo", "paniolo", async (binary, args) =>
		binary === "gh" ? { code: 0, stdout: JSON.stringify({ number: 12, state: "OPEN", headRefOid: base }), stderr: "" }
			: run(binary, args)), /identity changed/);
});
