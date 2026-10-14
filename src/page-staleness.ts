import { FileSystemAdapter, MarkdownView, Modal, Notice, Plugin, Setting, TFile } from "obsidian";
import { Text } from "@codemirror/state";
import { dirname, join } from "path";
import { findConfigRoot, resolveBinary, runPaniolo } from "./paniolo";
import { loadWikis } from "./new-page";
import { pageKeyForPath } from "./page-staleness-key";
import { headingLineForAnchor } from "./staleness-indicator";

type PageContext = { file: TFile; configRoot: string; target: string };
type OpenEntry = { id: string; state: string; anchor: string; revision: number };
type OpenList = { source: "active-writer" | "snapshot"; generation: number | null; entries: OpenEntry[] };
type RunState = "queued" | "preparing" | "running" | "draining" | "paused-budget" | "succeeded" | "failed" | "cancelled";
type PageRun = { id: string; state: RunState; reason: string };

const RUN_POLL_MS = 5_000;
const READ_TIMEOUT_MS = 10_000;
const SUBMIT_TIMEOUT_MS = 20_000;
const RUN_STATES: RunState[] = ["queued", "preparing", "running", "draining", "paused-budget", "succeeded", "failed", "cancelled"];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveActivePage(plugin: Plugin): PageContext {
	const file = plugin.app.workspace.getActiveFile();
	if (!(file instanceof TFile) || file.extension !== "md") throw new Error("open a configured Markdown wiki page");
	const adapter = plugin.app.vault.adapter;
	if (!(adapter instanceof FileSystemAdapter)) throw new Error("unsupported vault adapter");
	const absPath = join(adapter.getBasePath(), file.path);
	const configRoot = findConfigRoot(dirname(absPath));
	if (!configRoot) throw new Error("no paniolo.config.json above this page");
	const key = pageKeyForPath(configRoot, absPath, loadWikis(configRoot));
	if (!("target" in key)) throw new Error(key.reason);
	return { file, configRoot, target: key.target };
}

/** Refuse partial or cross-page list responses; every open ID must be visible. */
export function parseOpenEntries(stdout: string, target: string): OpenList {
	const value: unknown = JSON.parse(stdout);
	if (!isRecord(value) || value.target !== target) throw new Error("invalid page entry response");
	if (value.status === "unavailable") throw new Error(typeof value.reason === "string" ? value.reason : "ledger unavailable");
	if (value.status !== "available" || (value.source !== "active-writer" && value.source !== "snapshot")) {
		throw new Error("invalid page entry provenance");
	}
	if (!Array.isArray(value.entries) || !Number.isSafeInteger(value.count) || (value.count as number) < 0 || value.count !== value.entries.length) {
		throw new Error("incomplete page entry list");
	}
	const entries: OpenEntry[] = [];
	for (const item of value.entries as unknown[]) {
		if (!isRecord(item) || typeof item.id !== "string" || typeof item.state !== "string"
			|| typeof item.anchor !== "string" || !Number.isSafeInteger(item.revision)) {
			throw new Error("invalid page entry");
		}
		entries.push({ id: item.id, state: item.state, anchor: item.anchor, revision: item.revision as number });
	}
	return { source: value.source, generation: typeof value.generation === "number" && Number.isSafeInteger(value.generation) ? value.generation : null, entries };
}

/** Accept only a detached report for the exact selected page. */
export function parsePageRunSubmission(stdout: string, target: string): string {
	const value: unknown = JSON.parse(stdout);
	if (!isRecord(value)) throw new Error("invalid page run response");
	if (value.status === "unavailable") throw new Error(typeof value.reason === "string" ? value.reason : "page run unavailable");
	if (value.target !== target || value.mode !== "report" || typeof value.runId !== "string" || !value.runId) {
		throw new Error("page run did not return an exact report ID");
	}
	return value.runId;
}

/** Verify that a polled record still describes the saved page and report mode. */
export function parsePageRunRecord(stdout: string, id: string, target: string): PageRun {
	const value: unknown = JSON.parse(stdout);
	if (!isRecord(value) || value.id !== id || value.kind !== "page" || value.mode !== "report"
		|| !Array.isArray(value.targets) || value.targets.length !== 1 || value.targets[0] !== target
		|| !RUN_STATES.includes(value.state as RunState)) {
		throw new Error("run record no longer matches this page");
	}
	const history = Array.isArray(value.history) ? value.history : [];
	const last: unknown = history[history.length - 1];
	const reason = isRecord(last) && typeof last.reason === "string" ? last.reason : "";
	return { id, state: value.state as RunState, reason };
}

function runLabel(run: PageRun): string {
	if (run.state === "succeeded") return "Report complete; no fix applied";
	if (run.state === "paused-budget") return "Report paused for budget";
	if (run.state === "failed") return "Report failed";
	if (run.state === "cancelled") return "Report cancelled";
	return `Report ${run.state}`;
}

