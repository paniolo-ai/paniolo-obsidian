import { App, PluginSettingTab, Setting } from "obsidian";
import type PanioloPlugin from "./main";
import type { PageReviewTracking } from "./page-staleness-completion";

export interface PanioloSettings {
	/** Explicit path to the paniolo binary; empty resolves `paniolo` via PATH. */
	binaryPath: string;
	/** Exact report ID last submitted for each configured wiki page. */
	pageRuns: Record<string, string>;
	/** Review IDs for exact repository branch and PR head identities. */
	pageReviews: Record<string, string>;
	/** Last exact PR review attached to each edited page. */
	pageReviewTracking: Record<string, PageReviewTracking>;
}

export const DEFAULT_SETTINGS: PanioloSettings = {
	binaryPath: "",
	pageRuns: {},
	pageReviews: {},
	pageReviewTracking: {},
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
	}
}
