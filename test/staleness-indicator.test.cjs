const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
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
const { signalsToDiagnostics } = moduleUnderTest.exports;

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
