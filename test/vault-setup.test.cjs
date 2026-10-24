const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const loadTs = require("./load-ts.cjs");

const { registerVault } = loadTs("paniolo.ts");
const { loadWikis, slugForAbsPath, wikiForAbsPath } = loadTs("new-page.ts", {
	obsidian: { Modal: class {}, Notice: class {}, Setting: class {}, TextComponent: class {} },
});

test("vault setup delegates the chosen root and slug to Paniolo", async () => {
	const calls = [];
	const run = async (binary, args, cwd) => {
		calls.push({ binary, args, cwd });
		return { code: 0, stdout: '{"name":"my-vault","root":".","changed":true}', stderr: "" };
	};
	const result = await registerVault("paniolo", path.join("C:", "My Vault"), run);
	assert.deepEqual(calls, [{
		binary: "paniolo",
		args: ["wiki", "init", "--root", path.join("C:", "My Vault"), "--slug", "My Vault", "--json"],
		cwd: path.join("C:", "My Vault"),
	}]);
	assert.deepEqual(result, { name: "my-vault", root: ".", changed: true });
	await assert.rejects(
		registerVault("paniolo", "C:/vault", async () => ({ code: 2, stdout: "", stderr: "slug conflicts" })),
		/slug conflicts/,
	);
});

test("flat and nested vault configs both select their Markdown pages", (context) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "paniolo-vault-setup-"));
	context.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const note = path.join(root, "note.md");
	fs.writeFileSync(note, "# Note\n");
	fs.writeFileSync(path.join(root, "paniolo.config.json"), JSON.stringify({
		name: "vault", wiki: { root: ".", domains: ["vault"] },
	}));
	const flat = loadWikis(root);
	assert.equal(flat.length, 1);
	assert.equal(flat[0].wikiRoot, ".");
	assert.equal(wikiForAbsPath(root, note, flat)?.name, "vault");
	assert.equal(slugForAbsPath(root, flat[0], note), "note");

	fs.mkdirSync(path.join(root, "wiki"));
	const nestedNote = path.join(root, "wiki", "page.md");
	fs.writeFileSync(nestedNote, "# Page\n");
	fs.writeFileSync(path.join(root, "paniolo.config.json"), JSON.stringify({
		wiki: { wikis: [{ name: "vault", root: "wiki", domains: ["vault"] }] },
	}));
	const nested = loadWikis(root);
	assert.equal(nested.length, 1);
	assert.equal(nested[0].wikiRoot, "wiki");
	assert.equal(wikiForAbsPath(root, nestedNote, nested)?.name, "vault");
	assert.equal(wikiForAbsPath(root, note, nested), null);
});

test("first-run setup offers once and waits for acceptance", async () => {
	const notices = [];
	const registrations = [];
	const prompts = [];
	class FileSystemAdapter {
		getBasePath() { return "C:/vault"; }
	}
	class ConfirmModal {
		constructor(_app, heading, _body, _label, confirm) {
			this.heading = heading;
			this.confirm = confirm;
		}
		open() { prompts.push(this); }
	}
	const empty = {};
	const { default: PanioloPlugin } = loadTs("main.ts", {
		obsidian: { Plugin: class {}, FileSystemAdapter, Notice: class { constructor(text) { notices.push(text); } } },
		"./lint": empty,
		"./paniolo": {
			findConfigRoot: () => null,
			resolveBinary: () => "paniolo",
			registerVault: async (binary, root) => {
				registrations.push({ binary, root });
				return { name: "vault", root: ".", changed: true };
			},
		},
		"./action-bar": empty,
		"./stats-modal": empty,
		"./shared-stats": empty,
		"./staleness-indicator": empty,
		"./staleness-count-indicator": empty,
		"./page-staleness": empty,
		"./page-staleness-completion": empty,
		"./non-git-vault": empty,
		"./non-git-page-modal": empty,
		"./non-git-review": empty,
		"./page-references": empty,
		"./page-sources": empty,
		"./related-pages": empty,
		"./search-pages": empty,
		"./new-page": empty,
		"./wiki-ops": { ConfirmModal },
		"./settings": empty,
	});
	const plugin = Object.create(PanioloPlugin.prototype);
	let linted = 0;
	plugin.app = {
		vault: { adapter: new FileSystemAdapter() },
		workspace: { getActiveFile: () => ({ extension: "md" }) },
	};
	plugin.settings = { binaryPath: "" };
	plugin.vaultSetupOffered = false;
	plugin.pollSharedStats = async () => {};
	plugin.lintActiveFile = async () => { linted++; };
	plugin.offerVaultSetup();
	plugin.offerVaultSetup();
	assert.equal(prompts.length, 1);
	assert.equal(prompts[0].heading, "Set up Paniolo for this vault");
	assert.deepEqual(registrations, []);
	prompts[0].confirm();
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(registrations, [{ binary: "paniolo", root: "C:/vault" }]);
	assert.equal(linted, 1);
	assert.equal(notices.length, 1);
});
