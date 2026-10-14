import { FileSystemAdapter, Notice, Plugin, TFile } from "obsidian";
import { readFileSync } from "fs";
import { dirname, isAbsolute, join, relative, sep } from "path";
import { Diagnostic } from "@codemirror/lint";
import { Text } from "@codemirror/state";
import { findConfigRoot, resolveBinary, runPaniolo } from "./paniolo";

export type IndicatorState = "signals" | "clean" | "unwatched" | "neutral" | "checking";

export type IndicatorDisplay = {
	state: IndicatorState;
	text: string;
};

type CachedDisplay = {
	mtime: number;
	display: IndicatorDisplay;
	signals: StalenessSignal[];
};

type StalenessSignal = { anchor: string; entity: string; commit: string };

type SignalResult = { display: IndicatorDisplay; signals: StalenessSignal[] };

const STATE_CLASSES: IndicatorState[] = ["signals", "clean", "unwatched", "neutral", "checking"];
const SAVE_DELAY_MS = 500;
const EXPLORER_DELAY_MS = 1000;
const EXPLORER_CLASSES = ["signals", "clean", "unwatched"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Select the deepest configured repository containing this absolute page. */
function targetForPage(configRoot: string, absPath: string): string | null {
	const config: unknown = JSON.parse(readFileSync(join(configRoot, "paniolo.config.json"), "utf-8"));
	if (!isRecord(config) || !isRecord(config.repos)) {
		throw new Error("configured repositories are unavailable");
	}
	let selected: { key: string; path: string; depth: number } | null = null;
	for (const [key, node] of Object.entries(config.repos)) {
		if (!isRecord(node) || typeof node.path !== "string") continue;
		const repoRoot = isAbsolute(node.path) ? node.path : join(configRoot, node.path);
		const path = relative(repoRoot, absPath);
		if (!path || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) continue;
		if (selected === null || repoRoot.length > selected.depth) {
			selected = { key, path, depth: repoRoot.length };
		}
	}
	return selected === null ? null : `${selected.key}:${selected.path.replace(/\\/g, "/")}`;
}

/** Reject malformed CLI output instead of displaying a false clean state. */
function parseDisplay(stdout: string): SignalResult {
	const value: unknown = JSON.parse(stdout);
	if (!isRecord(value) || typeof value.count !== "number" || !Number.isInteger(value.count) || !Array.isArray(value.signals)) {
		throw new Error("invalid signals response");
	}
	if (value.state === "signals" && value.count > 0 && value.signals.length === value.count) {
		if (!value.signals.every((signal: unknown) => isRecord(signal) && typeof signal.anchor === "string" && typeof signal.entity === "string" && typeof signal.commit === "string")) {
			throw new Error("invalid staleness signal");
		}
		return {
			display: { state: "signals", text: `${value.count} staleness signal${value.count === 1 ? "" : "s"}` },
			signals: value.signals as StalenessSignal[],
		};
	}
	if (value.state === "clean" && value.count === 0 && value.signals.length === 0) {
		return { display: { state: "clean", text: "No watched changes" }, signals: [] };
	}
	if (value.state === "unwatched" && value.count === 0 && value.signals.length === 0) {
		return { display: { state: "unwatched", text: "Not watched" }, signals: [] };
	}
	throw new Error("inconsistent signals response");
}

/** Resolve a batch row into the vault without trusting a row path as a DOM selector. */
function vaultPathForRow(configRoot: string, vaultRoot: string, repos: Record<string, unknown>, repo: string, path: string): string | null {
	const node = repos[repo];
	if (!isRecord(node) || typeof node.path !== "string") throw new Error(`unknown repository ${repo}`);
	const repoRoot = isAbsolute(node.path) ? node.path : join(configRoot, node.path);
	const absPath = join(repoRoot, path);
	const withinRepo = relative(repoRoot, absPath);
	if (!withinRepo || withinRepo === ".." || withinRepo.startsWith(`..${sep}`) || isAbsolute(withinRepo)) return null;
	const withinVault = relative(vaultRoot, absPath);
	if (!withinVault || withinVault === ".." || withinVault.startsWith(`..${sep}`) || isAbsolute(withinVault)) return null;
	return withinVault.replace(/\\/g, "/");
}

/** Reject partial corpus responses rather than colouring missing pages clean. */
export function parseExplorerStates(stdout: string, configRoot: string, vaultRoot: string): Map<string, IndicatorState> {
	const value: unknown = JSON.parse(stdout);
	if (!isRecord(value) || !Array.isArray(value.documents)) throw new Error("invalid corpus signals response");
	const config: unknown = JSON.parse(readFileSync(join(configRoot, "paniolo.config.json"), "utf-8"));
	if (!isRecord(config) || !isRecord(config.repos)) throw new Error("configured repositories are unavailable");
	const states = new Map<string, IndicatorState>();
	for (const row of value.documents) {
		if (!isRecord(row) || typeof row.repo !== "string" || typeof row.path !== "string"
			|| !EXPLORER_CLASSES.some((state) => state === row.state)) {
			throw new Error("invalid corpus signal row");
		}
		const path = vaultPathForRow(configRoot, vaultRoot, config.repos, row.repo, row.path);
		if (path !== null) states.set(path, row.state as IndicatorState);
	}
	return states;
}

function configRootForVault(plugin: Plugin, vaultRoot: string): string | null {
	const vaultConfig = findConfigRoot(vaultRoot);
	if (vaultConfig) return vaultConfig;
	for (const file of plugin.app.vault.getMarkdownFiles()) {
		if (!file.path.split("/").includes("wiki")) continue;
		const root = findConfigRoot(dirname(join(vaultRoot, file.path)));
		if (root) return root;
	}
	return null;
}

function headingSlug(title: string): string {
	return title.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/[\s_-]+/gu, "-").replace(/^-|-$/g, "");
}

