import { App, Modal, Setting, TFile } from "obsidian";
import { readFileSync } from "fs";
import { isAbsolute, join, relative, resolve, sep } from "path";

type PageReference = {
	repo: string;
	path: string;
	line: number;
	kind: string;
	status: string;
	role: string;
	text: string;
};

type ReferencesRequest = {
	app: App;
	slug: string;
	json: string;
	configRoot: string;
	vaultRoot: string;
};

/** Read the classified references without trusting arbitrary JSON fields. */
function parseReferences(json: string): PageReference[] {
	const report: unknown = JSON.parse(json);
	if (typeof report !== "object" || report === null || !("references" in report)) {
		throw new Error("invalid references response");
	}
	if (!Array.isArray(report.references)) {
		throw new Error("invalid references list");
	}
	const references: PageReference[] = [];
	for (const item of report.references as unknown[]) {
		if (typeof item !== "object" || item === null) continue;
		if (!("repo" in item) || typeof item.repo !== "string") continue;
		if (!("path" in item) || typeof item.path !== "string") continue;
		if (!("line" in item) || typeof item.line !== "number") continue;
		if (!("kind" in item) || typeof item.kind !== "string") continue;
		if (!("status" in item) || typeof item.status !== "string") continue;
		if (!("role" in item) || typeof item.role !== "string") continue;
		if (!("text" in item) || typeof item.text !== "string") continue;
		references.push({
			repo: item.repo,
			path: item.path,
			line: item.line,
			kind: item.kind,
			status: item.status,
			role: item.role,
			text: item.text,
		});
	}
	return references;
}

/** Resolve a CLI repository/path pair to a note present in this vault. */
function vaultFile(
	app: App,
	reference: PageReference,
	repoPaths: Record<string, string>,
	configRoot: string,
	vaultRoot: string,
): TFile | null {
	const repoPath = repoPaths[reference.repo];
	if (!repoPath) return null;
	const repoRoot = resolve(configRoot, repoPath);
	const absolutePath = resolve(repoRoot, reference.path);
	const withinRepo = relative(repoRoot, absolutePath);
	if (!withinRepo || withinRepo === ".." || withinRepo.startsWith(`..${sep}`)) {
		return null;
	}
	const vaultPath = relative(vaultRoot, absolutePath).replace(/\\/g, "/");
	if (!vaultPath || vaultPath === ".." || vaultPath.startsWith("../") || isAbsolute(vaultPath)) {
		return null;
	}
	const file = app.vault.getAbstractFileByPath(vaultPath);
	return file instanceof TFile ? file : null;
}

/** Map configured repository keys to their checkout paths. */
function configuredRepoPaths(configRoot: string): Record<string, string> {
	const config: unknown = JSON.parse(readFileSync(join(configRoot, "paniolo.config.json"), "utf-8"));
	if (typeof config !== "object" || config === null || !("repos" in config)) {
		throw new Error("paniolo.config.json has no repositories");
	}
	if (typeof config.repos !== "object" || config.repos === null) {
		throw new Error("paniolo.config.json has no repositories");
	}
	const paths: Record<string, string> = {};
	for (const [name, entry] of Object.entries(config.repos)) {
		if (typeof entry !== "object" || entry === null || !("path" in entry)) continue;
		if (typeof entry.path === "string") paths[name] = entry.path;
	}
	return paths;
}

/** Show one clickable row per reference while retaining its CLI classification. */
class PageReferencesModal extends Modal {
	constructor(
		app: App,
		private slug: string,
		private references: PageReference[],
		private repoPaths: Record<string, string>,
		private configRoot: string,
		private vaultRoot: string,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: `references to ${this.slug}` });
		if (!this.references.length) {
			contentEl.createEl("p", { text: "No references found." });
			return;
		}
		const list = contentEl.createDiv({ cls: "paniolo-reference-list" });
		for (const reference of this.references) {
			const target = vaultFile(
				this.app,
				reference,
				this.repoPaths,
				this.configRoot,
				this.vaultRoot,
			);
			const label = `${reference.repo}/${reference.path}:${reference.line}`;
			const setting = new Setting(list).setName(label).setDesc(
				`${reference.status} · ${reference.kind} · ${reference.role} — ${reference.text.slice(0, 220)}`,
			);
			if (target) {
				setting.nameEl.empty();
				const link = setting.nameEl.createEl("a", { text: label, href: "#" });
				link.addEventListener("click", (event) => {
					event.preventDefault();
					this.close();
					void this.app.workspace.getLeaf(false).openFile(target);
				});
			} else {
				setting.descEl.appendText(" · not available in this vault");
			}
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Open the navigable references report returned by `paniolo wiki refs --json`. */
export function showPageReferences({
	app,
	slug,
	json,
	configRoot,
	vaultRoot,
}: ReferencesRequest): void {
	const references = parseReferences(json);
	const repoPaths = configuredRepoPaths(configRoot);
	new PageReferencesModal(app, slug, references, repoPaths, configRoot, vaultRoot).open();
}