/** Track one durable report ID and poll only the active page after reload. */
export class PageStaleness {
	private statusItem: HTMLElement | null = null;
	private timer: number | null = null;
	private revision = 0;
	private panel: PageStalenessModal | null = null;
	private lastRun: { target: string; run: PageRun } | null = null;
	private submissions = new Map<string, Promise<void>>();

	constructor(
		private plugin: Plugin,
		private binaryPath: () => string,
		private getRunId: (target: string) => string | null,
		private saveRunId: (target: string, id: string) => Promise<void>,
	) {}

	/** Continue status observation without starting a new paid run. */
	register(): void {
		this.statusItem = this.plugin.addStatusBarItem();
		this.plugin.registerEvent(this.plugin.app.workspace.on("file-open", () => { void this.refreshActiveRun(true); }));
		this.timer = window.setInterval(() => { void this.refreshActiveRun(); }, RUN_POLL_MS);
		this.plugin.registerInterval(this.timer);
		this.plugin.app.workspace.onLayoutReady(() => { void this.refreshActiveRun(true); });
	}

	dispose(): void {
		this.revision++;
		if (this.timer !== null) window.clearInterval(this.timer);
		this.panel = null;
	}

	/** The menu opens a read-only list before the optional report submission. */
	openActivePage(): void {
		try {
			const context = resolveActivePage(this.plugin);
			this.panel = new PageStalenessModal(this.plugin, context, this, this.binaryPath);
			this.panel.open();
			void this.refreshActiveRun(true);
		} catch (error: unknown) {
			new Notice(`paniolo: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	panelClosed(panel: PageStalenessModal): void {
		if (this.panel === panel) this.panel = null;
	}

	getSavedRunId(target: string): string | null {
		return this.getRunId(target);
	}

	/** A repeat click joins the known active run; only an explicit later click starts another. */
	async submit(context: PageContext): Promise<void> {
		const pending = this.submissions.get(context.target);
		if (pending) return pending;
		const submission = this.submitOnce(context);
		this.submissions.set(context.target, submission);
		try { await submission; }
		finally { this.submissions.delete(context.target); }
	}

	private async submitOnce(context: PageContext): Promise<void> {
		const existing = this.getRunId(context.target);
		if (existing) {
			const current = await this.readRun(context, existing);
			if (!(["succeeded", "failed", "cancelled"] as RunState[]).includes(current.state)) {
				if (this.plugin.app.workspace.getActiveFile()?.path === context.file.path) this.showRun(context.target, current);
				return;
			}
		}
		const result = await runPaniolo(
			resolveBinary(this.binaryPath()),
			["stale", "--root", context.configRoot, "run", "--page", context.target, "--detach"],
			context.configRoot,
			SUBMIT_TIMEOUT_MS,
		);
		if (result.code !== 0) throw new Error(result.stderr.trim() || "page report could not start");
		const id = parsePageRunSubmission(result.stdout, context.target);
		await this.saveRunId(context.target, id);
		if (this.plugin.app.workspace.getActiveFile()?.path === context.file.path) {
			this.showRun(context.target, { id, state: "queued", reason: "" });
		}
		void this.refreshActiveRun();
	}

	private async readRun(context: PageContext, id: string): Promise<PageRun> {
		const result = await runPaniolo(
			resolveBinary(this.binaryPath()),
			["stale", "--root", context.configRoot, "runs", "show", id, "--json"],
			context.configRoot,
			READ_TIMEOUT_MS,
		);
		if (result.code !== 0) throw new Error(result.stderr.trim() || "run status unavailable");
		return parsePageRunRecord(result.stdout, id, context.target);
	}

	private showRun(target: string, run: PageRun): void {
		this.lastRun = { target, run };
		this.statusItem?.setText(`paniolo: ${runLabel(run)}`);
		if (this.panel?.target === target) this.panel.showRun(run);
	}

	/** Poll exactly one saved ID; a late response from another page is ignored. */
	async refreshActiveRun(force = false): Promise<void> {
		const request = ++this.revision;
		let context: PageContext;
		try { context = resolveActivePage(this.plugin); } catch { return; }
		const id = this.getRunId(context.target);
		if (!id) {
			this.statusItem?.setText("paniolo: no page report");
			return;
		}
		if (!force && this.lastRun?.target === context.target && this.lastRun.run.id === id
			&& (["succeeded", "failed", "cancelled"] as RunState[]).includes(this.lastRun.run.state)) return;
		try {
			const run = await this.readRun(context, id);
			if (this.revision === request && this.plugin.app.workspace.getActiveFile()?.path === context.file.path) {
				this.showRun(context.target, run);
			}
		} catch (error: unknown) {
			if (this.revision === request) {
				this.statusItem?.setText("paniolo: report status unavailable");
				if (this.panel?.target === context.target) this.panel.showError(error instanceof Error ? error.message : String(error));
			}
		}
	}

	getLastRun(target: string): PageRun | null {
		return this.lastRun?.target === target ? this.lastRun.run : null;
	}
}

class PageStalenessModal extends Modal {
	private entriesEl!: HTMLElement;
	private runEl!: HTMLElement;
	private closed = false;
	readonly target: string;

	constructor(
		private plugin: Plugin,
		private context: PageContext,
		private controller: PageStaleness,
		private binaryPath: () => string,
	) {
		super(plugin.app);
		this.target = context.target;
	}

	onOpen(): void {
		this.closed = false;
		this.contentEl.createEl("h3", { text: "Page staleness" });
		this.contentEl.createEl("p", { text: this.context.target });
		this.entriesEl = this.contentEl.createDiv({ cls: "paniolo-page-entries" });
		this.runEl = this.contentEl.createDiv({ cls: "paniolo-page-run" });
		this.entriesEl.setText("Loading open entries…");
		new Setting(this.contentEl)
			.setName("Page report")
			.setDesc("Runs in the background on the committed page. This does not apply a fix.")
			.addButton((button) => button.setButtonText("Run page report").onClick(() => {
				void this.submitReport();
			}));
		const run = this.controller.getLastRun(this.target);
		if (run) this.showRun(run);
		else if (this.controller.getSavedRunId(this.target)) this.runEl.setText("Loading saved report…");
		void this.loadEntries();
	}

	onClose(): void {
		this.closed = true;
		this.controller.panelClosed(this);
		this.contentEl.empty();
	}

	showRun(run: PageRun): void {
		if (this.closed) return;
		this.runEl.setText(`${runLabel(run)} · ${run.id}${run.reason ? ` · ${run.reason}` : ""}`);
	}

	showError(message: string): void {
		if (this.closed) return;
		this.runEl.setText(`Report status unavailable: ${message}`);
	}

	private async submitReport(): Promise<void> {
		this.runEl.setText("Submitting page report…");
		try { await this.controller.submit(this.context); }
		catch (error: unknown) { this.showError(error instanceof Error ? error.message : String(error)); }
	}

	private async loadEntries(): Promise<void> {
		try {
			const result = await runPaniolo(
				resolveBinary(this.binaryPath()),
				["stale", "--root", this.context.configRoot, "list", "--only", this.target, "--open", "--json"],
				this.context.configRoot,
				READ_TIMEOUT_MS,
			);
			if (result.code !== 0) throw new Error(result.stderr.trim() || "entry list unavailable");
			const list = parseOpenEntries(result.stdout, this.target);
			if (this.closed) return;
			this.entriesEl.empty();
			this.entriesEl.createEl("p", { text: `${list.entries.length} open entr${list.entries.length === 1 ? "y" : "ies"}${list.source === "snapshot" ? " (snapshot)" : ""}` });
			for (const entry of list.entries) this.renderEntry(entry);
		} catch (error: unknown) {
			if (this.closed) return;
			this.entriesEl.setText(`Open entries unavailable: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private renderEntry(entry: OpenEntry): void {
		const setting = new Setting(this.entriesEl)
			.setName(`${entry.id} · ${entry.state}`)
			.setDesc(`Heading: ${entry.anchor || "page"} · revision ${entry.revision}`);
		setting.addButton((button) => button.setButtonText("Evidence").onClick(() => { void this.showEvidence(entry.id); }));
		setting.addButton((button) => button.setButtonText("Jump to heading").onClick(() => this.jumpToHeading(entry.anchor)));
	}

	private async showEvidence(id: string): Promise<void> {
		try {
			const result = await runPaniolo(resolveBinary(this.binaryPath()), ["stale", "--root", this.context.configRoot, "show", id], this.context.configRoot, READ_TIMEOUT_MS);
			if (result.code !== 0) throw new Error(result.stderr.trim() || "evidence unavailable");
			const details = new Modal(this.app);
			details.contentEl.createEl("h3", { text: `Evidence for ${id}` });
			details.contentEl.createEl("pre", { cls: "paniolo-report", text: result.stdout });
			details.open();
		} catch (error: unknown) {
			new Notice(`paniolo: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private jumpToHeading(anchor: string): void {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view || view.file?.path !== this.context.file.path) {
			new Notice("paniolo: reopen the selected page to jump to its heading");
			return;
		}
		const doc = Text.of(view.editor.getValue().split(/\r?\n/));
		const line = headingLineForAnchor(doc, anchor);
		if (line === null) {
			new Notice(`paniolo: heading ${anchor || "page"} is no longer present`);
			return;
		}
		view.editor.setCursor({ line: line - 1, ch: 0 });
		view.editor.focus();
		this.close();
	}
}
