import {
	FileSystemAdapter,
	MarkdownView,
	Notice,
	Plugin,
	TFile,
} from "obsidian";
import { lintGutter, setDiagnostics } from "@codemirror/lint";
import { EditorView } from "@codemirror/view";
import { dirname, join } from "path";
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
import { DEFAULT_SETTINGS, PanioloSettingTab, PanioloSettings } from "./settings";

export default class PanioloPlugin extends Plugin {
	settings: PanioloSettings = DEFAULT_SETTINGS;
	private statusItem: HTMLElement | null = null;
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

		// Stored findings follow the file when the leaf switches notes.
		this.registerEvent(
			this.app.workspace.on("file-open", () => this.applyStored()),
		);
	}

	onunload(): void {
		this.findingsByPath.clear();
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
