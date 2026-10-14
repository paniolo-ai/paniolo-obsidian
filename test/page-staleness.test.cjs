const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const loadTs = require("./load-ts.cjs");

class FileSystemAdapter { getBasePath() { return root; } }
class TFile {
	constructor(filePath) { this.path = filePath; this.extension = "md"; }
}

const root = path.resolve("test-vault");
const target = "wiki:wiki/a.md";
const file = new TFile("repo/wiki/a.md");
const pageKey = loadTs("page-staleness-key.ts");

function makeModule(runPaniolo, ui = {}) {
	return loadTs("page-staleness.ts", {
		obsidian: { FileSystemAdapter, TFile, Plugin: class {}, Modal: class {}, Notice: class {}, Setting: class {}, MarkdownView: class {}, ...ui },
		"@codemirror/state": { Text: { of: () => ({}) } },
		"./new-page": { loadWikis: () => [{ name: "wiki", repoPath: "repo", wikiRoot: "repo/wiki" }] },
		"./page-staleness-key": pageKey,
		"./staleness-indicator": { headingLineForAnchor: () => null },
		"./paniolo": { findConfigRoot: () => root, resolveBinary: () => "paniolo", runPaniolo },
	});
}

test("the panel parser retains all nine open IDs and rejects partial or foreign responses", () => {
	const { parseOpenEntries } = makeModule(() => {});
	const entries = Array.from({ length: 9 }, (_, i) => ({ id: `A${i}`, state: "alleged", anchor: i ? `heading-${i}` : "", revision: 1 }));
	const response = { target, status: "available", source: "snapshot", generation: 17, count: 9, entries };
	const parsed = parseOpenEntries(JSON.stringify(response), target);
	assert.deepEqual(parsed.entries.map((entry) => entry.id), entries.map((entry) => entry.id));
	assert.equal(parsed.entries[0].anchor, "");
	assert.equal(parsed.source, "snapshot");
	assert.throws(() => parseOpenEntries(JSON.stringify({ ...response, count: 8 }), target), /incomplete/);
	assert.throws(() => parseOpenEntries(JSON.stringify({ ...response, target: "wiki:wiki/b.md" }), target), /invalid page/);
});

test("the on-demand panel renders all nine entries and retains a missing heading's evidence", async () => {
	const names = [];
	const descriptions = [];
	const buttons = [];
	class Element {
		createEl() { return new Element(); }
		createDiv() { return new Element(); }
		setText(value) { this.text = value; }
		empty() {}
	}
	class Modal {
		constructor(app) { this.app = app; this.contentEl = new Element(); }
		open() { this.onOpen(); }
	}
	class Setting {
		setName(name) { names.push(name); return this; }
		setDesc(description) { descriptions.push(description); return this; }
		addButton(callback) {
			const button = { setButtonText(label) { buttons.push(label); return this; }, onClick() { return this; } };
			callback(button);
			return this;
		}
	}
	const entries = Array.from({ length: 9 }, (_, index) => ({ id: `A${index}`, state: "alleged", anchor: index ? `missing-${index}` : "", revision: 1 }));
	const { PageStaleness } = makeModule(async () => ({ code: 0, stdout: JSON.stringify({ target, status: "available", source: "active-writer", generation: 4, count: 9, entries }) }), { Modal, Setting });
	const plugin = { app: { workspace: { getActiveFile: () => file }, vault: { adapter: new FileSystemAdapter() } } };
	new PageStaleness(plugin, () => "", () => null, async () => {}).openActivePage();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(names.filter((name) => /^A\d · alleged$/.test(name)).length, 9);
	assert.ok(descriptions.some((description) => description.includes("missing-1")));
	assert.equal(buttons.filter((label) => label === "Evidence").length, 9);
	assert.equal(buttons.filter((label) => label === "Jump to heading").length, 9);
});

test("one detached exact-page report is saved, concurrent clicks join, and reload polls the saved ID", async () => {
	const calls = [];
	let releaseSubmission;
	const runPaniolo = async (_binary, args) => {
		calls.push(args);
		if (args.includes("run")) return new Promise((resolve) => { releaseSubmission = resolve; });
		return { code: 0, stdout: JSON.stringify({ id: "R1", kind: "page", mode: "report", state: "succeeded", targets: [target], history: [] }) };
	};
	const { PageStaleness } = makeModule(runPaniolo);
	const saved = {};
	const plugin = { app: { workspace: { getActiveFile: () => file }, vault: { adapter: new FileSystemAdapter() } } };
	const makeController = () => new PageStaleness(plugin, () => "", (key) => saved[key] ?? null, async (key, id) => { saved[key] = id; });
	const controller = makeController();
	const context = { file, configRoot: root, target };
	const first = controller.submit(context);
	const second = controller.submit(context);
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0], ["stale", "--root", root, "run", "--page", target, "--detach"]);
	assert.equal(saved[target], undefined);
	const submission = { runId: "R1", target, mode: "report", state: "queued" };
	assert.equal(typeof releaseSubmission, "function");
	releaseSubmission({ code: 0, stdout: JSON.stringify(submission) });
	await Promise.all([first, second]);
	assert.equal(saved[target], "R1");
	const reloaded = makeController();
	await reloaded.refreshActiveRun(true);
	assert.equal(reloaded.getLastRun(target).state, "succeeded");
	assert.equal(calls.filter((args) => args.includes("run")).length, 1);
	assert.ok(calls.some((args) => args.join(" ").includes("runs show R1 --json")));
});

test("report replies must match the selected page and saved ID", () => {
	const { parsePageRunSubmission, parsePageRunRecord } = makeModule(() => {});
	assert.throws(() => parsePageRunSubmission(JSON.stringify({ status: "unavailable", reason: "page has uncommitted changes" }), target), /uncommitted changes/);
	assert.throws(() => parsePageRunSubmission(JSON.stringify({ runId: "R1", target: "wiki:wiki/b.md", mode: "report" }), target), /exact report/);
	assert.throws(() => parsePageRunRecord(JSON.stringify({ id: "R1", kind: "page", mode: "report", state: "succeeded", targets: ["wiki:wiki/b.md"] }), "R1", target), /no longer matches/);
});
