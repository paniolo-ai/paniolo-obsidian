const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const test = require("node:test");
const ts = require("typescript");
const { Text } = require("@codemirror/state");

const source = fs.readFileSync(path.join(__dirname, "../src/staleness-indicator.ts"), "utf8");
const compiled = ts.transpileModule(source, {
	compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const moduleUnderTest = { exports: {} };
const load = new Function("require", "module", "exports", compiled);
load((name) => name === "obsidian" || name === "./paniolo" ? {} : require(name), moduleUnderTest, moduleUnderTest.exports);
const { signalsToDiagnostics, parseExplorerStates } = moduleUnderTest.exports;

test("a signal at the second heading annotates only that heading", () => {
	const doc = Text.of(["# First", "Text", "## Second", "More text"]);
	const diagnostics = signalsToDiagnostics(doc, [{
		anchor: "first/second", entity: "code:src/routes.rs", commit: "abc123",
	}]);
	assert.equal(diagnostics.length, 1);
	assert.equal(diagnostics[0].from, doc.line(3).from);
	assert.equal(diagnostics[0].to, doc.line(3).to);
	assert.equal(diagnostics[0].severity, "info");
	assert.match(diagnostics[0].message, /code:src\/routes\.rs.*abc123/);
	assert.doesNotMatch(diagnostics[0].message, /is stale|wrong/i);
});

test("duplicate anchors, fenced headings, and removed headings do not misplace nominations", () => {
	const doc = Text.of(["# First", "## Second", "```", "## Second", "```", "## Second"]);
	const diagnostics = signalsToDiagnostics(doc, [
		{ anchor: "first/second-1", entity: "code:second", commit: "def456" },
		{ anchor: "first/missing", entity: "code:missing", commit: "def456" },
	]);
	assert.equal(diagnostics.length, 1);
	assert.equal(diagnostics[0].from, doc.line(6).from);
});

test("a corpus response maps three states to vault paths and rejects partial rows", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "paniolo-explorer-"));
	try {
		fs.writeFileSync(path.join(root, "paniolo.config.json"), JSON.stringify({
			repos: { wiki: { path: "wiki-repo" } },
		}));
		const documents = ["signals", "clean", "unwatched"].map((state, index) => ({
			repo: "wiki", path: `wiki/page-${index}.md`, state,
		}));
		const states = parseExplorerStates(JSON.stringify({ documents }), root, root);
		assert.equal(states.size, 3);
		assert.equal(states.get("wiki-repo/wiki/page-0.md"), "signals");
		assert.equal(states.get("wiki-repo/wiki/page-1.md"), "clean");
		assert.equal(states.get("wiki-repo/wiki/page-2.md"), "unwatched");
		assert.throws(() => parseExplorerStates(JSON.stringify({ documents: [
			{ repo: "wiki", path: "wiki/page.md", state: "unknown" },
		] }), root, root));
	} finally {
		assert.equal(path.dirname(root), os.tmpdir());
		assert.match(path.basename(root), /^paniolo-explorer-/);
		fs.rmSync(root, { recursive: true, force: true });
	}
});
