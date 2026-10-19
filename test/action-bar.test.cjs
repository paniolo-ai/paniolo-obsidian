const assert = require("node:assert/strict");
const test = require("node:test");
const loadTs = require("./load-ts.cjs");

class MarkdownView {}

class Menu {
	constructor() { this.items = []; Menu.last = this; }
	addSeparator() {}
	addItem(configure) {
		const item = {
			setTitle: (title) => { item.title = title; return item; },
			onClick: (callback) => { item.click = callback; return item; },
		};
		configure(item);
		this.items.push(item);
	}
	showAtMouseEvent() {}
}

test("the page footer stays one Paniolo menu and opens stats from it", () => {
	const commands = [];
	const button = { addEventListener: (_event, listener) => { button.click = listener; } };
	const bar = {
		empty: () => {},
		show: () => {},
		createEl: (_tag, options) => { assert.equal(options.text, "Paniolo ▸"); return button; },
		createSpan: () => { throw new Error("stats leaked into the footer"); },
	};
	const view = new MarkdownView();
	view.file = { path: "repo/wiki/page.md", extension: "md" };
	view.containerEl = { querySelector: () => bar };
	const plugin = {
		manifest: { id: "paniolo-obsidian" },
		app: {
			commands: { executeCommandById: (id) => { commands.push(id); return true; } },
			metadataCache: { getFileCache: () => null },
		},
	};
	const { ActionBar } = loadTs("action-bar.ts", { obsidian: { MarkdownView, Menu, Plugin: class {} } });
	new ActionBar(plugin).render(view);
	button.click({});
	const stats = Menu.last.items.find((item) => item.title === "view stats…");
	assert.ok(stats);
	stats.click();
	assert.deepEqual(commands, ["paniolo-obsidian:view-stats"]);
});
