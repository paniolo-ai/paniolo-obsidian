import { App, Modal, Setting } from "obsidian";
import { readVaultPage } from "./non-git-staleness";

/** Read-only page panel for a registered vault until saved-byte closure exists. */
export class NonGitPageStalenessModal extends Modal {
	private request = 0;

	constructor(app: App, private vaultRoot: string, private page: string, private binaryPath: string) {
		super(app);
	}

	onOpen(): void {
		this.contentEl.createEl("h3", { text: "Page staleness" });
		this.contentEl.createEl("p", { text: this.page });
		const entriesEl = this.contentEl.createDiv({ cls: "paniolo-page-entries" });
		this.contentEl.createEl("p", { text: "Entries remain open until independent saved-page review and writer-owned closure are available." });
		new Setting(this.contentEl).setName("Refresh entries")
			.addButton((button) => button.setButtonText("Refresh").onClick(() => { void this.load(entriesEl); }));
		void this.load(entriesEl);
	}

	onClose(): void {
		this.request++;
		this.contentEl.empty();
	}

	private async load(entriesEl: HTMLElement): Promise<void> {
		const request = ++this.request;
		entriesEl.setText("Loading open entries…");
		try {
			const result = await readVaultPage(this.vaultRoot, this.page, this.binaryPath, true);
			if (request !== this.request) return;
			entriesEl.empty();
			entriesEl.createEl("p", { text: `${result.count} open entr${result.count === 1 ? "y" : "ies"} · writer generation ${result.generation}` });
			for (const entry of result.entries ?? []) {
				new Setting(entriesEl).setName(`${entry.id} · ${entry.state}`)
					.setDesc(`Heading: ${entry.anchor || "page"} · revision ${entry.revision}`);
			}
		} catch (error: unknown) {
			if (request === this.request) entriesEl.setText(`Open entries unavailable: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}
