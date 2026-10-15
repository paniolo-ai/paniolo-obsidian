import { runPaniolo, type PanioloResult } from "./paniolo";

const READ_TIMEOUT_MS = 10_000;
const REVIEW_ID = /^PR-[0-9a-f]{64}$/i;
const SHA = /^[0-9a-f]{40,64}$/i;

type CommandRunner = typeof runPaniolo;

export type PageReviewTracking = {
	key: string;
	id: string;
	repo: string;
	prNumber: number;
	base: string;
	head: string;
};

export type PageCompletion = {
	state: "current-writer-zero" | "awaiting-merge" | "retained" | "pending-verification" | "snapshot" | "untracked";
	text: string;
};

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reject malformed persisted state rather than accidentally following another PR. */
export function parsePageReviewTracking(value: unknown): PageReviewTracking | null {
	if (!record(value) || typeof value.key !== "string" || !value.key || typeof value.id !== "string" || !REVIEW_ID.test(value.id)
		|| typeof value.repo !== "string" || !value.repo || !Number.isSafeInteger(value.prNumber) || (value.prNumber as number) < 1
		|| typeof value.base !== "string" || !SHA.test(value.base) || typeof value.head !== "string" || !SHA.test(value.head)) return null;
	return { key: value.key, id: value.id, repo: value.repo, prNumber: value.prNumber as number,
		base: value.base, head: value.head };
}

async function checked(run: CommandRunner, binary: string, args: string[], cwd: string): Promise<unknown> {
	const result: PanioloResult = await run(binary, args, cwd, READ_TIMEOUT_MS);
	if (result.code !== 0) throw new Error(result.stderr.trim() || `${binary} status unavailable`);
	return JSON.parse(result.stdout) as unknown;
}

/** Observe the durable review and current exact-head gate without starting inference or reconciling the ledger. */
export async function readPageCompletion(
	tracking: PageReviewTracking | null,
	openCount: number,
	source: "active-writer" | "snapshot",
	configRoot: string,
	repoRoot: string,
	binary: string,
	run: CommandRunner = runPaniolo,
): Promise<PageCompletion> {
	if (source === "snapshot") return { state: "snapshot", text: `${openCount} open in published snapshot; current writer unavailable` };
	if (openCount === 0) return { state: "current-writer-zero", text: "Current writer: 0 open entries" };
	if (!tracking) return { state: "untracked", text: `${openCount} open entries; no tracked PR review for this page` };
	const review = await checked(run, binary, ["stale", "--root", configRoot, "review-show", tracking.id], configRoot);
	if (!record(review) || !record(review.request) || review.request.id !== tracking.id
		|| review.request.repo !== tracking.repo || review.request.prNumber !== tracking.prNumber
		|| review.request.head !== tracking.head || review.request.base !== tracking.base
		|| (review.state !== "queued" && review.state !== "running" && review.state !== "complete" && review.state !== "failed")) {
		throw new Error("saved review does not match this page PR");
	}
	if (review.state !== "complete") return { state: "pending-verification", text: `Review ${review.state}; ${openCount} entries remain open` };
	const provider = await checked(run, "gh", ["pr", "view", String(tracking.prNumber),
		"--json", "number,state,headRefOid,mergeCommit"], repoRoot);
	if (!record(provider) || provider.number !== tracking.prNumber
		|| (provider.state !== "OPEN" && provider.state !== "MERGED" && provider.state !== "CLOSED")
		|| provider.headRefOid !== tracking.head) throw new Error("PR identity changed since review");
	if (provider.state === "MERGED") return { state: "pending-verification",
		text: `PR merged; ${openCount} entries await current-writer closure` };
	if (provider.state !== "OPEN") return { state: "retained", text: `PR ${provider.state.toLowerCase()}; ${openCount} entries retained` };
	const result: PanioloResult = await run(binary, ["stale", "--root", configRoot, "pr-check", "--repo", tracking.repo,
		"--base", tracking.base, "--head", tracking.head, "--pr", String(tracking.prNumber)], configRoot, READ_TIMEOUT_MS);
	const gate: unknown = JSON.parse(result.stdout);
	if (!record(gate) || gate.head !== tracking.head || !Array.isArray(gate.reasons)
		|| (gate.state !== "passing" && gate.state !== "pending" && gate.state !== "failing")) {
		throw new Error("exact-head PR check unavailable");
	}
	if (gate.reviewId !== tracking.id) return { state: "pending-verification",
		text: `Review scope changed; ${openCount} entries remain open` };
	if (gate.state === "passing" && gate.reviewId === tracking.id && result.code === 0) {
		return { state: "awaiting-merge", text: `Review passed; PR awaits merge (${openCount} entries open)` };
	}
	if (gate.state === "failing") return { state: "retained", text: `Review retained ${openCount} open entries` };
	return { state: "pending-verification", text: `Review needs verification; ${openCount} entries remain open` };
}
