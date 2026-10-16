const assert = require("node:assert/strict");
const test = require("node:test");
const loadTs = require("./load-ts.cjs");

const { parseVaultPageRead, readVaultPage } = loadTs("non-git-staleness.ts", {
	"./non-git-vault": { deviceStatePath: () => "C:/device/vault-state" },
	"./paniolo": { resolveBinary: () => "paniolo" },
});

const vaultId = "a".repeat(32);
const pageId = "b".repeat(32);
const id = `S-${"c".repeat(16)}`;
const response = { vaultId, pageId, page: "note.md", source: "active-writer", generation: 4, count: 1,
	entries: [{ id, anchor: "intro", state: "pending-verification", revision: 0 }] };

test("vault count and complete list retain the stable page identity and writer provenance", async () => {
	const calls = [];
	const run = async (_binary, args) => {
		calls.push(args);
		return { code: 0, stdout: JSON.stringify(response), stderr: "" };
	};
	const count = await readVaultPage("C:/vault", "note.md", "paniolo", false, run);
	const list = await readVaultPage("C:/vault", "note.md", "paniolo", true, run);
	assert.equal(count.count, 1);
	assert.equal(count.source, "active-writer");
	assert.equal(list.entries[0].id, id);
	assert.deepEqual(calls.map((args) => args[1]), ["vault-counts", "vault-list"]);
	assert.equal(calls[0][calls[0].indexOf("--device-state") + 1], "C:/device/vault-state");
});

test("cross-page, incomplete, and nonwriter responses never look like zero", async () => {
	assert.throws(() => parseVaultPageRead(JSON.stringify({ ...response, page: "other.md" }), "note.md", true), /invalid/);
	assert.throws(() => parseVaultPageRead(JSON.stringify({ ...response, entries: [] }), "note.md", true), /incomplete/);
	await assert.rejects(readVaultPage("C:/vault", "note.md", "paniolo", false,
		async () => ({ code: 1, stdout: "", stderr: "writer refused" })), /writer refused/);
});
