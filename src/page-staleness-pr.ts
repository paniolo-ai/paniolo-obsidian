import { createHash, randomBytes } from "crypto";
import { readFile } from "fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "path";
import type { WikiConfig } from "./new-page";
import { runPaniolo, type PanioloResult } from "./paniolo";

const COMMAND_TIMEOUT_MS = 120_000;
const GATE_TIMEOUT_MS = 900_000;
const SAVE_WAIT_MS = 10_000;

export type PagePrRoute = {
	repoRoot: string;
	pagePath: string;
	absPath: string;
	runId: string;
	branch: string;
	baseBranch: string;
	wiki: WikiConfig;
};

type PrRecord = { url: string; state: string; headRefName: string; isCrossRepository: boolean };

type CommandRunner = typeof runPaniolo;

function pageHash(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

async function command(run: CommandRunner, binary: string, args: string[], cwd: string): Promise<PanioloResult> {
	return run(binary, args, cwd, COMMAND_TIMEOUT_MS);
}

async function checked(run: CommandRunner, binary: string, args: string[], cwd: string, timeoutMs = COMMAND_TIMEOUT_MS): Promise<string> {
	const result = await run(binary, args, cwd, timeoutMs);
	if (result.code !== 0) throw new Error(result.stderr.trim() || `${binary} ${args[0]} failed`);
	return result.stdout.trim();
}

async function branchPr(run: CommandRunner, route: PagePrRoute): Promise<PrRecord | null> {
	const stdout = await checked(run, "gh", ["pr", "list", "--head", route.branch, "--state", "all", "--json", "url,state,headRefName,isCrossRepository"], route.repoRoot);
	const value: unknown = JSON.parse(stdout);
	if (!Array.isArray(value) || value.some((item: unknown) => typeof item !== "object" || item === null
		|| !("url" in item) || typeof item.url !== "string" || !("state" in item) || typeof item.state !== "string"
		|| !("headRefName" in item) || item.headRefName !== route.branch
		|| !("isCrossRepository" in item) || typeof item.isCrossRepository !== "boolean")) throw new Error("invalid branch PR response");
	if (value.length > 1) throw new Error("multiple PRs use this branch; review them before publishing");
	const pr = (value[0] as PrRecord | undefined) ?? null;
	if (pr?.isCrossRepository) throw new Error("branch name belongs to a fork PR; review it before publishing");
	return pr;
}

/** Confirm a clean, tracked page before creating or reusing a topic branch. */
export async function preparePagePr(
	configRoot: string,
	target: string,
	absPath: string,
	snapshotHash: string,
	runId: string,
	wikis: WikiConfig[],
	run: CommandRunner = runPaniolo,
): Promise<PagePrRoute> {
	const separator = target.indexOf(":");
	const wiki = wikis.find((item) => item.name === target.slice(0, separator));
	if (separator < 1 || !wiki) throw new Error("configured wiki repository is unavailable");
	const repoRoot = resolve(configRoot, wiki.repoPath);
	const pagePath = relative(repoRoot, absPath);
	if (!pagePath || pagePath === ".." || pagePath.startsWith(`..${sep}`) || isAbsolute(pagePath)
		|| pagePath.replace(/\\/g, "/") !== target.slice(separator + 1)) {
		throw new Error("page is not in its configured Git checkout");
	}
	const git = (...args: string[]): Promise<string> => checked(run, "git", ["-C", repoRoot, ...args], repoRoot);
	const actualRoot = await git("rev-parse", "--show-toplevel");
	if (resolve(actualRoot).toLowerCase() !== repoRoot.toLowerCase()) throw new Error("page is not in its configured Git checkout");
	await git("ls-files", "--error-unmatch", "--", pagePath);
	if (await git("status", "--porcelain=v1", "--", pagePath)) throw new Error("save or commit existing page changes before routing a patch");
	if (pageHash(await readFile(absPath, "utf8")) !== snapshotHash) throw new Error("saved page differs from the reviewed editor snapshot");
	let branch = await git("symbolic-ref", "--quiet", "--short", "HEAD");
	const originDefault = await git("symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD");
	if (!originDefault.startsWith("origin/")) throw new Error("origin default branch is unavailable");
	const baseBranch = originDefault.slice("origin/".length);
	if (!branch) throw new Error("detached Git checkout cannot receive a page patch");
	if (branch === baseBranch) {
		const slug = runId.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 40);
		branch = `codex/stale-page-${slug}-${randomBytes(3).toString("hex")}`;
		await git("switch", "-c", branch);
	}
	return { repoRoot, pagePath, absPath, runId, branch, baseBranch, wiki };
}

