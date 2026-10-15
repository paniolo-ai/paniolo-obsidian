const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { createHash } = require("node:crypto");
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
		"./page-staleness-patch": loadTs("page-staleness-patch.ts"),
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
	let started;
	const commandStarted = new Promise((resolve) => { started = resolve; });
	const editorText = "# current editor\n";
	const hash = createHash("sha256").update(editorText).digest("hex");
	const runPaniolo = async (_binary, args) => {
		calls.push(args);
		if (args.includes("run")) {
			assert.equal(fs.readFileSync(args[args.indexOf("--page-snapshot-file") + 1], "utf8"), editorText);
			assert.equal(args[args.indexOf("--page-snapshot-sha256") + 1], hash);
			started();
			return new Promise((resolve) => { releaseSubmission = resolve; });
		}
		return { code: 0, stdout: JSON.stringify({ id: "R1", kind: "page", mode: "report", state: "succeeded", targets: [target], estimate: { page: { snapshot_sha256: hash } }, history: [] }) };
	};
	const { PageStaleness } = makeModule(runPaniolo);
	const saved = {};
	const plugin = { app: { workspace: { getActiveFile: () => file, getActiveViewOfType: () => ({ file, editor: { getValue: () => editorText } }) }, vault: { adapter: new FileSystemAdapter() } } };
	const makeController = () => new PageStaleness(plugin, () => "", (key) => saved[key] ?? null, async (key, id) => { saved[key] = id; });
	const controller = makeController();
	const context = { file, configRoot: root, target };
	const first = controller.submit(context);
	const second = controller.submit(context);
	await commandStarted;
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0].slice(0, 7), ["stale", "--root", root, "run", "--page", target, "--detach"]);
	assert.equal(saved[`${target}@sha256:${hash}`], undefined);
	const submission = { runId: "R1", target, mode: "report", state: "queued", estimate: { page: { snapshot_sha256: hash } } };
	assert.equal(typeof releaseSubmission, "function");
	releaseSubmission({ code: 0, stdout: JSON.stringify(submission) });
	await Promise.all([first, second]);
	assert.equal(saved[`${target}@sha256:${hash}`], "R1");
	const reloaded = makeController();
	await reloaded.refreshActiveRun(true);
	assert.equal(reloaded.getLastRun(target).state, "succeeded");
	assert.equal(calls.filter((args) => args.includes("run")).length, 1);
	assert.ok(calls.some((args) => args.join(" ").includes("runs show R1 --json")));
});

test("an edit during submission keeps the old report attached only to its original snapshot", async () => {
	let editorText = "# first\n";
	const firstHash = createHash("sha256").update(editorText).digest("hex");
	let releaseSubmission;
	let started;
	const commandStarted = new Promise((resolve) => { started = resolve; });
	const calls = [];
	const runPaniolo = async (_binary, args) => {
		calls.push(args);
		if (!args.includes("run")) throw new Error("no saved run for this edit");
		const hash = args[args.indexOf("--page-snapshot-sha256") + 1];
		if (hash === firstHash) {
			started();
			return new Promise((resolve) => { releaseSubmission = () => resolve({ code: 0, stdout: JSON.stringify({ runId: "R1", target, mode: "report", estimate: { page: { snapshot_sha256: hash } } }) }); });
		}
		return { code: 0, stdout: JSON.stringify({ runId: "R2", target, mode: "report", estimate: { page: { snapshot_sha256: hash } } }) };
	};
	const { PageStaleness } = makeModule(runPaniolo);
	const saved = {};
	const plugin = { app: { workspace: { getActiveFile: () => file, getActiveViewOfType: () => ({ file, editor: { getValue: () => editorText } }) }, vault: { adapter: new FileSystemAdapter() } } };
	const controller = new PageStaleness(plugin, () => "", (key) => saved[key] ?? null, async (key, id) => { saved[key] = id; });
	const context = { file, configRoot: root, target };
	const first = controller.submit(context);
	await commandStarted;
	editorText = "# second\n";
	releaseSubmission();
	await assert.rejects(first, /editor changed during report submission/);
	assert.equal(saved[`${target}@sha256:${firstHash}`], "R1");
	assert.equal(controller.getSavedRunId(target), null);
	await controller.submit(context);
	const secondHash = createHash("sha256").update(editorText).digest("hex");
	assert.equal(saved[`${target}@sha256:${secondHash}`], "R2");
	assert.equal(calls.filter((args) => args.includes("run")).length, 2);
});

