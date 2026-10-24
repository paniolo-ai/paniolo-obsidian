import { App, Modal, Notice, Setting, TextComponent } from "obsidian";
import { existsSync, readFileSync } from "fs";
import { dirname, isAbsolute, join, relative } from "path";

export interface WikiConfig {
	/** Repo name — passed to `paniolo wiki --wiki`. */
	name: string;
	/** Repo root relative to the config root. */
	repoPath: string;
	/** Wiki root relative to the config root (`<repoPath>/wiki`). */
	wikiRoot: string;
	kinds: { kind: string; prefix: string }[];
	domains: string[];
	/** Valid `status:` values — kind vocabularies + fallbackStatuses. */
	statuses: string[];
}

interface RawPagePrefix {
	kind?: string;
	prefix?: string;
	statuses?: string[];
}

type RawWikiFields = {
	root?: string;
	pagePrefixes?: RawPagePrefix[];
	domains?: string[];
	fallbackStatuses?: string[];
};

/** Parse `paniolo.config.json` into the list of configured wikis. */
export function loadWikis(configRoot: string): WikiConfig[] {
	try {
		const raw = JSON.parse(
			readFileSync(join(configRoot, "paniolo.config.json"), "utf-8"),
		) as {
			name?: string;
			wiki?: RawWikiFields & { wikis?: (RawWikiFields & { name?: string })[] };
			repos?: Record<
				string,
				{
					path?: string;
					wiki?: RawWikiFields;
				}
			>;
		};
		const out: WikiConfig[] = [];
		const addWiki = (name: string, repoPath: string, wikiRoot: string, wiki: RawWikiFields): void => {
			const prefixes = wiki.pagePrefixes ?? [];
			const statuses = new Set<string>(wiki.fallbackStatuses ?? []);
			for (const prefix of prefixes) for (const status of prefix.statuses ?? []) statuses.add(status);
			out.push({
				name,
				repoPath,
				wikiRoot,
				kinds: prefixes
					.filter((prefix): prefix is { kind: string; prefix: string } => !!prefix.kind && !!prefix.prefix)
					.map((prefix) => ({ kind: prefix.kind, prefix: prefix.prefix })),
				domains: wiki.domains ?? listLogDomains(configRoot, wikiRoot),
				statuses: [...statuses].sort(),
			});
		};
		if (raw.name && raw.wiki?.root) {
			addWiki(raw.name, ".", raw.wiki.root, raw.wiki);
		}
		for (const wiki of raw.wiki?.wikis ?? []) {
			if (!wiki.name || !wiki.root) continue;
			addWiki(wiki.name, dirname(wiki.root), wiki.root, wiki);
		}
		for (const [name, repo] of Object.entries(raw.repos ?? {})) {
			if (!repo.wiki || !repo.path) continue;
			addWiki(name, repo.path, join(repo.path, repo.wiki.root ?? "wiki").replace(/\\/g, "/"), repo.wiki);
		}
		return out;
	} catch {
		return [];
	}
}

/** Distinct domains from `## [date] verb | domain | title` log headers. */
function listLogDomains(configRoot: string, wikiRoot: string): string[] {
	const logPath = join(configRoot, wikiRoot, "log.md");
	if (!existsSync(logPath)) return [];
	try {
		const out = new Set<string>();
		for (const line of readFileSync(logPath, "utf-8").split("\n")) {
			const m = /^## \[[^\]]+\] [^|]+\| ([^|]+) \|/.exec(line);
			// Headers may carry compound domains ("business + harness-eng").
			if (m) for (const d of m[1].split("+")) out.add(d.trim());
		}
		return [...out].sort();
	} catch {
		return [];
	}
}

/** The wiki owning an absolute path, or null when outside every root. */
export function wikiForAbsPath(
	configRoot: string,
	absPath: string,
	wikis: WikiConfig[],
): WikiConfig | null {
	for (const w of wikis) {
		const root = join(configRoot, w.wikiRoot);
		const rel = relative(root, absPath);
		if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return w;
	}
	return null;
}

/** Slug form of a file inside a wiki root: path relative to the root, no `.md`. */
export function slugForAbsPath(
	configRoot: string,
	wiki: WikiConfig,
	absPath: string,
): string {
	return relative(join(configRoot, wiki.wikiRoot), absPath)
		.replace(/\\/g, "/")
		.replace(/\.md$/i, "");
}

