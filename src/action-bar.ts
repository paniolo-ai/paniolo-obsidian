import { MarkdownView, Menu, Plugin } from "obsidian";

const BAR_CLASS = "paniolo-action-bar";

interface MenuItem {
	label: string;
	commandId: string;
	/** Only show when the open file lives under a `wiki/` directory. */
	wikiOnly?: boolean;
}

/** Separator-separated groups inside the single Paniolo menu. */
const MENU_SECTIONS: MenuItem[][] = [
	[
		{ label: "lint this page", commandId: "lint-this-page" },
		{
			label: "apply autofixes to page",
			commandId: "wiki-fix",
			wikiOnly: true,
		},
	],
	[
		{ label: "search for related pages…", commandId: "search-related-pages" },
		{
			label: "search for pages related to selection…",
			commandId: "search-pages-related-to-selection",
		},
	],
	[
		{ label: "new page", commandId: "new-wiki-page", wikiOnly: true },
		{ label: "rename page…", commandId: "wiki-rename-page", wikiOnly: true },
		{
			label: "move page to another wiki…",
			commandId: "wiki-move-page",
			wikiOnly: true,
		},
		{
			label: "set page status…",
			commandId: "wiki-set-status",
			wikiOnly: true,
		},
		{ label: "search for page references…", commandId: "wiki-refs", wikiOnly: true },
		{ label: "view sources for page…", commandId: "wiki-sources", wikiOnly: true },
		{
			label: "archive page…",
			commandId: "wiki-archive-page",
			wikiOnly: true,
		},
		{
			label: "delete page…",
			commandId: "wiki-delete-page",
			wikiOnly: true,
		},
	],
];

interface CommandApi {
	executeCommandById(id: string): boolean;
}

/**
 * Per-note footer appended below the editor in each MarkdownView: a single
 * "Paniolo ▸" button whose dropdown Menu dispatches onto registered command
 * ids — the same commands the palette exposes — so this file carries no
 * feature logic. As cards land (related pages, suggest-links, staleness),
 * entries join MENU_SECTIONS.
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
		const btn = bar.createEl("button", {
			cls: "paniolo-action-button",
			text: "Paniolo ▸",
		});
		btn.addEventListener("click", (ev) => {
			const commands = (
				this.plugin.app as unknown as { commands: CommandApi }
			).commands;
			const menu = new Menu();
			let first = true;
			for (const section of MENU_SECTIONS) {
				const items = section.filter((i) => !i.wikiOnly || inWiki);
				if (!items.length) continue;
				if (!first) menu.addSeparator();
				first = false;
				for (const item of items) {
					menu.addItem((i) =>
						i.setTitle(item.label).onClick(() =>
							commands.executeCommandById(
								`${this.plugin.manifest.id}:${item.commandId}`,
							),
						),
					);
				}
			}
			menu.showAtMouseEvent(ev);
		});
	}
}
