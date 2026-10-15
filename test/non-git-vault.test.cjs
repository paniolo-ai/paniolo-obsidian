const assert = require("node:assert/strict");
const test = require("node:test");
const loadTs = require("./load-ts.cjs");

const { deviceStatePath, readVaultWriterState, registerNonGitPage } = loadTs("non-git-vault.ts", {
	"./paniolo": { resolveBinary: (value) => value || "paniolo", runPaniolo: () => { throw new Error("use fake CLI"); } },
});

test("status is read-only and secondary refusal survives reload", async () => {
	const calls = [];
	const run = async (_binary, args) => {
		calls.push(args);
		return { code: 0, stdout: '"refused"', stderr: "" };
	};
	assert.equal(await readVaultWriterState("C:/vault", "paniolo", run, () => false), "unregistered");
	assert.equal(calls.length, 0);
	assert.equal(await readVaultWriterState("C:/vault", "paniolo", run, () => true), "refused");
	assert.deepEqual(calls.map((args) => args[1]), ["vault-status"]);
	assert.equal(deviceStatePath("C:/vault", "C:/device"), deviceStatePath("C:/vault", "C:/device"));
});

test("registration claims explicitly, then registers only the selected page", async () => {
	const calls = [];
	const run = async (_binary, args) => {
		calls.push(args);
		const responses = {
			"vault-register": { schema: 1, vault_id: "a".repeat(32) },
			"vault-status": "unclaimed",
			"vault-claim": "owned",
			"page-register": { vault_id: "a".repeat(32), page_id: "b".repeat(32), page: "note.md" },
		};
		return { code: 0, stdout: JSON.stringify(responses[args[1]]), stderr: "" };
	};
	const result = await registerNonGitPage("C:/vault", "note.md", "paniolo", run, () => false);
	assert.deepEqual(result, { vaultId: "a".repeat(32), pageId: "b".repeat(32) });
	assert.deepEqual(calls.map((args) => args[1]), ["vault-register", "vault-status", "vault-claim", "page-register"]);
	assert.equal(calls.at(-1).at(-1), "note.md");
});

test("refused writer and unsafe page never register the page", async () => {
	const calls = [];
	const run = async (_binary, args) => {
		calls.push(args);
		return { code: 0, stdout: '"refused"', stderr: "" };
	};
	await assert.rejects(registerNonGitPage("C:/vault", "../other.md", "paniolo", run, () => true), /select one/);
	assert.equal(calls.length, 0);
	await assert.rejects(registerNonGitPage("C:/vault", "note.md", "paniolo", run, () => true), /does not own/);
	assert.deepEqual(calls.map((args) => args[1]), ["vault-status"]);
});

test("a registered writer resumes without another claim", async () => {
	const calls = [];
	const run = async (_binary, args) => {
		calls.push(args);
		return { code: 0, stdout: JSON.stringify(args[1] === "vault-status" ? "owned"
			: { vault_id: "a".repeat(32), page_id: "b".repeat(32) }), stderr: "" };
	};
	assert.equal(await readVaultWriterState("C:/vault", "paniolo", run, () => true), "owned");
	await registerNonGitPage("C:/vault", "note.md", "paniolo", run, () => true);
	assert.deepEqual(calls.map((args) => args[1]), ["vault-status", "vault-status", "page-register"]);
});
