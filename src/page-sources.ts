import {
	App,
	getFrontMatterInfo,
	Modal,
	Notice,
	parseFrontMatterStringArray,
	parseYaml,
	Setting,
	TFile,
} from "obsidian";
import { existsSync, realpathSync, statSync } from "fs";
import { extname, isAbsolute, relative, resolve } from "path";

type SourcesRequest = {
	app: App;
	file: TFile;
	repoRoot: string;
	vaultRoot: string;
};

type SourceTarget =
	| { kind: "wiki-link"; linkText: string }
	| { kind: "note"; file: TFile }
	| { kind: "url"; url: string }
	| { kind: "file"; path: string }
	| { kind: "unavailable"; reason: string };

type DesktopShell = {
	openExternal(url: string): Promise<void>;
	openPath(path: string): Promise<string>;
};

// Raw documents may use the default desktop app; executable formats never do.
const VIEWABLE_EXTENSIONS = new Set([
	".csv", ".gif", ".htm", ".html", ".jpeg",
	".jpg", ".json", ".log", ".md", ".pdf", ".png",
	".svg", ".toml", ".tsv", ".txt",
	".webp", ".xml", ".yaml", ".yml",
]);

/** Resolve only citations Obsidian can navigate or the desktop can safely view. */
function sourceTarget(
	app: App,
	page: TFile,
	source: string,
	repoRoot: string,
	vaultRoot: string,
): SourceTarget {
	const wikiLink = /^\[\[([^\]]+)\]\]$/.exec(source);
	if (wikiLink) {
		const linkText = wikiLink[1].split("|", 1)[0];
		const linkPath = linkText.split("#", 1)[0];
		return app.metadataCache.getFirstLinkpathDest(linkPath, page.path)
			? { kind: "wiki-link", linkText }
			: { kind: "unavailable", reason: "wiki page not found" };
	}

	if (/^https?:\/\//i.test(source)) {
		try {
			const url = new URL(source);
			return url.protocol === "http:" || url.protocol === "https:"
				? { kind: "url", url: url.href }
				: { kind: "unavailable", reason: "unsupported URL" };
		} catch {
			return { kind: "unavailable", reason: "invalid URL" };
		}
	}

	if (isAbsolute(source) || /^[a-z][a-z\d+.-]*:/i.test(source)) {
		return { kind: "unavailable", reason: "source is not a vault-relative file" };
	}
	const absolutePath = resolve(repoRoot, source);
	const vaultPath = relative(vaultRoot, absolutePath).replace(/\\/g, "/");
	if (!vaultPath || vaultPath === ".." || vaultPath.startsWith("../") || isAbsolute(vaultPath)) {
		return { kind: "unavailable", reason: "source is outside this vault" };
	}
	if (!existsSync(absolutePath)) {
		return { kind: "unavailable", reason: "source file not found" };
	}
	let realVaultPath: string;
	try {
		if (!statSync(absolutePath).isFile()) {
			return { kind: "unavailable", reason: "source is not a file" };
		}
		realVaultPath = relative(realpathSync(vaultRoot), realpathSync(absolutePath))
			.replace(/\\/g, "/");
	} catch {
		return { kind: "unavailable", reason: "source file cannot be read" };
	}
	if (realVaultPath === ".." || realVaultPath.startsWith("../") || isAbsolute(realVaultPath)) {
		return { kind: "unavailable", reason: "source is outside this vault" };
	}
	if (!VIEWABLE_EXTENSIONS.has(extname(absolutePath).toLowerCase())) {
		return { kind: "unavailable", reason: "file type cannot be viewed safely" };
	}
	const file = app.vault.getAbstractFileByPath(vaultPath);
	return file instanceof TFile && file.extension === "md"
		? { kind: "note", file }
		: { kind: "file", path: absolutePath };
}

/** Present the page's declared provenance as navigable source rows. */
class PageSourcesModal extends Modal {
	constructor(
		app: App,
		private page: TFile,
		private sources: string[],
		private repoRoot: string,
		private vaultRoot: string,
	) {
		super(app);
	}

	onOpen(): void {
		this.contentEl.createEl("h3", { text: `sources for ${this.page.basename}` });
		if (!this.sources.length) {
			this.contentEl.createEl("p", { text: "No sources listed on this page." });
			return;
		}
		const list = this.contentEl.createDiv({ cls: "paniolo-source-list" });
		for (const source of this.sources) {
			const target = sourceTarget(
				this.app,
				this.page,
				source,
				this.repoRoot,
				this.vaultRoot,
			);
			const setting = new Setting(list).setName(source);
			if (target.kind === "unavailable") {
				setting.setDesc(target.reason);
				continue;
			}
			setting.setDesc(
				target.kind === "url"
					? "open in browser"
					: target.kind === "file"
						? "open in default app"
						: "open in Obsidian",
			);
			setting.nameEl.empty();
			const link = setting.nameEl.createEl("a", { text: source, href: "#" });
			link.addEventListener("click", (event) => {
				event.preventDefault();
				void this.openSource(target);
			});
		}
	}

	/** Open a selected source with the appropriate Obsidian or desktop viewer. */
	private async openSource(target: Exclude<SourceTarget, { kind: "unavailable" }>): Promise<void> {
		try {
			if (target.kind === "wiki-link") {
				await this.app.workspace.openLinkText(target.linkText, this.page.path);
			} else if (target.kind === "note") {
				await this.app.workspace.getLeaf(false).openFile(target.file);
			} else {
				// Electron is provided by Obsidian's desktop runtime, not bundled with the plugin.
				const desktop = require("electron") as { shell: DesktopShell };
				if (target.kind === "url") {
					await desktop.shell.openExternal(target.url);
				} else {
					const error = await desktop.shell.openPath(target.path);
					if (error) throw new Error(error);
				}
			}
			this.close();
		} catch (error: unknown) {
			new Notice(
				`paniolo: could not open source — ${error instanceof Error ? error.message : String(error)}`,
				8000,
			);
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Read the saved page's `sources:` frontmatter and open its source browser. */
export async function showPageSources({
	app,
	file,
	repoRoot,
	vaultRoot,
}: SourcesRequest): Promise<void> {
	const markdown = await app.vault.cachedRead(file);
	const info = getFrontMatterInfo(markdown);
	const frontmatter: unknown = info.exists ? parseYaml(info.frontmatter) : null;
	const sources = parseFrontMatterStringArray(frontmatter, "sources") ?? [];
	new PageSourcesModal(app, file, sources, repoRoot, vaultRoot).open();
}
