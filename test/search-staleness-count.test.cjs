const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const loadTs = require("./load-ts.cjs");

const counts = loadTs("staleness-count.ts");
const root = path.resolve("test-vault");
const wiki = { name: "wiki", repoPath: "repo", wikiRoot: "repo/wiki" };
const rows = Array.from({ length: 10 }, (_, index) => ({
	file: path.join(root, "repo", "wiki", `page-${index}.md`),
	title: `Page ${index}`,
	snippet: "Excerpt",
	unresolvedStalenessCount: index,
	stalenessSource: index === 3 ? "snapshot" : "active-writer",
	stalenessGeneration: 12,
}));

class TFile {
	constructor(filePath) {
		this.path = filePath;
		this.basename = path.basename(filePath, ".md");
		this.extension = "md";
	}
}

class Modal {
	constructor(app) { this.app = app; this.contentEl = {}; }
	close() {}
}

class Setting {
	static rows = [];
	constructor() {
		this.nameEl = { createSpan: (badge) => { this.badge = badge; } };
		Setting.rows.push(this);
	}
	setName(name) { this.name = name; return this; }
	setDesc(description) { this.description = description; return this; }
	addButton(callback) {
		const button = { setButtonText: () => button, setDisabled: () => button, onClick: () => button };
		callback(button);
		return this;
	}
}

class Menu {
	static titles = [];
	addItem(callback) {
		const item = { setTitle: (title) => { Menu.titles.push(title); return item; }, onClick: () => item };
		callback(item);
		return this;
	}
	showAtPosition() {}
}

class Notice { hide() {} }

const app = {
	vault: { getAbstractFileByPath: (filePath) => new TFile(filePath) },
	workspace: { getActiveViewOfType: () => null },
};
const newPage = { loadWikis: () => [wiki], wikiForAbsPath: () => wiki };

test("ten search rows use one qmd response and preserve distinct count badges", async () => {
	let calls = 0;
	Setting.rows = [];
	const search = loadTs("search-pages.ts", {
		obsidian: { Modal, Setting, TFile, Notice },
		"./new-page": newPage,
		"./staleness-count": counts,
		"./paniolo": { runPaniolo: async () => { calls++; return { code: 0, stdout: JSON.stringify({ results: rows }) }; } },
	});
	const modal = new search.SearchPagesModal({ app, configRoot: root, vaultRoot: root, binary: "paniolo", sourceView: null });
	modal.queryInput = { value: "page" };
	modal.resultsEl = { empty() {}, setText() {} };
	await modal.search();
	assert.equal(calls, 1);
	assert.equal(Setting.rows.length, 10);
	assert.match(Setting.rows[0].badge.text, /^0 open entries$/);
	assert.match(Setting.rows[3].badge.text, /3 open entries \(snapshot\)/);
	assert.match(Setting.rows[9].badge.text, /^9 open entries$/);
});

test("five related and selection results carry counts from their one qmd call", async () => {
	let calls = 0;
	Menu.titles = [];
	const previousWindow = global.window;
	global.window = { innerWidth: 800, innerHeight: 600 };
	try {
		const related = loadTs("related-pages.ts", {
			obsidian: { Menu, Notice, TFile, MarkdownView: class {} },
			"./new-page": newPage,
			"./staleness-count": counts,
			"./paniolo": { runPaniolo: async () => { calls++; return { code: 0, stdout: JSON.stringify({ results: rows }) }; } },
		});
		await related.searchRelatedPages({ app, file: new TFile("repo/wiki/current.md"), configRoot: root, vaultRoot: root, binary: "paniolo", selectedText: "selected text" });
		assert.equal(calls, 1);
		assert.equal(Menu.titles.length, 5);
		assert.match(Menu.titles[0], /0 open entries/);
		assert.match(Menu.titles[3], /3 open entries \(snapshot\)/);
	} finally {
		global.window = previousWindow;
	}
});
