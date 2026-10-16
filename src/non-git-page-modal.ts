import { App, MarkdownView, Modal, Setting, TFile } from "obsidian";
import { readVaultPage, type VaultPageRead } from "./non-git-staleness";
import {
	assertSavedEditor, closeVaultReview, inspectVaultReview, showVaultReview, submitVaultReview,
	type VaultReviewPlan,
} from "./non-git-review";

/** Review and close one registered non-Git page through its local writer. */
export class NonGitPageStalenessModal extends Modal {
	private request = 0;
	private timer: number | null = null;
	private entriesEl!: HTMLElement;
	private reviewEl!: HTMLElement;
	private closed = false;

	constructor(
		app: App,
		private vaultRoot: string,
		private page: string,
		private binaryPath: string,
		private getReview: (key: string) => VaultReviewPlan | null,
		private saveReview: (key: string, plan: VaultReviewPlan) => Promise<void>,
		private refreshCount: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.closed = false;
		this.contentEl.createEl("h3", { text: "Page staleness" });
		this.contentEl.createEl("p", { text: this.page });
		this.entriesEl = this.contentEl.createDiv({ cls: "paniolo-page-entries" });
		this.reviewEl = this.contentEl.createDiv({ cls: "paniolo-page-review" });
		this.reviewEl.setText("Edit the page, save it, then inspect the independent review scope.");
		new Setting(this.contentEl).setName("Refresh entries")
			.addButton((button) => button.setButtonText("Refresh").onClick(() => { void this.load(); }));
		new Setting(this.contentEl).setName("Review saved page")
			.setDesc("Inspect current saved bytes and every open allegation before starting a background model review.")
			.addButton((button) => button.setButtonText("Inspect saved page").onClick(() => { void this.inspect(); }));
		void this.load();
		this.timer = window.setInterval(() => { void this.load(); }, 20_000);
	}

	onClose(): void {
		this.closed = true;
		this.request++;
		if (this.timer !== null) window.clearInterval(this.timer);
		this.contentEl.empty();
	}

	private reviewKey(current: VaultPageRead): string {
		return `${current.vaultId}:${current.pageId}`;
	}

	private async savedEditor(plan: VaultReviewPlan): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(this.page);
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!(file instanceof TFile) || !view || view.file?.path !== this.page) {
			throw new Error("open the selected page in a Markdown editor");
		}
		assertSavedEditor(view.editor.getValue(), await this.app.vault.read(file), plan);
	}

	private async load(): Promise<void> {
		const request = ++this.request;
		this.entriesEl.setText("Loading open entries…");
		try {
			const result = await readVaultPage(this.vaultRoot, this.page, this.binaryPath, true);
			if (this.closed || request !== this.request) return;
			this.entriesEl.empty();
			this.entriesEl.createEl("p", { text: `${result.count} open entr${result.count === 1 ? "y" : "ies"} · writer generation ${result.generation}` });
			for (const entry of result.entries ?? []) {
				new Setting(this.entriesEl).setName(`${entry.id} · ${entry.state}`)
					.setDesc(`Heading: ${entry.anchor || "page"} · revision ${entry.revision}`);
			}
			await this.poll(result);
		} catch (error: unknown) {
			if (!this.closed && request === this.request) {
				this.entriesEl.setText(`Open entries unavailable: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}

	private async inspect(): Promise<void> {
		try {
			const current = await readVaultPage(this.vaultRoot, this.page, this.binaryPath, true);
			if (current.count === 0) {
				this.reviewEl.setText("Current writer: 0 open entries. No review needed.");
				return;
			}
			const plan = await inspectVaultReview(this.vaultRoot, this.page, this.binaryPath, current);
			await this.savedEditor(plan);
			if (this.closed) return;
			this.reviewEl.empty();
			this.reviewEl.createEl("p", {
				text: `${plan.subjects.length} entries · saved SHA-256 ${plan.savedSha256} · at most ${plan.maximumRoleInvocations} model calls across recovery attempts`,
			});
			new Setting(this.reviewEl).setName("Independent saved-page review")
				.setDesc("Starts a detached verifier and challenger. Entries remain open until favorable review and exact saved-byte closure.")
				.addButton((button) => button.setButtonText("Start background review").setWarning().onClick(() => {
					void this.submit(plan);
				}));
		} catch (error: unknown) {
			if (!this.closed) this.reviewEl.setText(`Review unavailable: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async submit(plan: VaultReviewPlan): Promise<void> {
		try {
			await this.savedEditor(plan);
			const current = await readVaultPage(this.vaultRoot, this.page, this.binaryPath, true);
			const fresh = await inspectVaultReview(this.vaultRoot, this.page, this.binaryPath, current);
			if (fresh.id !== plan.id) throw new Error("saved page or entries changed; inspect again");
			await this.savedEditor(plan);
			const id = await submitVaultReview(this.vaultRoot, this.binaryPath, plan);
			await this.saveReview(this.reviewKey(current), plan);
			if (!this.closed) {
				this.reviewEl.setText(`Review ${id} queued in background; entries remain open.`);
				void this.load();
			}
		} catch (error: unknown) {
			if (!this.closed) this.reviewEl.setText(`Review submission refused: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async poll(current: VaultPageRead): Promise<void> {
		const saved = this.getReview(this.reviewKey(current));
		if (!saved || current.count === 0) {
			if (current.count === 0) this.reviewEl.setText("Current writer: 0 open entries.");
			return;
		}
		const plan = { ...saved, page: this.page };
		try {
			const status = await showVaultReview(this.vaultRoot, this.binaryPath, plan);
			if (this.closed) return;
			if (status.state !== "complete") {
				this.reviewEl.setText(`Review ${status.state}; ${current.count} entries remain open.`);
				return;
			}
			if (status.results.length !== plan.subjects.length
				|| status.results.some((result) => result.outcome !== "fresh" && result.outcome !== "obsolete")) {
				this.reviewEl.setText(`Independent review retained ${current.count} entries; edit and save before requesting a new review.`);
				return;
			}
			await this.savedEditor(plan);
			const closure = await closeVaultReview(this.vaultRoot, this.binaryPath, plan);
			if (this.closed) return;
			if (closure.state === "complete") {
				this.reviewEl.setText(`Current writer: 0 open entries at generation ${closure.generation}.`);
				this.refreshCount();
				void this.load();
			} else {
				this.reviewEl.setText(`Closure pending: ${closure.reason ?? "current saved page needs review"}`);
			}
		} catch (error: unknown) {
			if (!this.closed) this.reviewEl.setText(`Closure pending: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}
