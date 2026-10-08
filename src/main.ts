import {
	FileSystemAdapter,
	MarkdownView,
	Notice,
	Plugin,
	TFile,
} from "obsidian";
import { lintGutter, setDiagnostics } from "@codemirror/lint";
import { EditorView } from "@codemirror/view";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { dirname, isAbsolute, join, relative } from "path";
import {
	Finding,
	findingsToDiagnostics,
	parseScanFindings,
	parseWikiFindings,
} from "./lint";
import {
	PanioloNotFoundError,
	PanioloTimeoutError,
	findConfigRoot,
	resolveBinary,
	runPaniolo,
} from "./paniolo";
import { ActionBar } from "./action-bar";
import { showPageReferences } from "./page-references";
import { showPageSources } from "./page-sources";
import { searchRelatedPages } from "./related-pages";
import { SearchPagesModal } from "./search-pages";
import {
	NewPageModal,
	NewPageResult,
	WikiConfig,
	loadWikis,
	slugForAbsPath,
	slugify,
	wikiForAbsPath,
} from "./new-page";
import {
	ChoiceModal,
	ConfirmModal,
	PromptModal,
	ReportModal,
} from "./wiki-ops";
import { DEFAULT_SETTINGS, PanioloSettingTab, PanioloSettings } from "./settings";

function argsTail(args: string[]): string {
	return args.slice(1).join(" ");
}

export default class PanioloPlugin extends Plugin {
	settings: PanioloSettings = DEFAULT_SETTINGS;
	private statusItem: HTMLElement | null = null;
	private actionBar = new ActionBar(this);
	private findingsByPath = new Map<string, Finding[]>();
	private lintTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private lintRevisions = new Map<string, number>();

