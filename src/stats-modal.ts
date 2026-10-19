import { Modal, Setting, type App } from "obsidian";

export type StatsSnapshot = {
	page: string;
	activity: string;
	activityTone: "normal" | "busy" | "error";
	lint: string;
	watchedChanges: string;
	openEntries: string;
	pageReport: string;
	canCheckLint: boolean;
	linting: boolean;
	canReviewStaleness: boolean;
};

/** Keep the editor footer compact while retaining the current page's readings. */
export class StatsModal extends Modal {
	constructor(
		app: App,
		private getSnapshot: () => StatsSnapshot,
		private onCheckLint: () => Promise<void>,
		private onReviewStaleness: () => void,
		private onRefresh: () => Promise<void>,
		private onClosed: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.render();
	}

	onClose(): void {
		this.onClosed();
		this.contentEl.empty();
	}

	/** Update readings while the modal is open as background checks finish. */
	render(): void {
		const snapshot = this.getSnapshot();
		this.contentEl.empty();
		this.contentEl.createEl("h2", { text: "Paniolo stats" });
		this.contentEl.createEl("p", { text: snapshot.page, cls: "paniolo-stats-page" });
		const activity = new Setting(this.contentEl).setName("Activity").setDesc(snapshot.activity);
		if (snapshot.activityTone !== "normal") {
			activity.settingEl.classList.add(`paniolo-stats-activity-${snapshot.activityTone}`);
		}
		new Setting(this.contentEl)
			.setName("Lint")
			.setDesc(snapshot.lint)
			.addButton((button) => button
				.setButtonText(snapshot.linting ? "Linting…" : "Check lint")
				.setDisabled(!snapshot.canCheckLint)
				.onClick(() => { void this.onCheckLint(); }));
		new Setting(this.contentEl).setName("Watched changes").setDesc(snapshot.watchedChanges);
		new Setting(this.contentEl).setName("Open staleness entries").setDesc(snapshot.openEntries);
		new Setting(this.contentEl).setName("Page report").setDesc(snapshot.pageReport);
		if (snapshot.canReviewStaleness) {
			new Setting(this.contentEl)
				.setName("Review staleness")
				.setDesc("Inspect open entries and continue the page's repair flow.")
				.addButton((button) => button
					.setButtonText("Review & repair…")
					.onClick(() => {
						this.close();
						this.onReviewStaleness();
					}));
		}
		new Setting(this.contentEl)
			.setName("Refresh stats")
			.setDesc("Recheck watched changes, open entries, and page report status.")
			.addButton((button) => button
				.setButtonText("Refresh")
				.onClick(() => { void this.onRefresh(); }));
	}
}
