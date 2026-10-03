import { MarkdownView, Menu, Plugin } from "obsidian";

const BAR_CLASS = "paniolo-action-bar";

interface ActionButton {
	label: string;
	commandId?: string;
	/** Only show when the open file lives under a `wiki/` directory. */
	wikiOnly?: boolean;
	/** When set, the button opens a dropdown Menu of command ids. */
	menu?: { label: string; commandId: string }[];
}

const BUTTONS: ActionButton[] = [
	{ label: "lint", commandId: "lint-this-page" },
	{ label: "new page", commandId: "new-wiki-page", wikiOnly: true },
	{
		label: "wiki ops ▸",
		wikiOnly: true,
		menu: [
			{ label: "rename…", commandId: "wiki-rename-page" },
			{ label: "move to other wiki…", commandId: "wiki-move-page" },
			{ label: "set status…", commandId: "wiki-set-status" },
			{ label: "references", commandId: "wiki-refs" },
			{ label: "apply autofixes", commandId: "wiki-fix" },
			{ label: "archive…", commandId: "wiki-archive-page" },
			{ label: "delete…", commandId: "wiki-delete-page" },
		],
	},
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
			btn.addEventListener("click", (ev) => {
				const commands = (
					this.plugin.app as unknown as { commands: CommandApi }
				).commands;
				if (spec.menu) {
					const menu = new Menu();
					for (const item of spec.menu) {
						menu.addItem((i) =>
							i.setTitle(`paniolo ${item.label}`).onClick(() =>
								commands.executeCommandById(
									`${this.plugin.manifest.id}:${item.commandId}`,
								),
							),
						);
					}
					menu.showAtMouseEvent(ev);
					return;
				}
				if (spec.commandId) {
					commands.executeCommandById(
						`${this.plugin.manifest.id}:${spec.commandId}`,
					);
				}
			});
		}
	}
}
