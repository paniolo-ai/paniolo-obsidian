import { MarkdownView, Plugin } from "obsidian";

const BAR_CLASS = "paniolo-action-bar";

interface ActionButton {
	label: string;
	commandId: string;
	/** Only show when the open file lives under a `wiki/` directory. */
	wikiOnly?: boolean;
}

const BUTTONS: ActionButton[] = [
	{ label: "lint", commandId: "lint-this-page" },
];

interface CommandApi {
	executeCommandById(id: string): boolean;
}

/**
 * Per-note footer bar appended below the editor in each MarkdownView.
 * Buttons are pure dispatchers onto registered command ids — the same
 * commands the palette exposes — so this file carries no feature logic.
 * As cards land (related pages, suggest-links, wiki ops, staleness),
 * entries join BUTTONS.
 */
export class ActionBar {
	constructor(private plugin: Plugin) {}

	register(): void {
		const refresh = () => this.refreshAll();
		this.plugin.registerEvent(
			this.plugin.app.workspace.on("file-open", refresh),
		);
		this.plugin.registerEvent(
			this.plugin.app.workspace.on("active-leaf-change", refresh),
		);
		this.plugin.registerEvent(
			this.plugin.app.workspace.on("layout-change", refresh),
		);
		this.plugin.app.workspace.onLayoutReady(refresh);
	}

	removeAll(): void {
		for (const leaf of this.plugin.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (!(view instanceof MarkdownView)) continue;
			view.containerEl
				.querySelectorAll(`.${BAR_CLASS}`)
				.forEach((el: Element) => el.remove());
		}
	}

	private refreshAll(): void {
		for (const leaf of this.plugin.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (view instanceof MarkdownView) this.render(view);
		}
	}

	private render(view: MarkdownView): void {
		let bar = view.containerEl.querySelector<HTMLElement>(
			`:scope > .${BAR_CLASS}`,
		);
		if (!bar) bar = view.containerEl.createDiv({ cls: BAR_CLASS });
		bar.empty();

		const file = view.file;
		if (!file || file.extension !== "md") {
			bar.hide();
			return;
		}
		bar.show();

		const inWiki = file.path.split("/").includes("wiki");
		for (const spec of BUTTONS) {
			if (spec.wikiOnly && !inWiki) continue;
			const btn = bar.createEl("button", {
				cls: "paniolo-action-button",
				text: spec.label,
			});
			btn.addEventListener("click", () => {
				const commands = (
					this.plugin.app as unknown as { commands: CommandApi }
				).commands;
				commands.executeCommandById(
					`${this.plugin.manifest.id}:${spec.commandId}`,
				);
			});
		}
	}
}