/** Match the CLI's heading ancestry and duplicate suffixes; ignore fenced examples. */
function headingPositions(doc: Text): Map<string, { from: number; to: number }> {
	const positions = new Map<string, { from: number; to: number }>();
	const ancestry: string[] = [];
	const seen = new Map<string, number>();
	let fence: string | null = null;
	for (let number = 1; number <= doc.lines; number++) {
		const line = doc.line(number);
		const trimmed = line.text.trimStart();
		const marker = /^(`{3,}|~{3,})/.exec(trimmed)?.[0][0];
		if (marker) {
			if (fence === null) fence = marker;
			else if (fence === marker) fence = null;
			continue;
		}
		if (fence !== null) continue;
		const heading = /^(#{1,6}) (.*)$/.exec(trimmed);
		if (!heading) continue;
		const slug = headingSlug(heading[2].trim().replace(/#+$/, "").trim());
		if (!slug) continue;
		const level = heading[1].length;
		ancestry.length = Math.min(ancestry.length, level - 1);
		while (ancestry.length < level - 1) ancestry.push("section");
		ancestry.push(slug);
		const base = ancestry.join("/");
		const count = seen.get(base) ?? 0;
		seen.set(base, count + 1);
		const anchor = count === 0 ? base : `${base}-${count}`;
		positions.set(anchor, { from: line.from, to: line.to });
	}
	return positions;
}

/** Resolve the ledger's heading ancestry to a current editor line, if present. */
export function headingLineForAnchor(doc: Text, anchor: string): number | null {
	if (!anchor || anchor === "page") return doc.line(1).number;
	const positions = headingPositions(doc);
	const position = positions.get(anchor);
	return position ? doc.lineAt(position.from).number : null;
}

/** Only nominate a saved signal when its exact anchor exists in the editor. */
export function signalsToDiagnostics(doc: Text, signals: StalenessSignal[]): Diagnostic[] {
	const positions = headingPositions(doc);
	return signals.flatMap((signal) => {
		const position = signal.anchor === "page"
			? positions.values().next().value ?? doc.line(1)
			: positions.get(signal.anchor);
		if (!position) return [];
		return [{
			from: position.from,
			to: position.to,
			severity: "info" as const,
			source: "paniolo staleness",
			message: signal.anchor === "page"
				? `Code watched by this page changed: ${signal.entity} at ${signal.commit}. Review whether this page needs an update.`
				: `Code under this heading's watch changed: ${signal.entity} at ${signal.commit}. Review whether this page needs an update.`,
		}];
	});
}

