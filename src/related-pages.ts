import { App, MarkdownView, Menu, Notice, TFile } from "obsidian";
import { isAbsolute, relative } from "path";
import {
	PanioloNotFoundError,
	PanioloTimeoutError,
	runPaniolo,
} from "./paniolo";
import { loadWikis, wikiForAbsPath } from "./new-page";

type RelatedPagesRequest = {
	app: App;
	file: TFile;
	configRoot: string;
	vaultRoot: string;
	binary: string;
	selectedText?: string;
};

type QmdHit = {
	file: string;
	title: string;
};

/** Use the opening prose as context without sending an entire long note to qmd. */
function openingParagraph(markdown: string): string {
	const body = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
	const lines: string[] = [];
	for (const line of body.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) {
			if (lines.length) break;
			continue;
		}
		if (/^(#|>|-|\d+\.|\||```)/.test(trimmed)) continue;
		lines.push(trimmed);
	}
	return lines.join(" ").slice(0, 500);
}

/** Accept only the path and title fields needed from qmd's JSON output. */
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
		hits.push({ file: item.file, title: item.title });
	}
	return hits;
}

/** Position a delayed results menu beside the active page's Paniolo button. */
function menuPosition(app: App): { x: number; y: number } {
	const view = app.workspace.getActiveViewOfType(MarkdownView);
	const button = view?.containerEl.querySelector<HTMLElement>(
		".paniolo-action-button",
	);
	const rect = button?.getBoundingClientRect();
	return rect
		? { x: rect.left, y: rect.bottom }
		: { x: window.innerWidth / 2, y: window.innerHeight / 2 };
}

/** Query qmd and show the top related wiki pages that Obsidian can open. */
export async function searchRelatedPages({
	app,
	file,
	configRoot,
	vaultRoot,
	binary,
	selectedText,
}: RelatedPagesRequest): Promise<void> {
	const wikis = loadWikis(configRoot);
	if (!wikis.length) {
		new Notice("paniolo: no wikis declared in paniolo.config.json");
		return;
	}
	const position = menuPosition(app);
	const notice = new Notice("paniolo: searching related pages…", 0);
	try {
		let query: string;
		if (selectedText) {
			query = `vec: ${selectedText}`;
		} else {
			const markdown = await app.vault.cachedRead(file);
			const title = app.metadataCache.getFileCache(file)?.frontmatter?.title;
			const pageTitle = typeof title === "string" ? title : file.basename.replace(/[-_]/g, " ");
			query = `vec: ${pageTitle}. ${openingParagraph(markdown)}`;
		}
		const result = await runPaniolo(
			binary,
			[
				"qmd",
				"query",
				"--intent",
				selectedText
					? "Find wiki pages related to the selected text"
					: "Find other wiki pages about the same subject as the open page",
				"--format",
				"json",
				"--full-path",
				"-n",
				"25",
				query,
			],
			configRoot,
		);
		if (result.code !== 0) {
			throw new Error(result.stderr.trim() || "qmd query failed");
		}
		const menu = new Menu();
		let count = 0;
		const seen = new Set<string>();
		for (const hit of parseHits(result.stdout)) {
			if (!isAbsolute(hit.file)) continue;
			const vaultPath = relative(vaultRoot, hit.file).replace(/\\/g, "/");
			if (
				!vaultPath ||
				vaultPath === ".." ||
				vaultPath.startsWith("../") ||
				isAbsolute(vaultPath)
			) continue;
			if (seen.has(vaultPath) || vaultPath === file.path) continue;
			const target = app.vault.getAbstractFileByPath(vaultPath);
			if (!(target instanceof TFile) || target.extension !== "md") continue;
			if (target.basename.toLowerCase() === "log") continue;
			const wiki = wikiForAbsPath(configRoot, hit.file, wikis);
			if (!wiki) continue;
			seen.add(vaultPath);
			menu.addItem((item) =>
				item.setTitle(`${hit.title || target.basename} · ${wiki.name}`).onClick(() => {
					void app.workspace.getLeaf(false).openFile(target);
				}),
			);
			count++;
			if (count === 5) break;
		}
		if (count === 0) {
			new Notice("paniolo: no related wiki pages found in this vault");
			return;
		}
		menu.showAtPosition(position);
	} catch (error: unknown) {
		const detail =
			error instanceof PanioloNotFoundError
				? "binary not found — set it in plugin settings"
				: error instanceof PanioloTimeoutError
					? "related-page search timed out"
					: error instanceof Error
						? error.message
						: "related-page search failed";
		new Notice(`paniolo: ${detail}`, 8000);
	} finally {
		notice.hide();
	}
}
