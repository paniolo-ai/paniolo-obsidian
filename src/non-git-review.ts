import { createHash } from "crypto";
import { deviceStatePath } from "./non-git-vault";
import { resolveBinary, runPaniolo, type PanioloResult } from "./paniolo";
import type { VaultPageRead } from "./non-git-staleness";

type CommandRunner = typeof runPaniolo;
type VaultSubject = { id: string; revision: number; state: string };
export type VaultReviewPlan = {
	id: string;
	vaultId: string;
	pageId: string;
	page: string;
	savedSha256: string;
	maximumRoleInvocations: number;
	subjects: VaultSubject[];
};
export type VaultReviewStatus = {
	id: string;
	state: "queued" | "running" | "complete";
	savedSha256: string;
	results: { id: string; revision: number; outcome: string }[];
};
export type VaultClosure = {
	state: "pending" | "complete";
	count: number;
	generation: number;
	reason: string | null;
};

const REVIEW_ID = /^VR-[0-9a-f]{64}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ALLEGATION_ID = /^S-[0-9a-f]{16}$/;

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function command(
	vaultRoot: string, binaryPath: string, args: string[], run: CommandRunner,
): Promise<unknown> {
	const result: PanioloResult = await run(resolveBinary(binaryPath), ["stale", ...args], vaultRoot, 15_000);
	if (result.code !== 0) throw new Error(result.stderr.trim() || "non-Git vault review unavailable");
	return JSON.parse(result.stdout) as unknown;
}

function argsFor(vaultRoot: string, page: string): string[] {
	return ["--vault", vaultRoot, "--device-state", deviceStatePath(vaultRoot), "--page", page];
}

/** Compare complete current writer scope to the immutable review plan. */
export function parseVaultReviewPlan(value: unknown, current: VaultPageRead): VaultReviewPlan {
	if (!record(value) || typeof value.id !== "string" || !REVIEW_ID.test(value.id)
		|| value.vaultId !== current.vaultId || value.pageId !== current.pageId || value.page !== current.page
		|| typeof value.savedSha256 !== "string" || !SHA256.test(value.savedSha256)
		|| !Number.isSafeInteger(value.maximumRoleInvocations) || (value.maximumRoleInvocations as number) < 1
		|| !Array.isArray(value.subjects) || value.subjects.length !== current.count || !current.entries) {
		throw new Error("saved review plan does not match this page");
	}
	const subjects = value.subjects.map((subject: unknown): VaultSubject => {
		if (!record(subject) || typeof subject.id !== "string" || !ALLEGATION_ID.test(subject.id)
			|| !Number.isSafeInteger(subject.revision) || typeof subject.state !== "string") {
			throw new Error("invalid saved review subject");
		}
		return { id: subject.id, revision: subject.revision as number, state: subject.state };
	});
	const expected = current.entries.map(({ id, revision, state }) => `${id}:${revision}:${state}`).sort();
	const actual = subjects.map(({ id, revision, state }) => `${id}:${revision}:${state}`).sort();
	if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("open entries changed since the list was read");
	return { id: value.id, vaultId: current.vaultId, pageId: current.pageId, page: current.page,
		savedSha256: value.savedSha256, maximumRoleInvocations: value.maximumRoleInvocations as number,
		subjects };
}

/** Recover only a structurally valid exact-page request after plugin reload. */
export function parseStoredVaultReviewPlan(value: unknown): VaultReviewPlan | null {
	if (!record(value) || typeof value.id !== "string" || !REVIEW_ID.test(value.id)
		|| typeof value.vaultId !== "string" || !/^[0-9a-f]{32}$/.test(value.vaultId)
		|| typeof value.pageId !== "string" || !/^[0-9a-f]{32}$/.test(value.pageId)
		|| typeof value.page !== "string" || !value.page || typeof value.savedSha256 !== "string"
		|| !SHA256.test(value.savedSha256) || !Number.isSafeInteger(value.maximumRoleInvocations)
		|| !Array.isArray(value.subjects)) return null;
	const subjects: VaultSubject[] = [];
	for (const item of value.subjects as unknown[]) {
		if (!record(item) || typeof item.id !== "string" || !ALLEGATION_ID.test(item.id)
			|| !Number.isSafeInteger(item.revision) || typeof item.state !== "string") return null;
		subjects.push({ id: item.id, revision: item.revision as number, state: item.state });
	}
	return { id: value.id, vaultId: value.vaultId, pageId: value.pageId, page: value.page,
		savedSha256: value.savedSha256, maximumRoleInvocations: value.maximumRoleInvocations as number,
		subjects };
}

