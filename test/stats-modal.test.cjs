const assert = require("node:assert/strict");
const test = require("node:test");
const loadTs = require("./load-ts.cjs");

class Modal {
	constructor() {
		this.contentEl = {
			empty: () => { Setting.items = []; },
			createEl: () => {},
		};
	}
	open() { this.onOpen(); }
	close() { this.onClose(); }
}

class Setting {
	static items = [];
	constructor() {
		this.classes = new Set();
		this.settingEl = { classList: { add: (name) => this.classes.add(name) } };
		Setting.items.push(this);
	}
	setName(name) { this.name = name; return this; }
	setDesc(description) { this.description = description; return this; }
	addButton(configure) {
		this.button = {
			setButtonText: (text) => { this.button.text = text; return this.button; },
			setDisabled: (disabled) => { this.button.disabled = disabled; return this.button; },
			onClick: (click) => { this.button.click = click; return this.button; },
		};
		configure(this.button);
		return this;
	}
}

test("stats modal offers lint and refresh, and shows repair only for open entries", async () => {
	const actions = [];
	const snapshot = {
		page: "wiki/page.md", activity: "ready", activityTone: "normal", lint: "No findings",
		watchedChanges: "No watched changes", openEntries: "0 open entries",
		pageReport: "No report for this edit", canCheckLint: true, linting: false, canReviewStaleness: false,
		sharedStats: [{ name: "Index activity", value: "available (cached-observation) · embedding" }],
	};
	const { StatsModal } = loadTs("stats-modal.ts", { obsidian: { Modal, Setting } });
	const modal = new StatsModal({}, () => snapshot,
		async () => { actions.push("lint"); },
		() => { actions.push("review"); },
		async () => { actions.push("refresh"); },
		() => { actions.push("closed"); });
	modal.open();
	assert.equal(Setting.items.some((item) => item.name === "Review staleness"), false);
	const lint = Setting.items.find((item) => item.name === "Lint");
	assert.equal(lint.description, "No findings");
	assert.equal(lint.button.text, "Check lint");
	assert.equal(lint.button.disabled, false);
	assert.equal(Setting.items.find((item) => item.name === "Index activity").description,
		"available (cached-observation) · embedding");
	lint.button.click();
	Setting.items.find((item) => item.name === "Refresh stats").button.click();
	await Promise.resolve();
	assert.deepEqual(actions, ["lint", "refresh"]);

	snapshot.openEntries = "2 open entries";
	snapshot.canReviewStaleness = true;
	modal.render();
	Setting.items.find((item) => item.name === "Review staleness").button.click();
	assert.deepEqual(actions, ["lint", "refresh", "closed", "review"]);
});

test("lint progress disables the inline button and highlights activity until completion", () => {
	const snapshot = {
		page: "wiki/page.md", activity: "linting…", activityTone: "busy", lint: "No findings",
		watchedChanges: "No watched changes", openEntries: "0 open entries",
		pageReport: "No report for this edit", canCheckLint: false, linting: true, canReviewStaleness: false,
	};
	const { StatsModal } = loadTs("stats-modal.ts", { obsidian: { Modal, Setting } });
	const modal = new StatsModal({}, () => snapshot, async () => {}, () => {}, async () => {}, () => {});
	modal.open();
	assert.equal(Setting.items.find((item) => item.name === "Lint").button.disabled, true);
	assert.equal(Setting.items.find((item) => item.name === "Lint").button.text, "Linting…");
	assert.equal(Setting.items.find((item) => item.name === "Activity").classes.has("paniolo-stats-activity-busy"), true);

	snapshot.activity = "clean";
	snapshot.activityTone = "normal";
	snapshot.canCheckLint = true;
	snapshot.linting = false;
	modal.render();
	assert.equal(Setting.items.find((item) => item.name === "Lint").button.disabled, false);
	assert.equal(Setting.items.find((item) => item.name === "Activity").classes.size, 0);

	snapshot.activity = "error";
	snapshot.activityTone = "error";
	modal.render();
	assert.equal(Setting.items.find((item) => item.name === "Activity").classes.has("paniolo-stats-activity-error"), true);
});
