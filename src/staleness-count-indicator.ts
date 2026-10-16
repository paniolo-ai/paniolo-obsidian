import { FileSystemAdapter, Plugin, TFile } from "obsidian";
import { dirname, join } from "path";
import { existsSync } from "fs";
import { findConfigRoot, resolveBinary, runPaniolo } from "./paniolo";
import { loadWikis } from "./new-page";
import { pageKeyForPath } from "./page-staleness-key";
import { countFromCli, countLabel } from "./staleness-count";
import { readVaultPage } from "./non-git-staleness";

export type CountDisplay = { text: string; source: "active-writer" | "snapshot" | "unavailable" | "checking" };

const SAVE_DELAY_MS = 500;
const LEDGER_POLL_MS = 20_000;
const COUNT_TIMEOUT_MS = 5_000;

/** Keep the active page's ledger count independent of mtime-based signal caching. */
export class StalenessCountIndicator {
	private statusItem: HTMLElement | null = null;
	private active: { path: string; display: CountDisplay } | null = null;
	private revision = 0;
	private saveTimer: ReturnType<typeof setTimeout> | null = null;
	private pollTimer: number | null = null;

	constructor(
		private plugin: Plugin,
		private binaryPath: () => string,
		private onDisplayChange: () => void,
	) {}

	/** Refresh on navigation, saves, and periodic ledger changes without blocking the editor. */
	register(): void {
		this.statusItem = this.plugin.addStatusBarItem();
		this.plugin.registerEvent(this.plugin.app.workspace.on("file-open", () => { void this.refresh(); }));
		this.plugin.registerEvent(this.plugin.app.vault.on("modify", (file) => {
			if (!(file instanceof TFile) || file.path !== this.plugin.app.workspace.getActiveFile()?.path) return;
			if (this.saveTimer !== null) clearTimeout(this.saveTimer);
			this.saveTimer = setTimeout(() => { this.saveTimer = null; void this.refresh(); }, SAVE_DELAY_MS);
		}));
		this.pollTimer = window.setInterval(() => { void this.refresh(); }, LEDGER_POLL_MS);
		this.plugin.registerInterval(this.pollTimer);
		this.plugin.app.workspace.onLayoutReady(() => { void this.refresh(); });
	}

	/** Stop pending responses and timers when the plugin unloads. */
	dispose(): void {
		this.revision++;
		if (this.saveTimer !== null) clearTimeout(this.saveTimer);
		if (this.pollTimer !== null) window.clearInterval(this.pollTimer);
		this.active = null;
	}

	/** Only the active file gets a live badge; other open leaves remain neutral. */
	displayForPath(path: string): CountDisplay | null {
		return this.active?.path === path ? this.active.display : null;
	}

	private show(path: string, display: CountDisplay): void {
		this.active = { path, display };
		this.statusItem?.setText(`paniolo open entries: ${display.text}`);
		this.onDisplayChange();
	}

	/** One targeted read per refresh; a prior page's result cannot overwrite this page. */
	async refresh(): Promise<void> {
		const file = this.plugin.app.workspace.getActiveFile();
		const request = ++this.revision;
		if (!(file instanceof TFile) || file.extension !== "md") {
			this.active = null;
			this.statusItem?.setText("paniolo open entries: no Markdown page");
			this.onDisplayChange();
			return;
		}
		this.show(file.path, { text: "Checking…", source: "checking" });
		try {
			const adapter = this.plugin.app.vault.adapter;
			if (!(adapter instanceof FileSystemAdapter)) throw new Error("unsupported vault adapter");
			const absPath = join(adapter.getBasePath(), file.path);
			const vaultRoot = adapter.getBasePath();
			const configRoot = findConfigRoot(dirname(absPath));
			const key = configRoot ? pageKeyForPath(configRoot, absPath, loadWikis(configRoot)) : null;
			let count;
			if (configRoot && key && "target" in key) {
				const result = await runPaniolo(
					resolveBinary(this.binaryPath()),
					["stale", "--root", configRoot, "counts", "--only", key.target, "--json"],
					configRoot,
					COUNT_TIMEOUT_MS,
				);
				if (result.code !== 0) throw new Error(result.stderr.trim() || "count read failed");
				count = countFromCli(result.stdout, key.target);
			} else if (existsSync(join(vaultRoot, ".paniolo", "stale-vault.json"))) {
				const vault = await readVaultPage(vaultRoot, file.path, this.binaryPath());
				count = { count: vault.count, generation: vault.generation, source: vault.source };
			} else {
				throw new Error("page is not configured for staleness");
			}
			if (this.revision === request && this.plugin.app.workspace.getActiveFile()?.path === file.path) {
				this.show(file.path, { text: countLabel(count), source: count.source });
			}
		} catch {
			if (this.revision === request && this.plugin.app.workspace.getActiveFile()?.path === file.path) {
				this.show(file.path, { text: "Open entries unavailable", source: "unavailable" });
			}
		}
	}
}
