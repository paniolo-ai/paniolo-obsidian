const assert = require("node:assert/strict");
const test = require("node:test");
const loadTs = require("./load-ts.cjs");

class Element {
	text = "";
	children = [];
	createEl(_name, options = {}) { const child = new Element(); child.text = options.text ?? ""; this.children.push(child); return child; }
	createDiv() { const child = new Element(); this.children.push(child); return child; }
	setText(value) { this.text = value; }
	empty() { this.text = ""; this.children = []; }
}
class Modal {
	constructor(app) { this.app = app; this.contentEl = new Element(); }
}
class Setting {
	constructor(element) { this.element = element; }
	setName() { return this; }
	setDesc() { return this; }
	addButton(callback) {
		callback({ setButtonText() { return this; }, setWarning() { return this; }, onClick() { return this; } });
		return this;
	}
}
class TFile { constructor(path) { this.path = path; } }
class MarkdownView {}

const page = new TFile("note.md");
const current = { vaultId: "a".repeat(32), pageId: "b".repeat(32), page: page.path,
	source: "active-writer", generation: 4, count: 1,
	entries: [{ id: `S-${"c".repeat(16)}`, state: "pending-verification", revision: 0, anchor: "intro" }] };
const plan = { id: `VR-${"d".repeat(64)}`, vaultId: current.vaultId, pageId: current.pageId,
	page: page.path, savedSha256: "e".repeat(64), maximumRoleInvocations: 6,
	subjects: [{ id: current.entries[0].id, state: "pending-verification", revision: 0 }] };

function makeModal(editorText, closeCalls) {
	const app = { vault: { getAbstractFileByPath: () => page, read: async () => "saved" },
		workspace: { getActiveViewOfType: () => ({ file: page, editor: { getValue: () => editorText } }) } };
	const { NonGitPageStalenessModal } = loadTs("non-git-page-modal.ts", {
		obsidian: { App: class {}, MarkdownView, Modal, Setting, TFile },
		"./non-git-staleness": { readVaultPage: async () => closeCalls.includes("close")
			? { ...current, count: 0, generation: 5, entries: [] } : current },
		"./non-git-review": {
			assertSavedEditor: (editor, saved) => { if (editor !== saved) throw new Error("unsaved editor"); },
			showVaultReview: async () => ({ state: "complete", results: [{ id: current.entries[0].id, revision: 0, outcome: "fresh" }] }),
			closeVaultReview: async () => { closeCalls.push("close"); return { state: "complete", count: 0, generation: 5 }; },
			submitVaultReview: async () => { throw new Error("reload must not submit"); },
		},
	});
	const modal = new NonGitPageStalenessModal(app, "C:/vault", page.path, "paniolo",
		() => plan, async () => {}, () => { closeCalls.push("refresh"); });
	modal.entriesEl = new Element();
	modal.reviewEl = new Element();
	return modal;
}

test("reload resumes a saved favorable review and reaches current-writer zero without resubmission", async () => {
	const calls = [];
	const modal = makeModal("saved", calls);
	await modal.load();
	assert.deepEqual(calls.slice(0, 2), ["close", "refresh"]);
	assert.match(modal.reviewEl.text, /Current writer: 0/);
});

test("an unsaved editor buffer keeps closure pending after a favorable review", async () => {
	const calls = [];
	const modal = makeModal("undo not saved", calls);
	await modal.load();
	assert.deepEqual(calls, []);
	assert.match(modal.reviewEl.text, /Closure pending: unsaved editor/);
});
