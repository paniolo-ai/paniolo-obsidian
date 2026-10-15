const assert = require("node:assert/strict");
const test = require("node:test");
const loadTs = require("./load-ts.cjs");

const { inspectPagePrReview, submitPagePrReview } = loadTs("page-staleness-review.ts", {
	"./paniolo": { runPaniolo: () => { throw new Error("use the fake runner"); } },
});

test("only explicit submission starts a review, and a changed head needs a fresh plan", async () => {
	const base = "a".repeat(40);
	let head = "b".repeat(40);
	let revision = 2;
	let submissions = 0;
	const calls = [];
	const run = async (binary, args) => {
		calls.push([binary, args]);
		if (binary === "git") return { code: 0, stdout: args.includes("symbolic-ref") ? "codex/page\n" : `${head}\n`, stderr: "" };
		if (binary === "gh") return { code: 0, stdout: JSON.stringify({ number: 12, baseRefOid: base,
			headRefOid: head, headRefName: "codex/page", isCrossRepository: false, state: "OPEN", url: "https://example.test/pr/12" }), stderr: "" };
		if (args.includes("review-plan")) return { code: 0, stdout: JSON.stringify({ repo: "wiki", branch: "codex/page",
			base, head, prNumber: 12, status: "ready", invocationCeiling: 200, maximumRoleInvocations: 9,
			files: [{ path: "wiki/page.md", entries: [{ id: "S-1", revision, state: "confirmed-stale" }] }] }), stderr: "" };
		if (args.includes("review-submit")) {
			submissions++;
			return { code: 0, stdout: JSON.stringify({ reviewId: `PR-${"c".repeat(64)}`, head, subjects: 1, joined: false }), stderr: "" };
		}
		throw new Error(`unexpected ${binary} ${args.join(" ")}`);
	};
	const first = await inspectPagePrReview("C:/root", "C:/root/wiki", "wiki", "paniolo", run);
	assert.equal(first.maximumRoleInvocations, 9);
	assert.equal(submissions, 0, "opening a plan must not start paid work");
	assert.equal(await submitPagePrReview(first, "C:/root", "paniolo", run), `PR-${"c".repeat(64)}`);
	assert.equal(submissions, 1);
	head = "d".repeat(40);
	await assert.rejects(submitPagePrReview(first, "C:/root", "paniolo", run), /changed/);
	assert.equal(submissions, 1);
	const second = await inspectPagePrReview("C:/root", "C:/root/wiki", "wiki", "paniolo", run);
	assert.notEqual(first.key, second.key);
	await submitPagePrReview(second, "C:/root", "paniolo", run);
	assert.equal(submissions, 2);
	revision = 3;
	await assert.rejects(submitPagePrReview(second, "C:/root", "paniolo", run), /changed/);
	const third = await inspectPagePrReview("C:/root", "C:/root/wiki", "wiki", "paniolo", run);
	assert.notEqual(second.key, third.key, "a new allegation revision must invalidate the saved scope");
	assert.ok(calls.some(([, args]) => args.includes("review-plan")));
});

test("a plan above the configured role invocation ceiling cannot be submitted", async () => {
	const head = "d".repeat(40);
	const base = "a".repeat(40);
	const run = async (binary, args) => {
		if (binary === "git") return { code: 0, stdout: args.includes("symbolic-ref") ? "codex/page" : head, stderr: "" };
		if (binary === "gh") return { code: 0, stdout: JSON.stringify({ number: 12, baseRefOid: base,
			headRefOid: head, headRefName: "codex/page", isCrossRepository: false, state: "OPEN", url: "https://example.test/pr/12" }), stderr: "" };
		return { code: 0, stdout: JSON.stringify({ repo: "wiki", branch: "codex/page", base, head, prNumber: 12,
			status: "ready", invocationCeiling: 8, maximumRoleInvocations: 9, files: [] }), stderr: "" };
	};
	await assert.rejects(inspectPagePrReview("C:/root", "C:/root/wiki", "wiki", "paniolo", run), /ceiling/);
});