/** Read-only staleness nominations for the active Markdown page. */
export class StalenessIndicator {
	private statusItem: HTMLElement | null = null;
	private cache = new Map<string, CachedDisplay>();
	private displays = new Map<string, IndicatorDisplay>();
	private signals = new Map<string, StalenessSignal[]>();
	private timer: ReturnType<typeof setTimeout> | null = null;
	private explorerTimer: ReturnType<typeof setTimeout> | null = null;
	private explorerStates = new Map<string, IndicatorState>();
	private explorerObservers = new Map<HTMLElement, MutationObserver>();
	private explorerRevision = 0;
	private revision = 0;

	constructor(
		private plugin: Plugin,
		private binaryPath: () => string,
		private onDisplayChange: () => void,
	) {}

	/** Register open/save events and a status item separate from lint status. */
	register(): void {
		this.statusItem = this.plugin.addStatusBarItem();
		this.plugin.registerEvent(this.plugin.app.workspace.on("file-open", () => {
			void this.refreshActiveFile();
		}));
		this.plugin.registerEvent(this.plugin.app.vault.on("modify", (file) => {
			if (!(file instanceof TFile) || file.extension !== "md") return;
			if (this.plugin.app.workspace.getActiveFile()?.path !== file.path) return;
			this.revision++;
			if (this.timer !== null) clearTimeout(this.timer);
			this.timer = setTimeout(() => {
				this.timer = null;
				void this.refreshActiveFile();
			}, SAVE_DELAY_MS);
		}));
		this.plugin.app.workspace.onLayoutReady(() => {
			void this.refreshActiveFile();
			this.watchExplorers();
			void this.refreshExplorer();
		});
		this.plugin.registerEvent(this.plugin.app.workspace.on("layout-change", () => this.watchExplorers()));
		this.plugin.registerEvent(this.plugin.app.vault.on("create", () => this.scheduleExplorer()));
		this.plugin.registerEvent(this.plugin.app.vault.on("delete", () => this.scheduleExplorer()));
		this.plugin.registerEvent(this.plugin.app.vault.on("rename", () => this.scheduleExplorer()));
		this.plugin.registerEvent(this.plugin.app.vault.on("modify", () => this.scheduleExplorer()));
	}

	/** Clear pending work and cached views on plugin unload. */
	dispose(): void {
		if (this.timer !== null) clearTimeout(this.timer);
		if (this.explorerTimer !== null) clearTimeout(this.explorerTimer);
		this.revision++;
		this.explorerRevision++;
		for (const observer of this.explorerObservers.values()) observer.disconnect();
		this.clearExplorerClasses();
		this.explorerObservers.clear();
		this.explorerStates.clear();
		this.cache.clear();
		this.displays.clear();
		this.signals.clear();
	}

	/** Label shown beside the Paniolo action menu for a note. */
	displayForPath(path: string): IndicatorDisplay | null {
		return this.displays.get(path) ?? null;
	}

	diagnosticsFor(path: string, doc: Text): Diagnostic[] {
		return signalsToDiagnostics(doc, this.signals.get(path) ?? []);
	}

	private show(path: string, display: IndicatorDisplay, signals: StalenessSignal[] = []): void {
		this.displays.set(path, display);
		this.signals.set(path, signals);
		if (this.plugin.app.workspace.getActiveFile()?.path === path) {
			this.renderStatus(display);
		}
		this.onDisplayChange();
	}

	private renderStatus(display: IndicatorDisplay): void {
		const item = this.statusItem;
		if (!item) return;
		for (const state of STATE_CLASSES) item.classList.remove(`paniolo-staleness-${state}`);
		item.classList.add(`paniolo-staleness-${display.state}`);
		item.setText(`paniolo staleness: ${display.text}`);
	}

	private scheduleExplorer(): void {
		if (this.explorerTimer !== null) clearTimeout(this.explorerTimer);
		this.explorerTimer = setTimeout(() => {
			this.explorerTimer = null;
			void this.refreshExplorer();
		}, EXPLORER_DELAY_MS);
	}

