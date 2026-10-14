export type StalenessCount = {
	count: number | null;
	generation: number | null;
	source: "active-writer" | "snapshot" | "unavailable";
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonnegativeInteger(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Preserve qmd's nullable count and provenance without turning a missing read into zero. */
export function countFromQmdHit(hit: Record<string, unknown>): StalenessCount {
	const source = hit.stalenessSource;
	const count = nonnegativeInteger(hit.unresolvedStalenessCount);
	if ((source === "active-writer" || source === "snapshot") && count !== null) {
		return { count, generation: nonnegativeInteger(hit.stalenessGeneration), source };
	}
	return { count: null, generation: null, source: "unavailable" };
}

/** Parse the targeted CLI read and verify it answered for the requested page. */
export function countFromCli(stdout: string, target: string): StalenessCount {
	const value: unknown = JSON.parse(stdout);
	if (!isRecord(value) || value.target !== target) throw new Error("invalid page count response");
	if (value.status === "unavailable") return { count: null, generation: null, source: "unavailable" };
	if (value.status !== "available") throw new Error("invalid page count status");
	const count = nonnegativeInteger(value.count);
	if (count === null || (value.source !== "active-writer" && value.source !== "snapshot")) {
		throw new Error("invalid page count provenance");
	}
	return { count, generation: nonnegativeInteger(value.generation), source: value.source };
}

/** One label for the active page and every qmd search surface. */
export function countLabel(value: StalenessCount): string {
	if (value.count === null) return "Open entries unavailable";
	const label = `${value.count} open entr${value.count === 1 ? "y" : "ies"}`;
	return value.source === "snapshot" ? `${label} (snapshot)` : label;
}
