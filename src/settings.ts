import { App, PluginSettingTab, Setting } from "obsidian";
import type PanioloPlugin from "./main";

export interface PanioloSettings {
	/** Explicit path to the paniolo binary; empty resolves `paniolo` via PATH. */
	binaryPath: string;
}

export const DEFAULT_SETTINGS: PanioloSettings = {
	binaryPath: "",
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