	async onload(): Promise<void> {
		await this.loadSettings();

		this.registerEditorExtension([lintGutter()]);
		this.statusItem = this.addStatusBarItem();
		this.setStatus("ready");
		this.addSettingTab(new PanioloSettingTab(this.app, this));

		this.addCommand({
			id: "lint-this-page",
			name: "Lint this page",
			editorCallback: () => {
				void this.lintActiveFile();
			},
		});

		this.addCommand({
			id: "new-wiki-page",
			name: "New page",
			callback: () => this.openNewPageModal(),
		});

		this.addCommand({
			id: "search-pages",
			name: "Search pages",
			callback: () => this.openSearchPages(),
		});

		this.addCommand({
			id: "search-related-pages",
			name: "Search for related pages",
			callback: () => {
				void this.searchRelatedPages();
			},
		});

		this.addCommand({
			id: "wiki-related-pages",
			name: "Add or update related pages",
			callback: () => new Notice("Coming soon…"),
		});

		this.addCommand({
			id: "fix-page-staleness",
			name: "Fix page staleness",
			callback: () => new Notice("Coming soon…"),
		});

		this.addCommand({
			id: "search-pages-related-to-selection",
			name: "Search for pages related to selection",
			callback: () => this.searchPagesRelatedToSelection(),
		});

		const ops: [string, string, (f: TFile) => void][] = [
			["wiki-rename-page", "Rename page", (f) => this.wikiRename(f)],
			["wiki-move-page", "Move page to another wiki", (f) => this.wikiMove(f)],
			["wiki-archive-page", "Archive page", (f) => this.wikiArchive(f)],
			["wiki-delete-page", "Delete page", (f) => this.wikiDelete(f)],
			["wiki-set-status", "Set page status", (f) => this.wikiSetStatus(f)],
			["wiki-refs", "Search for page references", (f) => void this.wikiRefs(f)],
			["wiki-sources", "View sources for page", (f) => void this.wikiSources(f)],
			["wiki-fix", "Apply autofixes to page", (f) => void this.wikiFix(f)],
		];
		for (const [id, name, fn] of ops) {
			this.addCommand({
				id,
				name,
				callback: () => {
					const f = this.app.workspace.getActiveFile();
					if (f instanceof TFile) fn(f);
					else new Notice("paniolo: no active file");
				},
			});
		}

		// File-explorer context menu: the ops Obsidian's file ops bypass.
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (!(file instanceof TFile)) return;
				if (file.extension !== "md") return;
				if (!file.path.split("/").includes("wiki")) return;
				for (const [id, name, fn] of ops) {
					menu.addItem((i) =>
						i
							.setTitle(name)
							.onClick(() => fn(file)),
					);
				}
			}),
		);

		// Stored findings follow the file when the leaf switches notes.
		this.registerEvent(
			this.app.workspace.on("file-open", () => this.applyStored()),
		);
		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (!(file instanceof TFile) || file.extension !== "md") return;
				if (this.app.workspace.getActiveFile()?.path !== file.path) return;
				this.scheduleLint(file);
			}),
		);
		this.actionBar.register();
	}

	onunload(): void {
		for (const timer of this.lintTimers.values()) clearTimeout(timer);
		this.lintTimers.clear();
		this.lintRevisions.clear();
		this.findingsByPath.clear();
		this.actionBar.removeAll();
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	private setStatus(text: string): void {
		this.statusItem?.setText(`paniolo: ${text}`);
	}

	/** The live CodeMirror view for the active markdown editor, if any. */
	private cmView(): EditorView | null {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const cm = (view?.editor as unknown as { cm?: EditorView })?.cm;
		return cm ?? null;
	}

	private activeAbsPath(file: TFile): string | null {
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) return null;
		return join(adapter.getBasePath(), file.path);
	}

	/** Open free-text qmd search over wiki pages this vault can navigate. */
	private openSearchPages(): void {
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) {
			new Notice("paniolo: unsupported vault adapter");
			return;
		}
		const sourceView = this.app.workspace.getActiveViewOfType(MarkdownView);
		const sourceFile = sourceView?.file;
		const startDir = sourceFile
			? dirname(join(adapter.getBasePath(), sourceFile.path))
			: adapter.getBasePath();
		const configRoot = findConfigRoot(startDir);
		if (!configRoot) {
			new Notice("paniolo: no paniolo.config.json found for this vault");
			return;
		}
		if (!loadWikis(configRoot).length) {
			new Notice("paniolo: no wikis declared in paniolo.config.json");
			return;
		}
		new SearchPagesModal({
			app: this.app,
			configRoot,
			vaultRoot: adapter.getBasePath(),
			binary: resolveBinary(this.settings.binaryPath),
			sourceView,
		}).open();
	}

	/** Capture the editor selection before opening the delayed results menu. */
	private searchPagesRelatedToSelection(): void {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const selectedText = view?.editor.getSelection().trim().replace(/\s+/g, " ").slice(0, 1000);
		if (!selectedText) {
			new Notice("paniolo: select text in a markdown page first");
			return;
		}
		void this.searchRelatedPages(selectedText);
	}

	/** Search from the open note or selection for vault-resolvable wiki pages. */
	private async searchRelatedPages(selectedText?: string): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (!(file instanceof TFile) || file.extension !== "md") {
			new Notice("paniolo: open a markdown page to search from");
			return;
		}
		const absPath = this.activeAbsPath(file);
		const adapter = this.app.vault.adapter;
		if (!absPath || !(adapter instanceof FileSystemAdapter)) {
			new Notice("paniolo: unsupported vault adapter");
			return;
		}
		const configRoot = findConfigRoot(dirname(absPath));
		if (!configRoot) {
			new Notice("paniolo: no paniolo.config.json above this page");
			return;
		}
		await searchRelatedPages({
			app: this.app,
			file,
			configRoot,
			vaultRoot: adapter.getBasePath(),
			binary: resolveBinary(this.settings.binaryPath),
			...(selectedText === undefined ? {} : { selectedText }),
		});
	}

	private applyStored(): void {
		const file = this.app.workspace.getActiveFile();
		const view = this.cmView();
		if (!file || !view) return;
		const findings = this.findingsByPath.get(file.path) ?? [];
		view.dispatch(
			setDiagnostics(view.state, findingsToDiagnostics(view.state.doc, findings)),
		);
		const errs = findings.filter((f) => f.severity === "error").length;
		const warns = findings.filter((f) => f.severity === "warn").length;
		this.setStatus(
			findings.length === 0 ? "clean" : `${errs} error · ${warns} warn`,
		);
	}

	private openNewPageModal(): void {
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) {
			new Notice("paniolo: unsupported vault adapter");
			return;
		}
		const file = this.app.workspace.getActiveFile();
		const absPath = file ? this.activeAbsPath(file) : null;
		const configRoot =
			(absPath ? findConfigRoot(dirname(absPath)) : null) ??
			findConfigRoot(adapter.getBasePath());
		if (!configRoot) {
			new Notice(
				"paniolo: no paniolo.config.json found — the vault is not paniolo-configured",
			);
			return;
		}
		const wikis = loadWikis(configRoot);
		if (!wikis.length) {
			new Notice("paniolo: no wikis declared in paniolo.config.json");
			return;
		}
		new NewPageModal(this.app, wikis, (r) =>
			void this.createWikiPage(configRoot, r),
		).open();
	}

	private async createWikiPage(
		configRoot: string,
		r: NewPageResult,
	): Promise<void> {
		const binary = resolveBinary(this.settings.binaryPath);
		const args = [
			"wiki",
			"--config",
			join(configRoot, "paniolo.config.json"),
			"--wiki",
			r.wiki.name,
			"new",
			r.slug,
			"--tags",
			r.tags,
		];
		if (r.kind) args.push("--kind", r.kind);
		if (r.title) args.push("--title", r.title);
		if (r.source) args.push("--source", r.source);
		if (r.domain) args.push("--domain", r.domain);

		const kind = r.wiki.kinds.find((k) => k.kind === r.kind);
		const filename =
			kind && !r.slug.startsWith(kind.prefix)
				? kind.prefix + r.slug
				: r.slug;
		if (!(await this.claimSlugNamespace(configRoot, filename))) return;

		this.setStatus("creating…");
		try {
			const res = await runPaniolo(binary, args, configRoot);
			if (res.code !== 0) {
				this.setStatus("error");
				const detail =
					res.stderr
						.split("\n")
						.map((l) => l.trim())
						.find((l) => l.length > 0) ??
					res.stdout.trim().split("\n").pop() ??
					"unknown error";
				new Notice(`paniolo: wiki new failed — ${detail}`, 8000);
				return;
			}

			const adapter = this.app.vault.adapter as FileSystemAdapter;
			const relRoot = relative(adapter.getBasePath(), configRoot).replace(
				/\\/g,
				"/",
			);
			const vaultPath =
				(relRoot ? `${relRoot}/` : "") +
				`${r.wiki.wikiRoot}/${filename}.md`;

			const tfile = await this.waitForFile(vaultPath);
			if (tfile) {
				await this.app.workspace.getLeaf(false).openFile(tfile);
				new Notice(`paniolo: created ${filename}`);
			} else {
				new Notice(`paniolo: created ${filename} — reopen the wiki folder to see it`);
			}
			this.setStatus("ready");
		} catch (e) {
			this.setStatus("error");
			if (e instanceof PanioloNotFoundError) {
				new Notice(
					"paniolo: binary not found — install @paniolo/cli or set the path in plugin settings",
				);
			} else if (e instanceof PanioloTimeoutError) {
				new Notice("paniolo: wiki new timed out");
			} else {
				new Notice(`paniolo: wiki new failed — ${(e as Error).message}`);
			}
		}
	}

	/** Poll the vault index for a just-created file (Obsidian lags disk). */
	private async waitForFile(path: string, ms = 4000): Promise<TFile | null> {
		const deadline = Date.now() + ms;
		while (Date.now() < deadline) {
			const f = this.app.vault.getAbstractFileByPath(path);
			if (f instanceof TFile) return f;
			await new Promise((res) => setTimeout(res, 100));
		}
		return null;
	}

	// ── wiki ops (card 8.5) ─────────────────────────────────────────────

	private wikiContext(file: TFile): {
		configRoot: string;
		configPath: string;
		wiki: WikiConfig;
		slug: string;
	} | null {
		const absPath = this.activeAbsPath(file);
		if (!absPath) {
			new Notice("paniolo: unsupported vault adapter");
			return null;
		}
		const configRoot = findConfigRoot(dirname(absPath));
		if (!configRoot) {
			new Notice("paniolo: no paniolo.config.json above this file");
			return null;
		}
		const wiki = wikiForAbsPath(configRoot, absPath, loadWikis(configRoot));
		if (!wiki) {
			new Notice("paniolo: file is not under a configured wiki root");
			return null;
		}
		return {
			configRoot,
			configPath: join(configRoot, "paniolo.config.json"),
			wiki,
			slug: slugForAbsPath(configRoot, wiki, absPath),
		};
	}

	/**
	 * Vault-wide `[[slug]]` claim before `new`/`rename`. Obsidian resolves
	 * links by basename, so any markdown file sharing the slug collides —
	 * not just wiki pages. Layers split the work:
	 *
	 * - under a configured `wiki/` root → managed page → hard error
	 *   (cross-wiki collisions are only visible here; the CLI sees one wiki)
	 * - under a configured repo's `raw/` → the CLI claims it (renames the
	 *   snapshot aside and retargets `sources:` citations)
	 * - anywhere else → the CLI can't see it, so Obsidian renames it aside
	 *   via `fileManager` — existing `[[slug]]` links follow the rename
	 *
	 * Returns false (after a Notice) when a wiki page blocks the claim.
	 */
	private async claimSlugNamespace(
		configRoot: string,
		slug: string,
		wikis: WikiConfig[] = loadWikis(configRoot),
	): Promise<boolean> {
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) return true;
		const base = adapter.getBasePath();
		const lower = slug.toLowerCase();
		const wikiRoots = wikis.map((w) => join(configRoot, w.wikiRoot));
		const rawRoots = wikis.map((w) => join(configRoot, w.repoPath, "raw"));

		const colliding = this.app.vault
			.getMarkdownFiles()
			.filter((f) => f.basename.toLowerCase() === lower);
		const loose: TFile[] = [];
		for (const f of colliding) {
			const abs = join(base, f.path);
			const under = (root: string) => {
				const rel = relative(root, abs);
				return !!rel && !rel.startsWith("..") && !isAbsolute(rel);
			};
			if (wikiRoots.some(under)) {
				new Notice(
					`paniolo: '${slug}' already exists as a wiki page at ${f.path}`,
					8000,
				);
				return false;
			}
			if (!rawRoots.some(under)) loose.push(f);
		}

		for (const f of loose) {
			// `<stem>-raw`, then `-raw-2`, … until the directory has room.
			const dir = dirname(f.path);
			const prefix = dir === "." ? "" : `${dir}/`;
			let target = "";
			for (let n = 1; ; n += 1) {
				const stem = n === 1 ? `${f.basename}-raw` : `${f.basename}-raw-${n}`;
				target = `${prefix}${stem}.md`.replace(/\\/g, "/");
				if (!this.app.vault.getAbstractFileByPath(target)) break;
			}
			await this.app.fileManager.renameFile(f, target);
			new Notice(`paniolo: ${f.path} stepped aside → ${target}`, 8000);
		}
		return true;
	}

	/**
	 * Run a `paniolo wiki <op>`. `status`/`archive`/`delete` are dry-run
	 * unless `--apply` is passed — callers use that as a preview pass.
	 * `quiet` suppresses the failure notice (caller renders stdout itself).
	 */
	private async runWikiOp(
		ctx: { configRoot: string; configPath: string; wiki: WikiConfig },
		opArgs: string[],
		quiet = false,
	): Promise<{ ok: boolean; stdout: string; detail: string }> {
		const binary = resolveBinary(this.settings.binaryPath);
		// Corpus-scanning ops (delete/archive dry-runs) take 10–20s — say so.
		this.setStatus(`${opArgs[0]}…`);
		if (!quiet) new Notice(`paniolo: ${opArgs[0]} ${argsTail(opArgs)} — scanning the wiki, this can take ~20s`);
		try {
			const res = await runPaniolo(
				binary,
				["wiki", "--config", ctx.configPath, "--wiki", ctx.wiki.name, ...opArgs],
				ctx.configRoot,
			);
			const detail =
				res.stderr
					.split("\n")
					.map((l) => l.trim())
					.find((l) => l.length > 0) ??
				res.stdout.trim().split("\n").pop() ??
				"unknown error";
			if (res.code !== 0) {
				this.setStatus("error");
				if (!quiet) new Notice(`paniolo: ${detail}`, 8000);
				return { ok: false, stdout: res.stdout, detail };
			}
			this.setStatus("ready");
			return { ok: true, stdout: res.stdout, detail };
		} catch (e) {
			this.setStatus("error");
			const detail =
				e instanceof PanioloNotFoundError
					? "binary not found — install @paniolo/cli or set the path in plugin settings"
					: e instanceof PanioloTimeoutError
						? "operation timed out"
						: (e as Error).message;
			if (!quiet) new Notice(`paniolo: ${detail}`, 8000);
			return { ok: false, stdout: "", detail };
		}
	}

	private wikiRename(file: TFile): void {
		const ctx = this.wikiContext(file);
		if (!ctx) return;
		new PromptModal(this.app, `rename ${ctx.slug}`, ctx.slug, (v) => {
			const next = slugify(v);
			if (!next || next === ctx.slug) return;
			void (async () => {
				if (
					!(await this.claimSlugNamespace(
						ctx.configRoot,
						next,
						loadWikis(ctx.configRoot),
					))
				)
					return;
				const r = await this.runWikiOp(ctx, ["rename", ctx.slug, next]);
				if (!r.ok) return;
				new Notice(`paniolo: renamed to ${next}`);
				const adapter = this.app.vault.adapter as FileSystemAdapter;
				const relRoot = relative(adapter.getBasePath(), ctx.configRoot).replace(/\\/g, "/");
				const vaultPath =
					(relRoot ? `${relRoot}/` : "") + `${ctx.wiki.wikiRoot}/${next}.md`;
				const tfile = await this.waitForFile(vaultPath);
				if (tfile) await this.app.workspace.getLeaf(false).openFile(tfile);
				void this.reconcileAfterOp();
			});
		}).open();
	}

	private wikiMove(file: TFile): void {
		const ctx = this.wikiContext(file);
		if (!ctx) return;
		const others = loadWikis(ctx.configRoot)
			.filter((w) => w.name !== ctx.wiki.name)
			.map((w) => w.name);
		if (!others.length) {
			new Notice("paniolo: no other configured wiki to move to");
			return;
		}
		new ChoiceModal(this.app, `move ${ctx.slug} to…`, others, (v) => {
			void this.runWikiOp(ctx, ["move", ctx.slug, "--to", v]).then((r) => {
				if (r.ok) new Notice(`paniolo: moved to ${v}`);
			});
		}).open();
	}

	private wikiArchive(file: TFile): void {
		const ctx = this.wikiContext(file);
		if (!ctx) return;
		void this.confirmAppliedOp(
			ctx,
			["archive", ctx.slug],
			`archive ${ctx.slug}?`,
			"archive",
			`paniolo: archived ${ctx.slug}`,
		);
	}

	private wikiDelete(file: TFile): void {
		const ctx = this.wikiContext(file);
		if (!ctx) return;
		void this.confirmAppliedOp(
			ctx,
			["delete", ctx.slug],
			`delete ${ctx.slug}?`,
			"delete",
			`paniolo: deleted ${ctx.slug}`,
		);
	}

	/**
	 * Two-phase destructive op: dry-run shows the real plan (or the
	 * hold-back report) before the confirm dialog runs `--apply`.
	 */
	private async confirmAppliedOp(
		ctx: { configRoot: string; configPath: string; wiki: WikiConfig },
		args: string[],
		heading: string,
		verb: string,
		doneNotice: string,
	): Promise<void> {
		const preview = await this.runWikiOp(ctx, args, true);
		if (!preview.ok) {
			if (preview.stdout.trim()) {
				new ReportModal(this.app, `${heading.replace(/\?$/, "")} — refused`, preview.stdout).open();
			} else {
				new Notice(`paniolo: ${preview.detail}`, 8000);
			}
			return;
		}
		// The dry run ends with a "plan only — pass --apply" advisory; that's
		// our job to do, so don't show it in the confirm dialog.
		const plan = preview.stdout
			.split("\n")
			.filter((l) => !/plan only|--apply|dry.?run/i.test(l))
			.join("\n")
			.trim();
		new ConfirmModal(
			this.app,
			heading,
			plan || `Runs paniolo wiki ${args[0]} ${args[1]}.`,
			verb,
			() => {
				void this.runWikiOp(ctx, [...args, "--apply"]).then((r) => {
					if (r.ok) {
						new Notice(doneNotice);
						void this.reconcileAfterOp();
					}
				});
			},
		).open();
	}

	/**
	 * The vault watcher usually notices external file changes fast; when it
	 * lags, explorer entries and open leaves linger on deleted files.
	 * Give it a beat, then detach leaves whose file is gone from disk.
	 */
	private async reconcileAfterOp(): Promise<void> {
		await new Promise((r) => setTimeout(r, 1200));
		this.app.workspace.iterateAllLeaves((leaf) => {
			const view = leaf.view;
			if (!(view instanceof MarkdownView) || !view.file) return;
			const abs = this.activeAbsPath(view.file);
			if (abs && !existsSync(abs)) void leaf.detach();
		});
	}

	private wikiSetStatus(file: TFile): void {
		const ctx = this.wikiContext(file);
		if (!ctx) return;
		if (!ctx.wiki.statuses.length) {
			new Notice("paniolo: no status vocabulary configured for this wiki");
			return;
		}
		new ChoiceModal(this.app, `status for ${ctx.slug}`, ctx.wiki.statuses, (v) => {
			void this.confirmAppliedOp(
				ctx,
				["status", ctx.slug, v],
				`set ${ctx.slug} status → ${v}?`,
				"apply",
				`paniolo: status → ${v}`,
			);
		}).open();
	}

	private async wikiRefs(file: TFile): Promise<void> {
		const ctx = this.wikiContext(file);
		if (!ctx) return;
		const r = await this.runWikiOp(ctx, ["refs", ctx.slug, "--json"]);
		if (!r.ok) return;
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) {
			new Notice("paniolo: unsupported vault adapter");
			return;
		}
		try {
			showPageReferences({
				app: this.app,
				slug: ctx.slug,
				json: r.stdout,
				configRoot: ctx.configRoot,
				vaultRoot: adapter.getBasePath(),
			});
		} catch (error: unknown) {
			new Notice(
				`paniolo: could not show references — ${error instanceof Error ? error.message : String(error)}`,
				8000,
			);
		}
	}

	/** Open the current wiki page's declared source snapshots and citations. */
	private async wikiSources(file: TFile): Promise<void> {
		const ctx = this.wikiContext(file);
		if (!ctx) return;
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) {
			new Notice("paniolo: unsupported vault adapter");
			return;
		}
		try {
			await showPageSources({
				app: this.app,
				file,
				repoRoot: join(ctx.configRoot, ctx.wiki.repoPath),
				vaultRoot: adapter.getBasePath(),
			});
		} catch (error: unknown) {
			new Notice(
				`paniolo: could not show sources — ${error instanceof Error ? error.message : String(error)}`,
				8000,
			);
		}
	}

	private async wikiFix(file: TFile): Promise<void> {
		const ctx = this.wikiContext(file);
		if (!ctx) return;
		const r = await this.runWikiOp(ctx, ["--files", `${ctx.slug}.md`, "--fix"]);
		if (r.ok) new Notice(`paniolo: autofix applied to ${ctx.slug}`);
	}

	/** Run lint after the last save in a short burst of vault changes. */
	private scheduleLint(file: TFile): void {
		const pending = this.lintTimers.get(file.path);
		if (pending) clearTimeout(pending);
		const revision = this.nextLintRevision(file.path);
		const timer = setTimeout(() => {
			this.lintTimers.delete(file.path);
			void this.lintFile(file, true, revision);
		}, 800);
		this.lintTimers.set(file.path, timer);
	}

	/** Let newer saves or manual requests supersede an in-flight lint. */
	private nextLintRevision(path: string): number {
		const revision = (this.lintRevisions.get(path) ?? 0) + 1;
		this.lintRevisions.set(path, revision);
		return revision;
	}

	/** Lint the active page immediately when invoked from the command menu. */
	private async lintActiveFile(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (!file || !(file instanceof TFile)) {
			new Notice("paniolo: no active file");
			return;
		}
		if (file.extension !== "md") {
			new Notice("paniolo: not a markdown file");
			return;
		}
		const pending = this.lintTimers.get(file.path);
		if (pending) clearTimeout(pending);
		this.lintTimers.delete(file.path);
		await this.lintFile(file, false, this.nextLintRevision(file.path));
	}

	/** Run the scoped CLI checks and retain findings for the saved page. */
	private async lintFile(file: TFile, automatic: boolean, revision: number): Promise<void> {
		const absPath = this.activeAbsPath(file);
		if (!absPath) {
			if (!automatic) new Notice("paniolo: unsupported vault adapter");
			return;
		}
		const configRoot = findConfigRoot(dirname(absPath));
		if (!configRoot) {
			if (!automatic) new Notice(
				"paniolo: no paniolo.config.json above this file — the vault is not paniolo-configured",
			);
			return;
		}

		const binary = resolveBinary(this.settings.binaryPath);
		const configPath = join(configRoot, "paniolo.config.json");
		if (this.app.workspace.getActiveFile()?.path === file.path) this.setStatus("linting…");

		try {
			const findings: Finding[] = [];

			const scan = await runPaniolo(
				binary,
				["scan", "--format", "json", "--fail-on", "info", "--files", absPath],
				configRoot,
			);
			findings.push(...parseScanFindings(scan.stdout, absPath));
			if (this.lintRevisions.get(file.path) !== revision) return;

			// Scoped wiki validation (~1s) instead of whole-corpus (~6s):
			// only when the file lives under a configured wiki root.
			const wiki = wikiForAbsPath(configRoot, absPath, loadWikis(configRoot));
			if (wiki) {
				const rel = slugForAbsPath(configRoot, wiki, absPath) + ".md";
				const wres = await runPaniolo(
					binary,
					[
						"wiki",
						"--config",
						configPath,
						"--wiki",
						wiki.name,
						"--files",
						rel,
						"--format",
						"json",
						"--fail-on",
						"never",
					],
					configRoot,
				);
				findings.push(...parseWikiFindings(wres.stdout, absPath));
			}

			if (this.lintRevisions.get(file.path) !== revision) return;
			this.findingsByPath.set(file.path, findings);
			if (this.app.workspace.getActiveFile()?.path === file.path) this.applyStored();
			if (!automatic) new Notice(`paniolo: ${findings.length} finding(s) on ${file.basename}`);
		} catch (e) {
			if (this.lintRevisions.get(file.path) !== revision) return;
			if (this.app.workspace.getActiveFile()?.path === file.path) this.setStatus("error");
			if (automatic && this.app.workspace.getActiveFile()?.path !== file.path) return;
			if (e instanceof PanioloNotFoundError) {
				new Notice(
					"paniolo: binary not found — install @paniolo/cli or set the path in plugin settings",
				);
			} else if (e instanceof PanioloTimeoutError) {
				new Notice("paniolo: lint timed out");
			} else {
				new Notice(`paniolo: lint failed — ${(e as Error).message}`);
			}
		}
	}
}
