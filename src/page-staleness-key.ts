import { posix, win32 } from "path";
import type { WikiConfig } from "./new-page";

export type PageKeyResult = { target: string } | { reason: string };

/** Resolve only a configured wiki page, rejecting overlapping or foreign roots. */
export function pageKeyForPath(configRoot: string, absPath: string, wikis: WikiConfig[]): PageKeyResult {
	const windows = /^[a-zA-Z]:[\\/]/.test(configRoot) || configRoot.startsWith("\\\\");
	const paths = windows ? win32 : posix;
	if (!paths.isAbsolute(configRoot) || !paths.isAbsolute(absPath)) return { reason: "page path is not absolute" };
	const matches: string[] = [];
	for (const wiki of wikis) {
		const repoRoot = paths.resolve(configRoot, wiki.repoPath);
		const wikiRoot = paths.resolve(configRoot, wiki.wikiRoot);
		const withinWiki = paths.relative(wikiRoot, absPath);
		if (!withinWiki || withinWiki === ".." || withinWiki.startsWith(`..${paths.sep}`) || paths.isAbsolute(withinWiki)) continue;
		if (!withinWiki.toLowerCase().endsWith(".md")) continue;
		const withinRepo = paths.relative(repoRoot, absPath);
		if (!withinRepo || withinRepo === ".." || withinRepo.startsWith(`..${paths.sep}`) || paths.isAbsolute(withinRepo)) continue;
		matches.push(`${wiki.name}:${withinRepo.replace(/\\/g, "/")}`);
	}
	if (matches.length === 1) return { target: matches[0] };
	return { reason: matches.length > 1 ? "page belongs to multiple configured wikis" : "page is outside configured wikis" };
}