test("report replies must match the selected page and saved ID", () => {
	const { parsePageRunSubmission, parsePageRunRecord } = makeModule(() => {});
	assert.throws(() => parsePageRunSubmission(JSON.stringify({ status: "unavailable", reason: "page has uncommitted changes" }), target), /uncommitted changes/);
	assert.throws(() => parsePageRunSubmission(JSON.stringify({ runId: "R1", target: "wiki:wiki/b.md", mode: "report" }), target), /exact report/);
	assert.throws(() => parsePageRunRecord(JSON.stringify({ id: "R1", kind: "page", mode: "report", state: "succeeded", targets: ["wiki:wiki/b.md"] }), "R1", target), /no longer matches/);
	assert.throws(() => parsePageRunSubmission(JSON.stringify({ runId: "R1", target, mode: "report", estimate: { page: { snapshot_sha256: "old" } } }), target, "new"), /different editor bytes/);
	assert.throws(() => parsePageRunRecord(JSON.stringify({ id: "R1", kind: "page", mode: "report", state: "succeeded", targets: [target], estimate: { page: { snapshot_sha256: "old" } } }), "R1", target, "new"), /different editor snapshot/);
});

test("a reviewed patch creates one undoable editor edit only on a topic branch with matching bytes", async () => {
	let editorText = "# API\nold\n";
	const original = editorText;
	const hash = createHash("sha256").update(editorText).digest("hex");
	const patch = "--- a/wiki/a.md\n+++ b/wiki/a.md\n@@ -1,2 +1,2 @@\n # API\n-old\n+new\n";
	let branch = "main";
	let changeDuringBranchCheck = false;
	const replacements = [];
	const runPaniolo = async (binary, args) => {
		if (binary === "git") {
			const command = args.slice(2).join(" ");
			if (command === "rev-parse --show-toplevel") {
				if (changeDuringBranchCheck) editorText = "# API\nlater edit\n";
				return { code: 0, stdout: path.resolve(root, "repo") };
			}
			if (command === "symbolic-ref --quiet --short HEAD") return { code: 0, stdout: branch };
			if (command === "symbolic-ref --quiet --short refs/remotes/origin/HEAD") return { code: 0, stdout: "origin/main" };
			throw new Error(`unexpected Git command: ${command}`);
		}
		assert.ok(args.join(" ").includes("runs patches R1 --json"));
		return { code: 0, stdout: JSON.stringify({ runId: "R1", target, snapshotSha256: hash, patches: [{ allegationId: "S1", bundleId: "B1", patchHash: "ph", anchor: "api", patch }] }) };
	};
	const editor = {
		getValue: () => editorText,
		lastLine: () => editorText.split("\n").length - 1,
		getLine: (line) => editorText.split("\n")[line],
		replaceRange: (replacement, from, to) => {
			replacements.push({ from, to, previous: editorText });
			editorText = replacement;
		},
	};
	const plugin = { app: { workspace: { getActiveFile: () => file, getActiveViewOfType: () => ({ file, editor }) }, vault: { adapter: new FileSystemAdapter() } } };
	const { PageStaleness } = makeModule(runPaniolo);
	const controller = new PageStaleness(plugin, () => "", () => null, async () => {});
	const context = { file, configRoot: root, target };
	const report = { id: "R1", state: "succeeded", reason: "", snapshotHash: hash };
	const reviewed = await controller.reviewedPatches(context, report);
	assert.equal(reviewed.patches.length, 1);
	await assert.rejects(controller.applyPatch(context, reviewed, reviewed.patches[0]), /topic branch/);
	assert.equal(editorText, original);
	branch = "codex/fix-page";
	await controller.applyPatch(context, reviewed, reviewed.patches[0]);
	assert.equal(editorText, "# API\nnew\n");
	assert.equal(replacements.length, 1);
	assert.deepEqual(replacements[0].from, { line: 0, ch: 0 });
	assert.deepEqual(replacements[0].to, { line: 2, ch: 0 });
	editorText = replacements.pop().previous;
	assert.equal(editorText, original, "one undo step restores the editor buffer");
	changeDuringBranchCheck = true;
	await assert.rejects(controller.applyPatch(context, reviewed, reviewed.patches[0]), /changed before patch acceptance/);
	assert.equal(replacements.length, 0);
	changeDuringBranchCheck = false;
	editorText = "# API\nlater edit\n";
	await assert.rejects(controller.applyPatch(context, reviewed, reviewed.patches[0]), /editor changed/);
	assert.equal(replacements.length, 0);
});
