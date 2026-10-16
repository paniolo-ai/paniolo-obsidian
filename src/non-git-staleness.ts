import { resolveBinary, runPaniolo, type PanioloResult } from "./paniolo";
import { deviceStatePath } from "./non-git-vault";

type CommandRunner = typeof runPaniolo;
export type VaultEntry = { id: string; anchor: string; state: string; revision: number };
export type VaultPageRead = {
	vaultId: string;
	pageId: string;
	page: string;
	source: "active-writer";
	generation: number;
	count: number;
	entries?: VaultEntry[];
};

const ID = /^[0-9a-f]{32}$/;
const OPEN_STATES = new Set(["pending-verification", "confirmed-stale", "remediation-proposed", "insufficient-evidence"]);

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reject partial or cross-page vault reads; an unknown count is never zero. */
export function parseVaultPageRead(stdout: string, page: string, list: boolean): VaultPageRead {
	const value: unknown = JSON.parse(stdout);
	if (!record(value) || value.page !== page || typeof value.vaultId !== "string" || !ID.test(value.vaultId)
		|| typeof value.pageId !== "string" || !ID.test(value.pageId) || value.source !== "active-writer"
		|| !Number.isSafeInteger(value.generation) || (value.generation as number) < 0
		|| !Number.isSafeInteger(value.count) || (value.count as number) < 0) {
		throw new Error("invalid non-Git page count response");
	}
	const result: VaultPageRead = { vaultId: value.vaultId, pageId: value.pageId, page,
		source: "active-writer", generation: value.generation as number, count: value.count as number };
	if (list) {
		if (!Array.isArray(value.entries) || value.entries.length !== result.count) throw new Error("incomplete non-Git entry list");
		result.entries = value.entries.map((entry: unknown): VaultEntry => {
			if (!record(entry) || typeof entry.id !== "string" || !/^S-[0-9a-f]{16}$/.test(entry.id)
				|| typeof entry.anchor !== "string" || typeof entry.state !== "string" || !OPEN_STATES.has(entry.state)
				|| !Number.isSafeInteger(entry.revision) || (entry.revision as number) < 0) {
				throw new Error("invalid non-Git entry");
			}
			return { id: entry.id, anchor: entry.anchor, state: entry.state, revision: entry.revision as number };
		});
	}
	return result;
}

/** Read one registered page through the local writer ledger, without a model call. */
export async function readVaultPage(
	vaultRoot: string, page: string, binaryPath: string, list = false,
	run: CommandRunner = runPaniolo,
): Promise<VaultPageRead> {
	const command = list ? "vault-list" : "vault-counts";
	const result: PanioloResult = await run(resolveBinary(binaryPath),
		["stale", command, "--vault", vaultRoot, "--device-state", deviceStatePath(vaultRoot), "--page", page],
		vaultRoot, 10_000);
	if (result.code !== 0) throw new Error(result.stderr.trim() || "non-Git vault ledger unavailable");
	return parseVaultPageRead(result.stdout, page, list);
}