	/** One CLI process computes the whole corpus; tree rerenders reuse this map. */
	private async refreshExplorer(): Promise<void> {
		const request = ++this.explorerRevision;
		try {
			const adapter = this.plugin.app.vault.adapter;
			if (!(adapter instanceof FileSystemAdapter)) throw new Error("unsupported vault adapter");
			const vaultRoot = adapter.getBasePath();
			const configRoot = configRootForVault(this.plugin, vaultRoot);
			if (!configRoot) throw new Error("no paniolo.config.json above this vault");
			const result = await runPaniolo(
				resolveBinary(this.binaryPath()),
				["stale", "--root", configRoot, "signals", "--all", "--json"],
				configRoot,
			);
			if (result.code !== 0) throw new Error(result.stderr.trim() || `signals exited ${result.code}`);
			const states = parseExplorerStates(result.stdout, configRoot, vaultRoot);
			if (this.explorerRevision !== request) return;
			this.explorerStates = states;
			this.renderExplorer();
		} catch {
			if (this.explorerRevision !== request) return;
			this.explorerStates.clear();
			this.renderExplorer();
		}
	}

	private watchExplorers(): void {
		const containers = new Set<HTMLElement>();
		for (const leaf of this.plugin.app.workspace.getLeavesOfType("file-explorer")) {
			const container = leaf.view.containerEl;
			containers.add(container);
			if (this.explorerObservers.has(container)) continue;
			const observer = new MutationObserver(() => this.renderExplorer());
			observer.observe(container, { childList: true, subtree: true });
			this.explorerObservers.set(container, observer);
		}
		for (const [container, observer] of this.explorerObservers) {
			if (containers.has(container)) continue;
			observer.disconnect();
			this.explorerObservers.delete(container);
		}
		this.renderExplorer();
	}

	private clearExplorerClasses(): void {
		for (const container of this.explorerObservers.keys()) {
			container.querySelectorAll<HTMLElement>(".nav-file-title[data-path]").forEach((row) => {
				for (const state of EXPLORER_CLASSES) row.classList.remove(`paniolo-staleness-${state}`);
			});
		}
	}

	private renderExplorer(): void {
		for (const container of this.explorerObservers.keys()) {
			container.querySelectorAll<HTMLElement>(".nav-file-title[data-path]").forEach((row) => {
				for (const state of EXPLORER_CLASSES) row.classList.remove(`paniolo-staleness-${state}`);
				const path = row.getAttribute("data-path");
				const state = path === null ? null : this.explorerStates.get(path);
				if (state && EXPLORER_CLASSES.some((candidate) => candidate === state)) {
					row.classList.add(`paniolo-staleness-${state}`);
				}
			});
		}
	}

	/** Reuse a cached result when reopening a file with unchanged mtime. */
	private async refreshActiveFile(): Promise<void> {
		const file = this.plugin.app.workspace.getActiveFile();
		const request = ++this.revision;
		if (!(file instanceof TFile) || file.extension !== "md") {
			this.renderStatus({ state: "neutral", text: "No Markdown page" });
			return;
		}
		const cached = this.cache.get(file.path);
		const mtime = file.stat.mtime;
		if (cached?.mtime === mtime) {
			this.show(file.path, cached.display, cached.signals);
			return;
		}
		this.show(file.path, { state: "checking", text: "Checking…" });
		try {
			const adapter = this.plugin.app.vault.adapter;
			if (!(adapter instanceof FileSystemAdapter)) throw new Error("unsupported vault adapter");
			const absPath = join(adapter.getBasePath(), file.path);
			const configRoot = findConfigRoot(dirname(absPath));
			if (!configRoot) throw new Error("no paniolo.config.json above this page");
			const target = targetForPage(configRoot, absPath);
			if (!target) throw new Error("page is outside configured repositories");
			const result = await runPaniolo(
				resolveBinary(this.binaryPath()),
				["stale", "--root", configRoot, "signals", target, "--json"],
				configRoot,
			);
			if (result.code !== 0) throw new Error(result.stderr.trim() || `signals exited ${result.code}`);
			const parsed = parseDisplay(result.stdout);
			if (file.stat.mtime !== mtime) return;
			this.cache.set(file.path, { mtime, ...parsed });
			if (this.revision === request) this.show(file.path, parsed.display, parsed.signals);
		} catch (error: unknown) {
			const display: IndicatorDisplay = { state: "neutral", text: "Unavailable" };
			if (file.stat.mtime !== mtime) return;
			this.cache.set(file.path, { mtime, display, signals: [] });
			if (this.revision !== request) return;
			this.show(file.path, display);
			new Notice(`paniolo: staleness signals unavailable — ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}
