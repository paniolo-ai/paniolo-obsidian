const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const loadTs = require("./load-ts.cjs");

class FileSystemAdapter { getBasePath() { return root; } }
class TFile {
	constructor(filePath) { this.path = filePath; this.extension = "md"; }
}

const root = path.resolve("test-vault");
const wiki = { name: "wiki", repoPath: "repo", wikiRoot: "repo/wiki" };
const count = loadTs("staleness-count.ts");
const pageKey = loadTs("page-staleness-key.ts");

test("a late count for page A cannot overwrite page B, and a ledger-only refresh updates B", async () => {
	const requests = [];
	let active = new TFile("repo/wiki/a.md");
	const plugin = { app: { workspace: { getActiveFile: () => active }, vault: { adapter: new FileSystemAdapter() } } };
	const indicatorModule = loadTs("staleness-count-indicator.ts", {
		obsidian: { FileSystemAdapter, TFile, Plugin: class {} },
		"./new-page": { loadWikis: () => [wiki] },
		"./page-staleness-key": pageKey,
		"./staleness-count": count,
		"./non-git-staleness": { readVaultPage: async () => { throw new Error("Git fixture"); } },
		"./paniolo": {
			findConfigRoot: () => root,
			resolveBinary: () => "paniolo",
			runPaniolo: () => new Promise((resolve) => { requests.push(resolve); }),
		},
	});
	const indicator = new indicatorModule.StalenessCountIndicator(plugin, () => "", () => {});
	const first = indicator.refresh();
	active = new TFile("repo/wiki/b.md");
	const second = indicator.refresh();
	requests[1]({ code: 0, stdout: JSON.stringify({ target: "wiki:wiki/b.md", status: "available", source: "active-writer", count: 2, generation: 3 }) });
	await second;
	requests[0]({ code: 0, stdout: JSON.stringify({ target: "wiki:wiki/a.md", status: "available", source: "active-writer", count: 9, generation: 2 }) });
	await first;
	assert.equal(indicator.displayForPath("repo/wiki/a.md"), null);
	assert.equal(indicator.displayForPath("repo/wiki/b.md").text, "2 open entries");
	assert.equal(indicator.displayForPath("repo/wiki/b.md").count, 2);
	const third = indicator.refresh();
	requests[2]({ code: 0, stdout: JSON.stringify({ target: "wiki:wiki/b.md", status: "available", source: "active-writer", count: 0, generation: 4 }) });
	await third;
	assert.equal(indicator.displayForPath("repo/wiki/b.md").text, "0 open entries");
	assert.equal(indicator.displayForPath("repo/wiki/b.md").count, 0);
});

test("a registered non-Git page reads its device-local ledger without a configured repo", async () => {
	const file = new TFile("note.md");
	const plugin = { app: { workspace: { getActiveFile: () => file }, vault: { adapter: new FileSystemAdapter() } } };
	const calls = [];
	const indicatorModule = loadTs("staleness-count-indicator.ts", {
		obsidian: { FileSystemAdapter, TFile, Plugin: class {} },
		fs: { existsSync: () => true },
		"./new-page": { loadWikis: () => [] },
		"./page-staleness-key": pageKey,
		"./staleness-count": count,
		"./non-git-staleness": { readVaultPage: async (...args) => {
			calls.push(args);
			return { count: 3, generation: 8, source: "active-writer" };
		} },
		"./paniolo": { findConfigRoot: () => null, resolveBinary: () => "paniolo", runPaniolo: () => { throw new Error("Git CLI called"); } },
	});
	const indicator = new indicatorModule.StalenessCountIndicator(plugin, () => "paniolo", () => {});
	await indicator.refresh();
	assert.equal(indicator.displayForPath("note.md").text, "3 open entries");
	assert.equal(calls[0][1], "note.md");
});
