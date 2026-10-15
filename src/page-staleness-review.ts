import { createHash } from "crypto";
import { runPaniolo, type PanioloResult } from "./paniolo";

const TIMEOUT_MS = 20_000;
const SHA = /^[0-9a-f]{40,64}$/i;
const REVIEW_ID = /^PR-[0-9a-f]{64}$/i;

type CommandRunner = typeof runPaniolo;
type ReviewEntry = { id: string; revision: number; state: string };
type ReviewFile = { path: string; entries: ReviewEntry[] };

export type PagePrReviewPlan = {
	repo: string;
	repoRoot: string;
	branch: string;
	prNumber: number;
	base: string;
	head: string;
	files: ReviewFile[];
	invocationCeiling: number;
	maximumRoleInvocations: number;
	key: string;
};

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function checked(run: CommandRunner, binary: string, args: string[], cwd: string): Promise<string> {
	const result: PanioloResult = await run(binary, args, cwd, TIMEOUT_MS);
	if (result.code !== 0) throw new Error(result.stderr.trim() || `${binary} ${args[0]} failed`);
	return result.stdout.trim();
}

/** Read the current PR and its writer-owned, exact-head review scope without invoking a model. */
export async function inspectPagePrReview(
	configRoot: string, repoRoot: string, repo: string, binary: string, run: CommandRunner = runPaniolo,
): Promise<PagePrReviewPlan> {
	const git = (...args: string[]): Promise<string> => checked(run, "git", ["-C", repoRoot, ...args], repoRoot);
	const branch = await git("symbolic-ref", "--quiet", "--short", "HEAD");
	const head = await git("rev-parse", "HEAD");
	const rawPr = await checked(run, "gh", ["pr", "view", "--json", "number,baseRefOid,headRefOid,headRefName,isCrossRepository,state,url"], repoRoot);
	const pr: unknown = JSON.parse(rawPr);
	if (!record(pr) || pr.state !== "OPEN" || pr.isCrossRepository !== false || !Number.isSafeInteger(pr.number) || (pr.number as number) < 1
		|| typeof pr.baseRefOid !== "string" || !SHA.test(pr.baseRefOid)
		|| typeof pr.headRefOid !== "string" || !SHA.test(pr.headRefOid)
		|| pr.headRefName !== branch || pr.headRefOid !== head) {
		throw new Error("current branch has no open PR at its checked-out head");
	}
	const base = pr.baseRefOid;
	const prNumber = pr.number as number;
	const rawPlan = await checked(run, binary, ["stale", "--root", configRoot, "review-plan", "--repo", repo,
		"--base", base, "--head", head, "--pr", String(prNumber)], configRoot);
	const plan: unknown = JSON.parse(rawPlan);
	if (!record(plan) || plan.status !== "ready" || plan.repo !== repo || plan.branch !== branch
		|| plan.base !== base || plan.head !== head || plan.prNumber !== prNumber || !Array.isArray(plan.files)
		|| !Number.isSafeInteger(plan.invocationCeiling) || (plan.invocationCeiling as number) < 1
		|| !Number.isSafeInteger(plan.maximumRoleInvocations) || (plan.maximumRoleInvocations as number) < 1) {
		throw new Error("exact-head review plan is unavailable or changed");
	}
	const files: ReviewFile[] = [];
	for (const item of plan.files as unknown[]) {
		if (!record(item) || typeof item.path !== "string" || !Array.isArray(item.entries)) throw new Error("invalid review file scope");
		const entries: ReviewEntry[] = [];
		for (const entry of item.entries as unknown[]) {
			if (!record(entry) || typeof entry.id !== "string" || !entry.id || typeof entry.state !== "string"
				|| !Number.isSafeInteger(entry.revision)) throw new Error("invalid review entry scope");
			entries.push({ id: entry.id, revision: entry.revision as number, state: entry.state });
		}
		files.push({ path: item.path, entries });
	}
	const invocationCeiling = plan.invocationCeiling as number;
	const maximumRoleInvocations = plan.maximumRoleInvocations as number;
	if (maximumRoleInvocations > invocationCeiling) throw new Error("review exceeds the configured invocation ceiling");
	const scopeHash = createHash("sha256").update(JSON.stringify({ prNumber, base, head, files }), "utf8").digest("hex");
	return { repo, repoRoot, branch, prNumber, base, head, files, invocationCeiling, maximumRoleInvocations,
		key: `${repo}:${branch}@${head}#${scopeHash}` };
}

/** Recheck the exact head and scope before explicitly submitting a detached paid review. */
export async function submitPagePrReview(
	plan: PagePrReviewPlan, configRoot: string, binary: string, run: CommandRunner = runPaniolo,
): Promise<string> {
	const current = await inspectPagePrReview(configRoot, plan.repoRoot, plan.repo, binary, run);
	if (current.prNumber !== plan.prNumber || current.base !== plan.base || current.head !== plan.head
		|| JSON.stringify(current.files) !== JSON.stringify(plan.files)
		|| current.invocationCeiling !== plan.invocationCeiling || current.maximumRoleInvocations !== plan.maximumRoleInvocations) {
		throw new Error("PR head or open-entry scope changed; inspect the review plan again");
	}
	const raw = await checked(run, binary, ["stale", "--root", configRoot, "review-submit", "--repo", plan.repo,
		"--base", plan.base, "--head", plan.head, "--pr", String(plan.prNumber)], configRoot);
	const response: unknown = JSON.parse(raw);
	const subjectCount = plan.files.reduce((count, file) => count + file.entries.length, 0);
	if (!record(response) || typeof response.reviewId !== "string" || !REVIEW_ID.test(response.reviewId)
		|| response.head !== plan.head || response.subjects !== subjectCount) throw new Error("review submission did not match the inspected PR");
	return response.reviewId;
}
