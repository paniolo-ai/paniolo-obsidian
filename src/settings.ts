import { App, FileSystemAdapter, PluginSettingTab, Setting } from "obsidian";
import type PanioloPlugin from "./main";
import type { PageReviewTracking } from "./page-staleness-completion";
import type { VaultReviewPlan } from "./non-git-review";
import { readVaultWriterState } from "./non-git-vault";

export interface PanioloSettings {
	/** Explicit path to the paniolo binary; empty resolves `paniolo` via PATH. */
	binaryPath: string;
	/** Exact report ID last submitted for each configured wiki page. */
	pageRuns: Record<string, string>;
	/** Review IDs for exact repository branch and PR head identities. */
	pageReviews: Record<string, string>;
	/** Last exact PR review attached to each edited page. */
	pageReviewTracking: Record<string, PageReviewTracking>;
	/** Last exact saved-byte review for each stable non-Git vault/page ID. */
	vaultReviews: Record<string, VaultReviewPlan>;
}

export const DEFAULT_SETTINGS: PanioloSettings = {
	binaryPath: "",
	pageRuns: {},
	pageReviews: {},
	pageReviewTracking: {},
	vaultReviews: {},
};

export class PanioloSettingTab extends PluginSettingTab {
	private plugin: PanioloPlugin;

	constructor(app: App, plugin: PanioloPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Paniolo binary")
			.setDesc(
				"Path to the paniolo executable. Leave empty to resolve `paniolo` from PATH.",
			)
			.addText((text) =>
				text
					.setPlaceholder("paniolo")
					.setValue(this.plugin.settings.binaryPath)
					.onChange(async (value) => {
						this.plugin.settings.binaryPath = value;
						await this.plugin.saveSettings();
					}),
			);

		const adapter = this.app.vault.adapter;
		const writer = new Setting(containerEl)
			.setName("Non-Git staleness writer")
			.setDesc("Checking this device's registered vault status…");
		if (!(adapter instanceof FileSystemAdapter)) {
			writer.setDesc("This vault adapter does not expose a local directory.");
			return;
		}
		const refresh = async (): Promise<void> => {
			try {
				const state = await readVaultWriterState(adapter.getBasePath(), this.plugin.settings.binaryPath);
				const descriptions = {
					unregistered: "Not registered. Use ‘Register current non-Git page’ on a selected page to opt in.",
					unclaimed: "Registered but no writer claimed. Registration can claim it explicitly.",
					owned: "This device owns the registered vault writer capability.",
					refused: "Read-only copy: this device does not own the writer capability.",
				};
				writer.setDesc(descriptions[state]);
			} catch (error: unknown) {
				writer.setDesc(`Writer status unavailable: ${String(error)}`);
			}
		};
		writer.addButton((button) => button.setButtonText("Refresh").onClick(() => { void refresh(); }));
		void refresh();
	}
}
