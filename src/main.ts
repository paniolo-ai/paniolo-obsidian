import {
	FileSystemAdapter,
	MarkdownView,
	Notice,
	Plugin,
	TFile,
} from "obsidian";
import { lintGutter, setDiagnostics } from "@codemirror/lint";
import { EditorView } from "@codemirror/view";
import { dirname, join, relative } from "path";
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
import { NewPageModal, NewPageResult, loadWikis } from "./new-page";
import { DEFAULT_SETTINGS, PanioloSettingTab, PanioloSettings } from "./settings";

export default class PanioloPlugin extends Plugin {
	settings: PanioloSettings = DEFAULT_SETTINGS;
	private statusItem: HTMLElement | null = null;
	private actionBar = new ActionBar(this);
	private findingsByPath = new Map<string, Finding[]>();

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
			name: "New wiki page",
			callback: () => this.openNewPageModal(),
		});

		// Stored findings follow the file when the leaf switches notes.
		this.registerEvent(
			this.app.workspace.on("file-open", () => this.applyStored()),
		);
		this.actionBar.register();
	}

	onunload(): void {
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

			const kind = r.wiki.kinds.find((k) => k.kind === r.kind);
			const filename =
				kind && !r.slug.startsWith(kind.prefix)
					? kind.prefix + r.slug
					: r.slug;
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
		const absPath = this.activeAbsPath(file);
		if (!absPath) {
			new Notice("paniolo: unsupported vault adapter");
			return;
		}
		const configRoot = findConfigRoot(dirname(absPath));
		if (!configRoot) {
			new Notice(
				"paniolo: no paniolo.config.json above this file — the vault is not paniolo-configured",
			);
			return;
		}

		const binary = resolveBinary(this.settings.binaryPath);
		const configPath = join(configRoot, "paniolo.config.json");
		this.setStatus("linting…");

		try {
			const findings: Finding[] = [];

			const scan = await runPaniolo(
				binary,
				["scan", "--format", "json", "--fail-on", "info", "--files", absPath],
				configRoot,
			);
			findings.push(...parseScanFindings(scan.stdout, absPath));

			// Wiki validation is whole-wiki; only worth running for wiki pages.
			if (file.path.split("/").includes("wiki")) {
				const wiki = await runPaniolo(
					binary,
					[
						"wiki",
						"--config",
						configPath,
						"--format",
						"json",
						"--fail-on",
						"never",
					],
					configRoot,
				);
				findings.push(...parseWikiFindings(wiki.stdout, absPath));
			}

			this.findingsByPath.set(file.path, findings);
			this.applyStored();
			new Notice(`paniolo: ${findings.length} finding(s) on ${file.basename}`);
		} catch (e) {
			this.setStatus("error");
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