/** Publish only the accepted page after its Obsidian save and focused gates pass. */
export async function publishPagePr(
	route: PagePrRoute,
	patchedHash: string,
	allegationId: string,
	configRoot: string,
	binary: string,
	currentEditorHash: () => string,
	run: CommandRunner = runPaniolo,
): Promise<string> {
	const git = (...args: string[]): Promise<string> => checked(run, "git", ["-C", route.repoRoot, ...args], route.repoRoot);
	const deadline = Date.now() + SAVE_WAIT_MS;
	for (;;) {
		if (currentEditorHash() !== patchedHash) throw new Error("editor changed before the page was saved; PR publication stopped");
		if (pageHash(await readFile(route.absPath, "utf8")) === patchedHash) break;
		if (Date.now() >= deadline) throw new Error("page edit was not saved within ten seconds; PR publication stopped");
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
	}
	if (await git("symbolic-ref", "--quiet", "--short", "HEAD") !== route.branch) throw new Error("Git branch changed before PR publication");
	const priorPr = await branchPr(run, route);
	if (priorPr && priorPr.state !== "OPEN") throw new Error("existing branch PR is not open; review it before publishing");
	const scan = await command(run, binary, ["scan", "--format", "json", "--fail-on", "info", "--files", route.absPath], configRoot);
	if (scan.code !== 0) throw new Error("page scan failed; PR publication stopped");
	const wikiRoot = resolve(configRoot, route.wiki.wikiRoot);
	const wikiFile = relative(wikiRoot, route.absPath).replace(/\\/g, "/");
	if (!wikiFile || wikiFile === ".." || wikiFile.startsWith("../")) throw new Error("page is outside its configured wiki root");
	const wikiCheck = await command(run, binary, ["wiki", "--config", join(configRoot, "paniolo.config.json"), "--wiki", route.wiki.name,
		"--files", wikiFile, "--format", "json", "--fail-on", "error"], configRoot);
	if (wikiCheck.code !== 0) throw new Error("page wiki check failed; PR publication stopped");
	if (currentEditorHash() !== patchedHash || pageHash(await readFile(route.absPath, "utf8")) !== patchedHash) {
		throw new Error("page changed during validation; PR publication stopped");
	}
	if (await git("symbolic-ref", "--quiet", "--short", "HEAD") !== route.branch) throw new Error("Git branch changed during validation");
	const eventId = createHash("sha256").update(`${route.runId}\0${allegationId}\0${patchedHash}`, "utf8").digest("hex");
	const capture = await command(run, binary, ["stale", "--root", configRoot, "record-editor-edit",
		"--repo", route.wiki.name, "--path", route.pagePath.replace(/\\/g, "/"), "--branch", route.branch,
		"--session", route.runId, "--event-id", eventId], configRoot);
	if (capture.code !== 0) throw new Error(capture.stderr.trim() || "editor edit capture failed; PR publication stopped");
	const recorded: unknown = JSON.parse(capture.stdout);
	if (typeof recorded !== "object" || recorded === null || !("eventId" in recorded) || recorded.eventId !== eventId
		|| !("repo" in recorded) || recorded.repo !== route.wiki.name || !("path" in recorded)
		|| recorded.path !== route.pagePath.replace(/\\/g, "/") || !("branch" in recorded) || recorded.branch !== route.branch) {
		throw new Error("editor edit capture did not match the accepted page; PR publication stopped");
	}
	await checked(run, "git", ["-C", route.repoRoot, "commit", "--only", "-m", `fix(wiki): address ${allegationId}`, "--", route.pagePath], route.repoRoot, GATE_TIMEOUT_MS);
	const committed = await command(run, "git", ["-C", route.repoRoot, "show", `HEAD:${route.pagePath.replace(/\\/g, "/")}`], route.repoRoot);
	if (committed.code !== 0 || pageHash(committed.stdout) !== patchedHash || pageHash(await readFile(route.absPath, "utf8")) !== patchedHash) {
		throw new Error("committed page differs from the accepted patch; PR publication stopped");
	}
	await checked(run, "git", ["-C", route.repoRoot, "push", "-u", "origin", route.branch], route.repoRoot, GATE_TIMEOUT_MS);
	if (priorPr) return priorPr.url;
	return checked(run, "gh", ["pr", "create", "--base", route.baseBranch, "--head", route.branch,
		"--title", `Fix staleness in ${route.pagePath}`, "--body", `Reviewed page patch for ${allegationId} from page report ${route.runId}.\n\nLedger entries remain open until merge and independent verification.`], route.repoRoot);
}
