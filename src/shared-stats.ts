import { runPaniolo } from "./paniolo";

const WORKSPACE_FIELDS = "stale,qmd.inventory,qmd.maintenance,qmd.health,qmd.retrieval,git.workingTree,storage,operations";
const REPO_FIELDS = "stale,scan,wiki,git.workingTree,storage";
const READ_TIMEOUT_MS = 5_000;

export type StatsDomain = {
	availability: string;
	reason: string;
	data?: unknown;
};

export type StatsResponse = {
	schemaVersion: number;
	domains: Record<string, StatsDomain>;
};

export type SharedStats = {
	workspace: StatsResponse;
	repo: StatsResponse;
};

export type StatsRow = { name: string; value: string };

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown> : null;
}

function domain(raw: unknown): StatsDomain | null {
	const value = record(raw);
	if (!value || typeof value.availability !== "string" || typeof value.reason !== "string") return null;
	return { availability: value.availability, reason: value.reason, data: value.data };
}

/** Reject malformed or unknown stats contracts before displaying cached values. */
export function parseStats(raw: string): StatsResponse | null {
	let parsed: unknown;
	try { parsed = JSON.parse(raw) as unknown; } catch { return null; }
	const value = record(parsed);
	const domains = record(value?.domains);
	if (value?.schemaVersion !== 1 || !domains) return null;
	const selected: Record<string, StatsDomain> = {};
	for (const [key, rawDomain] of Object.entries(domains)) {
		const item = domain(rawDomain);
		if (!item) return null;
		selected[key] = item;
	}
	return { schemaVersion: 1, domains: selected };
}

/** Poll only Paniolo's read-only stats command for workspace and vault scope. */
export async function readSharedStats(binary: string, configRoot: string, sourcePath: string): Promise<SharedStats> {
	const base = ["stats", "--json", "--root", sourcePath];
	const [workspace, repo] = await Promise.all([
		runPaniolo(binary, [...base, "--scope", "workspace", "--fields", WORKSPACE_FIELDS], configRoot, READ_TIMEOUT_MS),
		runPaniolo(binary, [...base, "--scope", "repo", "--fields", REPO_FIELDS], configRoot, READ_TIMEOUT_MS),
	]);
	const workspaceValue = workspace.code === 0 ? parseStats(workspace.stdout) : null;
	const repoValue = repo.code === 0 ? parseStats(repo.stdout) : null;
	if (!workspaceValue || !repoValue) throw new Error("stats-read-failed");
	return { workspace: workspaceValue, repo: repoValue };
}

function reading(stats: SharedStats, scope: "workspace" | "repo", key: string): StatsDomain | null {
	return stats[scope].domains[key] ?? null;
}

function count(value: unknown): string {
	return typeof value === "number" && Number.isFinite(value) ? String(value) : "?";
}

function status(name: string, value: StatsDomain | null, detail: string): StatsRow {
	if (!value) return { name, value: "unknown" };
	return {
		name,
		value: `${value.availability} (${value.reason})${detail ? ` · ${detail}` : ""}`,
	};
}

/** Format producer states without converting missing, failed, or expired values to zero. */
export function sharedStatsRows(stats: SharedStats | null): StatsRow[] {
	if (!stats) return [{ name: "Shared stats", value: "unavailable" }];
	const stale = reading(stats, "repo", "stale");
	const wiki = reading(stats, "repo", "wiki");
	const inventory = reading(stats, "workspace", "qmd.inventory");
	const maintenance = reading(stats, "workspace", "qmd.maintenance");
	const health = reading(stats, "workspace", "qmd.health");
	const retrieval = reading(stats, "workspace", "qmd.retrieval");
	const git = reading(stats, "repo", "git.workingTree");
	const storage = reading(stats, "repo", "storage");
	const operations = reading(stats, "workspace", "operations");
	const staleData = record(stale?.data);
	const wikiData = record(wiki?.data);
	const inventoryData = record(inventory?.data);
	const surfaces = record(inventoryData?.surfaces);
	const maintenanceData = record(maintenance?.data);
	const healthData = record(health?.data);
	const vectors = record(healthData?.vectors);
	const retrievalData = record(retrieval?.data);
	const window = record(record(retrievalData?.windows)?.last24Hours);
	const gitData = record(git?.data);
	const checkouts = Array.isArray(gitData?.checkouts) ? gitData.checkouts : [];
	const dirty = checkouts.map((item) => record(item)).filter((item): item is Record<string, unknown> => item !== null);
	const storageData = record(storage?.data);
	const roots = Array.isArray(storageData?.roots) ? storageData.roots : [];
	const volumes = Array.isArray(storageData?.volumes) ? storageData.volumes : [];
	const volumeRows = roots.map((rawRoot) => {
		const root = record(rawRoot);
		const volume = volumes.map(record).find((item) => item?.volumeKey === root?.volumeKey);
		const bytes = typeof volume?.availableBytes === "number" ? `${Math.round(volume.availableBytes / (1024 ** 3))} GiB` : "?";
		return root ? `${root.role}: ${root.availability === "available" ? bytes : `${root.availability} (${root.reason})`}${root.pressure && root.pressure !== "normal" ? ` ${root.pressure}` : ""}` : "unknown";
	});
	const operationsData = record(operations?.data);
	return [
		status("Staleness", stale, `actionable ${count(staleData?.actionable)}`),
		status("Wiki", wiki, `${count(wikiData?.errors)} errors · ${count(wikiData?.warnings)} warnings`),
		status("Indexed sources", inventory, `${count(surfaces?.wiki)} wiki · ${count(surfaces?.docs)} docs · ${count(surfaces?.codeComments)} comments`),
		status("Index activity", maintenance, String(maintenanceData?.phase ?? "unknown")),
		status("Index health", health, `BM25 ${String(record(healthData?.bm25)?.status ?? "unknown")} · vectors ${String(vectors?.status ?? "unknown")} ${count(inventoryData?.vectorReady)}/${count(inventoryData?.vectorEligible)}`),
		status("Hook retrieval (24h)", retrieval, `${window?.hitRate == null ? "?" : `${Math.round(Number(window.hitRate) * 100)}%`} from ${count(window?.samples)} samples`),
		status("Git", git, dirty.map((item) => `${String(item.repository ?? "repo")}: ${item.availability === "available" ? count(record(item.counts)?.uniqueDirtyPaths) : `${item.availability} (${item.reason})`}`).join(" · ")),
		status("Storage", storage, volumeRows.join(" · ")),
		status("Operations", operations, `${count(operationsData?.pending)} queued · ${count(operationsData?.leased)} running`),
	];
}

/** Keep the status bar short while preserving active work and failures. */
export function statusBarText(stats: SharedStats | null): string {
	if (!stats) return "Paniolo: stats unavailable";
	const rows = sharedStatsRows(stats);
	const maintenance = reading(stats, "workspace", "qmd.maintenance");
	const phase = record(maintenance?.data)?.phase;
	const active = phase === "indexing" || phase === "embedding" ? `index ${phase} · ` : "";
	const issue = rows.find((row) => !row.value.startsWith("available"));
	return `Paniolo: ${active}${issue ? `${issue.name} ${issue.value}` : "stats available"}`;
}
