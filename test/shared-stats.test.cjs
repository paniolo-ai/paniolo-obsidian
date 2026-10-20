const assert = require("node:assert/strict");
const test = require("node:test");
const loadTs = require("./load-ts.cjs");

const response = {
	schemaVersion: 1,
	domains: {
		stale: { availability: "outdated", reason: "source-generation-changed", data: { actionable: 2 } },
		wiki: { availability: "never-run", reason: "no-check-recorded" },
		"qmd.inventory": { availability: "available", reason: "current", data: {
			surfaces: { wiki: 3, docs: 4, codeComments: 5 }, vectorReady: 8, vectorEligible: 12,
		} },
		"qmd.maintenance": { availability: "available", reason: "cached-observation", data: { phase: "embedding", indexingActive: true } },
		"qmd.health": { availability: "degraded", reason: "vector-backlog", data: { bm25: { status: "ready" }, vectors: { status: "degraded" } } },
		"qmd.retrieval": { availability: "unavailable", reason: "telemetry-disabled" },
		"git.workingTree": { availability: "expired", reason: "observation-expired" },
		storage: { availability: "available", reason: "current", data: {
			roots: [{ role: "modelCache", availability: "unavailable", reason: "root-missing", volumeKey: null }], volumes: [],
		} },
		operations: { availability: "available", reason: "cached-queue", data: { pending: 1, leased: 0 } },
	},
};

test("shared stats parser rejects unknown contract versions and keeps domain states", () => {
	const api = loadTs("shared-stats.ts", { "./paniolo": { runPaniolo: async () => ({}) } });
	assert.equal(api.parseStats(JSON.stringify({ ...response, schemaVersion: 2 })), null);
	const parsed = api.parseStats(JSON.stringify(response));
	assert.equal(parsed.domains.stale.availability, "outdated");
	assert.equal(parsed.domains["qmd.retrieval"].reason, "telemetry-disabled");
});

test("status bar prioritizes active indexing and modal keeps failures distinct from zero", () => {
	const api = loadTs("shared-stats.ts", { "./paniolo": { runPaniolo: async () => ({}) } });
	const stats = { workspace: response, repo: response };
	const rows = api.sharedStatsRows(stats);
	assert.match(rows.find((row) => row.name === "Wiki").value, /^never-run/);
	assert.match(rows.find((row) => row.name === "Git").value, /^expired/);
	assert.match(rows.find((row) => row.name === "Storage").value, /root-missing/);
	assert.match(api.statusBarText(stats), /^Paniolo: index embedding/);
});

test("reader requests only selected cached fields for both scopes", async () => {
	const calls = [];
	const api = loadTs("shared-stats.ts", { "./paniolo": {
		runPaniolo: async (_binary, args, _cwd, timeout) => {
			calls.push({ args, timeout });
			return { code: 0, stdout: JSON.stringify(response) };
		},
	} });
	await api.readSharedStats("paniolo", "/ws", "/ws/wiki/page.md");
	assert.equal(calls.length, 2);
	assert.deepEqual(calls.map((call) => call.args[call.args.indexOf("--scope") + 1]).sort(), ["repo", "workspace"]);
	assert.ok(calls.every((call) => call.timeout === 5000));
	assert.ok(calls.every((call) => call.args.includes("--fields")));
});
