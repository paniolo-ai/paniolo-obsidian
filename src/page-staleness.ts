import { FileSystemAdapter, MarkdownView, Modal, Notice, Plugin, Setting, TFile } from "obsidian";
import { Text } from "@codemirror/state";
import { createHash } from "crypto";
import { mkdtemp, rmdir, unlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { findConfigRoot, resolveBinary, runPaniolo } from "./paniolo";
import { loadWikis } from "./new-page";
import { pageKeyForPath } from "./page-staleness-key";
import { applyReviewedPatch, parseReviewedPagePatches, type ReviewedPagePatches, type ReviewedPatch } from "./page-staleness-patch";
import { preparePagePr, publishPagePr } from "./page-staleness-pr";
import { inspectPagePrReview, submitPagePrReview, type PagePrReviewPlan } from "./page-staleness-review";
import { headingLineForAnchor } from "./staleness-indicator";

type PageContext = { file: TFile; configRoot: string; target: string };
type OpenEntry = { id: string; state: string; anchor: string; revision: number };
type OpenList = { source: "active-writer" | "snapshot"; generation: number | null; entries: OpenEntry[] };
type RunState = "queued" | "preparing" | "running" | "draining" | "paused-budget" | "succeeded" | "failed" | "cancelled";
type PageRun = { id: string; state: RunState; reason: string; snapshotHash: string };
type EditorSnapshot = { text: string; hash: string };

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

function editorSnapshot(plugin: Plugin, context: PageContext): EditorSnapshot {
	const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
	if (!view || view.file?.path !== context.file.path) throw new Error("open the selected page in the editor");
	const text = view.editor.getValue();
	return { text, hash: createHash("sha256").update(text, "utf8").digest("hex") };
}

function snapshotRunKey(target: string, hash: string): string {
	return `${target}@sha256:${hash}`;
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
export function parsePageRunSubmission(stdout: string, target: string, snapshotHash?: string): string {
	const value: unknown = JSON.parse(stdout);
	if (!isRecord(value)) throw new Error("invalid page run response");
	if (value.status === "unavailable") throw new Error(typeof value.reason === "string" ? value.reason : "page run unavailable");
	if (value.target !== target || value.mode !== "report" || typeof value.runId !== "string" || !value.runId) {
		throw new Error("page run did not return an exact report ID");
	}
	if (snapshotHash !== undefined && (!isRecord(value.estimate) || !isRecord(value.estimate.page)
		|| value.estimate.page.snapshot_sha256 !== snapshotHash)) throw new Error("page run used different editor bytes");
	return value.runId;
}

/** Verify that a polled record still describes the saved page and report mode. */
export function parsePageRunRecord(stdout: string, id: string, target: string, snapshotHash = ""): PageRun {
	const value: unknown = JSON.parse(stdout);
	if (!isRecord(value) || value.id !== id || value.kind !== "page" || value.mode !== "report"
		|| !Array.isArray(value.targets) || value.targets.length !== 1 || value.targets[0] !== target
		|| !RUN_STATES.includes(value.state as RunState)) {
		throw new Error("run record no longer matches this page");
	}
	if (snapshotHash && (!isRecord(value.estimate) || !isRecord(value.estimate.page)
		|| value.estimate.page.snapshot_sha256 !== snapshotHash)) throw new Error("report belongs to a different editor snapshot");
	const history = Array.isArray(value.history) ? value.history : [];
	const last: unknown = history[history.length - 1];
	const reason = isRecord(last) && typeof last.reason === "string" ? last.reason : "";
	return { id, state: value.state as RunState, reason, snapshotHash };
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
	private reviewSubmissions = new Map<string, Promise<string>>();

	constructor(
		private plugin: Plugin,
		private binaryPath: () => string,
		private getRunId: (target: string) => string | null,
		private saveRunId: (target: string, id: string) => Promise<void>,
		private getReviewId: (key: string) => string | null = () => null,
		private saveReviewId: (key: string, id: string) => Promise<void> = async () => {},
	) {}

	/** Inspect the active topic PR without submitting a review. */
	async inspectReview(context: PageContext): Promise<PagePrReviewPlan> {
		const repo = context.target.slice(0, context.target.indexOf(":"));
		const wiki = loadWikis(context.configRoot).find((item) => item.name === repo);
		if (!wiki) throw new Error("configured wiki repository is unavailable");
		return inspectPagePrReview(context.configRoot, resolve(context.configRoot, wiki.repoPath), repo,
			resolveBinary(this.binaryPath()));
	}

	getSavedReviewId(plan: PagePrReviewPlan): string | null {
		return this.getReviewId(plan.key);
	}

	/** A repeat click joins the saved exact-head review; a changed scope gets a new key. */
	async submitReview(plan: PagePrReviewPlan, configRoot: string): Promise<string> {
		const current = await inspectPagePrReview(configRoot, plan.repoRoot, plan.repo, resolveBinary(this.binaryPath()));
		if (current.key !== plan.key) throw new Error("PR head or open-entry scope changed; inspect the review plan again");
		const saved = this.getReviewId(plan.key);
		if (saved) return saved;
		const pending = this.reviewSubmissions.get(plan.key);
		if (pending) return pending;
		const submission = (async (): Promise<string> => {
			const id = await submitPagePrReview(plan, configRoot, resolveBinary(this.binaryPath()));
			await this.saveReviewId(plan.key, id);
			return id;
		})();
		this.reviewSubmissions.set(plan.key, submission);
		try { return await submission; }
		finally { this.reviewSubmissions.delete(plan.key); }
	}

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
		try {
			const context = resolveActivePage(this.plugin);
			return context.target === target ? this.getRunId(snapshotRunKey(target, editorSnapshot(this.plugin, context).hash)) : null;
		} catch { return null; }
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
		const snapshot = editorSnapshot(this.plugin, context);
		const key = snapshotRunKey(context.target, snapshot.hash);
		const existing = this.getRunId(key);
		if (existing) {
			const current = await this.readRun(context, existing, snapshot.hash);
			if (editorSnapshot(this.plugin, context).hash !== snapshot.hash) throw new Error("editor changed while reading the saved report");
			if (!(["succeeded", "failed", "cancelled"] as RunState[]).includes(current.state)) {
				if (this.plugin.app.workspace.getActiveFile()?.path === context.file.path) this.showRun(context.target, current);
				return;
			}
		}
		const directory = await mkdtemp(join(tmpdir(), "paniolo-page-snapshot-"));
		const file = join(directory, "editor.md");
		let id: string;
		try {
			await writeFile(file, snapshot.text, { encoding: "utf8", flag: "wx", mode: 0o600 });
			if (editorSnapshot(this.plugin, context).hash !== snapshot.hash) throw new Error("editor changed before report submission");
			const result = await runPaniolo(
				resolveBinary(this.binaryPath()),
				["stale", "--root", context.configRoot, "run", "--page", context.target, "--detach",
					"--page-snapshot-file", file, "--page-snapshot-sha256", snapshot.hash],
				context.configRoot,
				SUBMIT_TIMEOUT_MS,
			);
			if (result.code !== 0) throw new Error(result.stderr.trim() || "page report could not start");
			id = parsePageRunSubmission(result.stdout, context.target, snapshot.hash);
			await this.saveRunId(key, id);
		} finally {
			await unlink(file).catch(() => {});
			await rmdir(directory);
		}
		if (editorSnapshot(this.plugin, context).hash !== snapshot.hash) throw new Error("editor changed during report submission; old snapshot run was saved separately");
		if (this.plugin.app.workspace.getActiveFile()?.path === context.file.path) {
			this.showRun(context.target, { id, state: "queued", reason: "", snapshotHash: snapshot.hash });
		}
		void this.refreshActiveRun();
	}

	private async readRun(context: PageContext, id: string, snapshotHash: string): Promise<PageRun> {
		const result = await runPaniolo(
			resolveBinary(this.binaryPath()),
			["stale", "--root", context.configRoot, "runs", "show", id, "--json"],
			context.configRoot,
			READ_TIMEOUT_MS,
		);
		if (result.code !== 0) throw new Error(result.stderr.trim() || "run status unavailable");
		return parsePageRunRecord(result.stdout, id, context.target, snapshotHash);
	}

	/** Fetch only reviewed patches sealed against the active editor bytes. */
	async reviewedPatches(context: PageContext, run: PageRun): Promise<ReviewedPagePatches> {
		if (run.state !== "succeeded") throw new Error("page report has not completed");
		const snapshot = editorSnapshot(this.plugin, context);
		if (snapshot.hash !== run.snapshotHash) throw new Error("editor changed since the page report");
		const result = await runPaniolo(
			resolveBinary(this.binaryPath()),
			["stale", "--root", context.configRoot, "runs", "patches", run.id, "--json"],
			context.configRoot,
			READ_TIMEOUT_MS,
		);
		if (result.code !== 0) throw new Error(result.stderr.trim() || "reviewed patches unavailable");
		const patches = parseReviewedPagePatches(result.stdout, run.id, context.target, snapshot.hash);
		if (editorSnapshot(this.plugin, context).hash !== snapshot.hash) throw new Error("editor changed while loading reviewed patches");
		return patches;
	}

	/** Make one undoable edit, then publish its checked page commit to a topic PR. */
	async applyPatch(context: PageContext, result: ReviewedPagePatches, patch: ReviewedPatch): Promise<string> {
		if (!result.patches.some((item) => item.bundleId === patch.bundleId && item.patchHash === patch.patchHash
			&& item.allegationId === patch.allegationId && item.patch === patch.patch)) {
			throw new Error("patch is not in this reviewed result");
		}
		const snapshot = editorSnapshot(this.plugin, context);
		if (snapshot.hash !== result.snapshotSha256) throw new Error("editor changed since the patch was reviewed");
		const pagePath = context.target.slice(context.target.indexOf(":") + 1);
		const patched = applyReviewedPatch(snapshot.text, patch.patch, pagePath);
		if (patched === snapshot.text) throw new Error("reviewed patch makes no change");
		const adapter = this.plugin.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) throw new Error("unsupported vault adapter");
		const route = await preparePagePr(context.configRoot, context.target, join(adapter.getBasePath(), context.file.path),
			snapshot.hash, result.runId, loadWikis(context.configRoot));
		const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view || view.file?.path !== context.file.path || editorSnapshot(this.plugin, context).hash !== snapshot.hash) {
			throw new Error("editor changed before patch acceptance");
		}
		const last = view.editor.lastLine();
		view.editor.replaceRange(patched, { line: 0, ch: 0 }, { line: last, ch: view.editor.getLine(last).length });
		void this.refreshActiveRun(true);
		try {
			return await publishPagePr(route, createHash("sha256").update(patched, "utf8").digest("hex"), patch.allegationId,
				context.configRoot, resolveBinary(this.binaryPath()), () => editorSnapshot(this.plugin, context).hash);
		} catch (error: unknown) {
			throw new Error(`patch applied locally; PR publication stopped: ${error instanceof Error ? error.message : String(error)}`);
		}
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
		let snapshot: EditorSnapshot;
		try { snapshot = editorSnapshot(this.plugin, context); } catch { this.statusItem?.setText("paniolo: open page in editor"); return; }
		const id = this.getRunId(snapshotRunKey(context.target, snapshot.hash));
		if (!id) {
			this.statusItem?.setText("paniolo: no report for this edit");
			if (this.panel?.target === context.target) this.panel.showNoCurrentReport();
			return;
		}
		if (!force && this.lastRun?.target === context.target && this.lastRun.run.id === id && this.lastRun.run.snapshotHash === snapshot.hash
			&& (["succeeded", "failed", "cancelled"] as RunState[]).includes(this.lastRun.run.state)) return;
		try {
			const run = await this.readRun(context, id, snapshot.hash);
			if (this.revision === request && this.plugin.app.workspace.getActiveFile()?.path === context.file.path
				&& editorSnapshot(this.plugin, context).hash === snapshot.hash) {
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
		try {
			const context = resolveActivePage(this.plugin);
			return context.target === target && this.lastRun?.target === target
				&& this.lastRun.run.snapshotHash === editorSnapshot(this.plugin, context).hash
				? this.lastRun.run : null;
		} catch { return null; }
	}
}

class PageStalenessModal extends Modal {
	private entriesEl!: HTMLElement;
	private runEl!: HTMLElement;
	private reviewEl!: HTMLElement;
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
		this.reviewEl = this.contentEl.createDiv({ cls: "paniolo-page-review" });
		this.entriesEl.setText("Loading open entries…");
		new Setting(this.contentEl)
			.setName("Page report")
			.setDesc("Runs in the background on the current editor snapshot. This does not apply a fix.")
			.addButton((button) => button.setButtonText("Run page report").onClick(() => {
				void this.submitReport();
			}));
		new Setting(this.contentEl)
			.setName("Independent PR review")
			.setDesc("Inspect the current PR head, open entries, and invocation limit before explicitly starting a background review.")
			.addButton((button) => button.setButtonText("Inspect current PR").onClick(() => { void this.inspectReview(); }));
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
		if (run.state === "succeeded") new Setting(this.runEl)
			.setName("Reviewed page patches")
			.setDesc("Preview each independently reviewed patch. Acceptance edits this page, runs focused checks, and publishes its topic PR; ledger entries stay open.")
			.addButton((button) => button.setButtonText("Review patches").onClick(() => { void this.previewPatches(run); }));
	}

	private async previewPatches(run: PageRun): Promise<void> {
		try {
			const result = await this.controller.reviewedPatches(this.context, run);
			if (this.closed) return;
			this.runEl.setText(`${result.patches.length} reviewed patch${result.patches.length === 1 ? "" : "es"} for this editor snapshot`);
			for (const patch of result.patches) {
				this.runEl.createEl("p", { text: `${patch.allegationId} · ${patch.bundleId}` });
				this.runEl.createEl("pre", { cls: "paniolo-report", text: patch.patch });
				new Setting(this.runEl).addButton((button) => button.setButtonText("Apply and open PR").setWarning().onClick(() => {
					void this.applyPatch(result, patch);
				}));
			}
		} catch (error: unknown) { this.showError(error instanceof Error ? error.message : String(error)); }
	}

	private async applyPatch(result: ReviewedPagePatches, patch: ReviewedPatch): Promise<void> {
		try {
			this.runEl.setText("Applying reviewed patch and routing page to a topic PR…");
			const url = await this.controller.applyPatch(this.context, result, patch);
			this.runEl.setText(`Page PR: ${url}. Ledger entries remain open until merge and independent verification.`);
		} catch (error: unknown) { this.showError(error instanceof Error ? error.message : String(error)); }
	}

	private async inspectReview(): Promise<void> {
		this.reviewEl.setText("Loading exact-head review plan…");
		try {
			const plan = await this.controller.inspectReview(this.context);
			if (this.closed) return;
			const count = plan.files.reduce((total, file) => total + file.entries.length, 0);
			this.reviewEl.setText(`PR #${plan.prNumber} · head ${plan.head.slice(0, 12)} · ${count} open entries · at most ${plan.maximumRoleInvocations} role invocations of configured ${plan.invocationCeiling}`);
			for (const file of plan.files) {
				this.reviewEl.createEl("p", { text: `${file.path}: ${file.entries.map((entry) => entry.id).join(", ") || "zero open entries"}` });
			}
			const saved = this.controller.getSavedReviewId(plan);
			if (saved) {
				this.reviewEl.createEl("p", { text: `Background review already submitted: ${saved}` });
				return;
			}
			new Setting(this.reviewEl)
				.setName("Start independent review")
				.setDesc("May invoke paid model roles in the background. Entries remain open until a later merge and writer-owned verification.")
				.addButton((button) => button.setButtonText("Start review").setWarning().onClick(() => { void this.submitReview(plan); }));
		} catch (error: unknown) {
			if (!this.closed) this.reviewEl.setText(`PR review unavailable: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async submitReview(plan: PagePrReviewPlan): Promise<void> {
		this.reviewEl.setText("Submitting exact-head background review…");
		try {
			const id = await this.controller.submitReview(plan, this.context.configRoot);
			if (!this.closed) this.reviewEl.setText(`Background review submitted for ${plan.head.slice(0, 12)}: ${id}. Ledger entries remain open.`);
		} catch (error: unknown) {
			if (!this.closed) this.reviewEl.setText(`PR review unavailable: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	showNoCurrentReport(): void {
		if (!this.closed) this.runEl.setText("No report for the current editor snapshot");
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