/** Kebab-case a loose slug — `wiki new` accepts spaces that then collide with prose. */
export function slugify(slug: string): string {
	return slug
		.toLowerCase()
		.replace(/[\s_]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}

export interface NewPageResult {
	slug: string;
	kind: string;
	title: string;
	tags: string;
	source: string;
	domain: string;
	wiki: WikiConfig;
}

/**
 * `paniolo wiki new` stamped-creation dialog. Collects the args and
 * hands them back; the caller shells out and opens the stamped file.
 */
export class NewPageModal extends Modal {
	private slug = "";
	private title = "";
	private tags = "";
	private source = "";
	private domain = "";
	private kind = "";
	private wikiIdx = 0;
	/** Once the user edits tags, stop auto-filling from domain+kind. */
	private tagsTouched = false;
	private tagsInput: TextComponent | null = null;
	/** setValue fires onChange — mark programmatic fills. */
	private filling = false;

	constructor(
		app: App,
		private wikis: WikiConfig[],
		private onSubmit: (r: NewPageResult) => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: "new page" });

		new Setting(contentEl).setName("wiki").addDropdown((dd) => {
			for (const w of this.wikis) dd.addOption(w.name, w.name);
			dd.setValue(this.wikis[0]?.name ?? "");
			dd.onChange((v) => {
				this.wikiIdx = this.wikis.findIndex((w) => w.name === v);
				this.rebuildWikiFields();
			});
		});

		new Setting(contentEl).setName("slug").addText((t) => {
			t.setPlaceholder("plan-my-thing").onChange((v) => (this.slug = v.trim()));
		});

		const kindSetting = new Setting(contentEl).setName("kind");
		this.kindSetting = kindSetting;
		const domainSetting = new Setting(contentEl).setName("domain");
		this.domainSetting = domainSetting;
		this.rebuildWikiFields();

		new Setting(contentEl).setName("title").addText((t) => {
			t.setPlaceholder("defaults to title-cased slug").onChange(
				(v) => (this.title = v.trim()),
			);
		});

		new Setting(contentEl)
			.setName("tags")
			.setDesc("comma-separated — prefilled as domain,kind; edit freely")
			.addText((t) => {
				this.tagsInput = t;
				t.onChange((v) => {
					this.tags = v.trim();
					if (!this.filling) this.tagsTouched = true;
				});
				// rebuildWikiFields ran before this input existed — fill now.
				this.refreshTagsDefault();
			});

		new Setting(contentEl)
			.setName("source")
			.setDesc("optional — raw/ snapshot path or URL; supplies the domain when given")
			.addText((t) => t.onChange((v) => (this.source = v.trim())));

		new Setting(contentEl).addButton((b) =>
			b.setButtonText("create").setCta().onClick(() => this.submit()),
		);
	}

	private kindSetting: Setting | null = null;
	private domainSetting: Setting | null = null;

	private rebuildWikiFields(): void {
		const wiki = this.wikis[this.wikiIdx];
		if (this.kindSetting) {
			this.kindSetting.controlEl.empty();
			this.kindSetting.addDropdown((dd) => {
				dd.addOption("", "(infer from slug)");
				for (const k of wiki?.kinds ?? []) dd.addOption(k.kind, k.kind);
				dd.onChange((v) => {
					this.kind = v;
					this.refreshTagsDefault();
				});
			});
			this.kind = "";
		}
		if (this.domainSetting) {
			this.domainSetting.controlEl.empty();
			this.domainSetting
				.setDesc("required unless source names a raw/<domain>/ subtree")
				.addDropdown((dd) => {
					for (const d of wiki?.domains ?? []) dd.addOption(d, d);
					if (wiki?.domains.length) this.domain = wiki.domains[0];
					dd.onChange((v) => {
						this.domain = v;
						this.refreshTagsDefault();
					});
				});
			this.domain = wiki?.domains[0] ?? "";
		}
		this.refreshTagsDefault();
	}

	/**
	 * The CLI requires a non-empty tag list and the convention is
	 * domain+kind — prefill that until the user edits the field.
	 */
	private refreshTagsDefault(): void {
		if (this.tagsTouched || !this.tagsInput) return;
		const parts = [this.domain, this.kind].filter(Boolean);
		this.filling = true;
		this.tagsInput.setValue(parts.join(","));
		this.filling = false;
		this.tags = parts.join(",");
	}

	private submit(): void {
		// `wiki new` accepts loose slugs (spaces etc.) without complaint —
		// normalize to kebab-case here so the filename stays canonical.
		this.slug = slugify(this.slug);
		if (!this.slug) {
			new Notice("paniolo: slug is required");
			return;
		}
		if (!this.tags) {
			new Notice("paniolo: tags are required (wiki pages must be tagged)");
			return;
		}
		if (!this.source && !this.domain) {
			new Notice("paniolo: domain is required when no source is given");
			return;
		}
		const wiki = this.wikis[this.wikiIdx];
		if (!wiki) {
			new Notice("paniolo: no wiki selected");
			return;
		}
		this.close();
		this.onSubmit({
			slug: this.slug,
			kind: this.kind,
			title: this.title,
			tags: this.tags,
			source: this.source,
			domain: this.domain,
			wiki,
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
