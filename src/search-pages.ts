import { App, MarkdownView, Modal, Notice, Setting, TFile } from "obsidian";
import { isAbsolute, relative } from "path";
import { loadWikis, wikiForAbsPath } from "./new-page";
import {
	PanioloNotFoundError,
	PanioloTimeoutError,
	runPaniolo,
} from "./paniolo";

type SearchPagesRequest = {
	app: App;
	configRoot: string;
	vaultRoot: string;
	binary: string;
	sourceView: MarkdownView | null;
};

type QmdHit = {
	file: string;
	title: string;
	snippet: string;
};

type PageHit = {
	file: TFile;
	title: string;
	snippet: string;
	wikiName: string;
};

/** Read only the fields used by the picker from qmd's JSON result. */
function parseHits(stdout: string): QmdHit[] {
	const value: unknown = JSON.parse(stdout);
	if (typeof value !== "object" || value === null || !("results" in value)) {
		throw new Error("qmd returned an invalid result");
	}
	if (!Array.isArray(value.results)) {
		throw new Error("qmd returned an invalid result list");
	}
	const hits: QmdHit[] = [];
	for (const item of value.results as unknown[]) {
		if (typeof item !== "object" || item === null) continue;
		if (!("file" in item) || typeof item.file !== "string") continue;
		if (!("title" in item) || typeof item.title !== "string") continue;
		hits.push({
			file: item.file,
			title: item.title,
			snippet: "snippet" in item && typeof item.snippet === "string"
				? item.snippet
				: "",
		});
	}
	return hits;
}

/** Search the configured wiki corpus and act on results inside this vault. */
export class SearchPagesModal extends Modal {
	private mode: "search" | "query" = "search";
	private queryInput!: HTMLInputElement;
	private resultsEl!: HTMLElement;
	private requestId = 0;
	private closed = false;
	private sourceFile: TFile | null;

	constructor(private request: SearchPagesRequest) {
		super(request.app);
		this.sourceFile = request.sourceView?.file ?? null;
	}

	onOpen(): void {
		this.closed = false;
		this.contentEl.createEl("h3", { text: "search pages" });
		new Setting(this.contentEl)
			.setName("Search")
			.addText((text) => {
				text.setPlaceholder("Page title, phrase, or question");
				this.queryInput = text.inputEl;
				this.queryInput.addEventListener("keydown", (event) => {
					if (event.key === "Enter") {
						event.preventDefault();
						void this.search();
					}
				});
			})
			.addDropdown((dropdown) => {
				dropdown.addOption("search", "Keyword");
				dropdown.addOption("query", "Hybrid");
				dropdown.onChange((value) => {
					this.mode = value === "query" ? "query" : "search";
				});
			})
			.addButton((button) =>
				button.setButtonText("search").setCta().onClick(() => void this.search()),
			);
		this.resultsEl = this.contentEl.createDiv({ cls: "paniolo-search-results" });
		this.queryInput.focus();
	}

	/** Ignore an older CLI response if another search or modal close superseded it. */
	private async search(): Promise<void> {
		const query = this.queryInput.value.trim();
		if (!query) {
			this.resultsEl.setText("Enter a search term.");
			return;
		}
		const requestId = ++this.requestId;
		this.resultsEl.setText("Searching…");
		try {
			const result = await runPaniolo(
				this.request.binary,
				["qmd", this.mode, "--format", "json", "--full", "--full-path", "-n", "40", query],
				this.request.configRoot,
			);
			if (this.closed || requestId !== this.requestId) return;
			if (result.code !== 0) {
				throw new Error(result.stderr.trim() || "qmd search failed");
			}
			this.renderResults(parseHits(result.stdout));
		} catch (error: unknown) {
			if (this.closed || requestId !== this.requestId) return;
			const detail = error instanceof PanioloNotFoundError
				? "binary not found — set it in plugin settings"
				: error instanceof PanioloTimeoutError
					? "search timed out"
					: error instanceof Error
						? error.message
						: "search failed";
			this.resultsEl.setText(`paniolo: ${detail}`);
		}
	}

	/** Discard out-of-vault and non-wiki hits before offering navigation or edits. */
	private renderResults(hits: QmdHit[]): void {
		this.resultsEl.empty();
		const wikis = loadWikis(this.request.configRoot);
		const pages: PageHit[] = [];
		const seen = new Set<string>();
		for (const hit of hits) {
			if (!isAbsolute(hit.file)) continue;
			const vaultPath = relative(this.request.vaultRoot, hit.file).replace(/\\/g, "/");
			if (!vaultPath || vaultPath === ".." || vaultPath.startsWith("../") || isAbsolute(vaultPath)) continue;
			if (seen.has(vaultPath)) continue;
			const file = this.app.vault.getAbstractFileByPath(vaultPath);
			if (!(file instanceof TFile) || file.extension !== "md") continue;
			const wiki = wikiForAbsPath(this.request.configRoot, hit.file, wikis);
			if (!wiki || file.basename.toLowerCase() === "log") continue;
			seen.add(vaultPath);
			pages.push({ file, title: hit.title || file.basename, snippet: hit.snippet, wikiName: wiki.name });
			if (pages.length === 10) break;
		}
		if (!pages.length) {
			this.resultsEl.setText("No matching wiki pages in this vault.");
			return;
		}
		for (const page of pages) {
			const excerpt = page.snippet.replace(/\s+/g, " ").trim().slice(0, 220);
			new Setting(this.resultsEl)
				.setName(`${page.title} · ${page.wikiName}`)
				.setDesc(excerpt || page.file.path)
				.addButton((button) => button.setButtonText("open").onClick(() => {
					this.close();
					void this.app.workspace.getLeaf(false).openFile(page.file);
				}))
				.addButton((button) => button
					.setButtonText("insert link")
					.setDisabled(!this.sourceFile)
					.onClick(() => this.insertLink(page.file)));
		}
	}

	/** Insert through Obsidian so links follow the vault's configured format. */
	private insertLink(target: TFile): void {
		const view = this.request.sourceView;
		const source = this.sourceFile;
		if (!view || !source || view.file?.path !== source.path) {
			new Notice("paniolo: source page is no longer open");
			return;
		}
		const link = this.app.fileManager.generateMarkdownLink(target, source.path);
		view.editor.replaceSelection(link);
		this.close();
	}

	onClose(): void {
		this.closed = true;
		this.requestId++;
		this.contentEl.empty();
	}
}