/** Require saved text and the current editor buffer to match the plan. */
export function assertSavedEditor(editorText: string, savedText: string, plan: VaultReviewPlan): void {
	if (editorText !== savedText || createHash("sha256").update(savedText, "utf8").digest("hex") !== plan.savedSha256) {
		throw new Error("save the current editor page before review or closure");
	}
}

/** Read the current saved-byte plan; no model is invoked. */
export async function inspectVaultReview(
	vaultRoot: string, page: string, binaryPath: string, current: VaultPageRead,
	run: CommandRunner = runPaniolo,
): Promise<VaultReviewPlan> {
	const value = await command(vaultRoot, binaryPath, ["vault-review", "plan", ...argsFor(vaultRoot, page)], run);
	return parseVaultReviewPlan(value, current);
}

/** Explicitly queue one detached review; an unchanged request is joined. */
export async function submitVaultReview(
	vaultRoot: string, binaryPath: string, plan: VaultReviewPlan,
	run: CommandRunner = runPaniolo,
): Promise<string> {
	const value = await command(vaultRoot, binaryPath,
		["vault-review", "submit", ...argsFor(vaultRoot, plan.page)], run);
	if (!record(value) || value.reviewId !== plan.id || value.savedSha256 !== plan.savedSha256
		|| value.subjects !== plan.subjects.length || typeof value.state !== "string") {
		throw new Error("submitted review changed scope or saved bytes");
	}
	return plan.id;
}

/** Poll the durable exact-page review without invoking another role. */
export async function showVaultReview(
	vaultRoot: string, binaryPath: string, plan: VaultReviewPlan,
	run: CommandRunner = runPaniolo,
): Promise<VaultReviewStatus> {
	const value = await command(vaultRoot, binaryPath,
		["vault-review", "show", "--device-state", deviceStatePath(vaultRoot), plan.id], run);
	if (!record(value) || !record(value.request) || value.request.id !== plan.id
		|| value.request.vaultId !== plan.vaultId || value.request.pageId !== plan.pageId
		|| value.request.savedSha256 !== plan.savedSha256
		|| (value.state !== "queued" && value.state !== "running" && value.state !== "complete")
		|| !Array.isArray(value.subjects)) throw new Error("saved review belongs to another page or revision");
	const results = value.subjects.map((item: unknown): VaultReviewStatus["results"][number] => {
		if (!record(item) || typeof item.id !== "string" || !ALLEGATION_ID.test(item.id)
			|| !Number.isSafeInteger(item.revision) || typeof item.outcome !== "string") {
			throw new Error("invalid independent review result");
		}
		return { id: item.id, revision: item.revision as number, outcome: item.outcome };
	});
	return { id: plan.id, state: value.state, savedSha256: plan.savedSha256, results };
}

/** Ask the current writer to recheck saved bytes and close favorable entries. */
export async function closeVaultReview(
	vaultRoot: string, binaryPath: string, plan: VaultReviewPlan,
	run: CommandRunner = runPaniolo,
): Promise<VaultClosure> {
	const value = await command(vaultRoot, binaryPath,
		["vault-review", "close", ...argsFor(vaultRoot, plan.page), plan.id], run);
	if (!record(value) || (value.state !== "pending" && value.state !== "complete")
		|| !Number.isSafeInteger(value.count) || !Number.isSafeInteger(value.generation)
		|| (value.state === "complete" && value.count !== 0)
		|| (value.reason !== null && typeof value.reason !== "string")) {
		throw new Error("invalid current-writer closure result");
	}
	return { state: value.state, count: value.count as number,
		generation: value.generation as number, reason: value.reason };
}
