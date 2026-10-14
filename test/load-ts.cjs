const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

/** Load one local TypeScript module with explicit Obsidian and CLI test doubles. */
module.exports = function loadTs(name, replacements = {}) {
	const source = fs.readFileSync(path.join(__dirname, "../src", name), "utf8");
	const compiled = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	}).outputText;
	const loaded = { exports: {} };
	new Function("require", "module", "exports", compiled)(
		(request) => Object.hasOwn(replacements, request) ? replacements[request] : require(request),
		loaded,
		loaded.exports,
	);
	return loaded.exports;
};
