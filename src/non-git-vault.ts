import { createHash } from "crypto";
import { existsSync } from "fs";
import { homedir } from "os";
import { isAbsolute, join, normalize, sep } from "path";
import { resolveBinary, runPaniolo, type PanioloResult } from "./paniolo";

type CommandRunner = typeof runPaniolo;
export type VaultWriterState = "unregistered" | "unclaimed" | "owned" | "refused";

/** Keep the capability outside any synchronized vault on the local device. */
export function deviceStatePath(vaultRoot: string, base = localStateRoot()): string {
	const normalized = normalize(vaultRoot);
	const key = createHash("sha256")
		.update(process.platform === "win32" ? normalized.toLowerCase() : normalized)
		.digest("hex").slice(0, 32);
	return join(base, "paniolo-obsidian", "vaults", key);
}

/** Choose the operating system's device-local application state location. */
function localStateRoot(): string {
	if (process.platform === "win32") {
		const root = process.env.LOCALAPPDATA;
		if (!root) throw new Error("LOCALAPPDATA is unavailable for the vault writer");
		return root;
	}
	if (process.platform === "darwin") return join(homedir(), "Library", "Application Support");
	return process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
}

/** Require a successful CLI result before interpreting its JSON. */
function completed(result: PanioloResult, step: string): string {
	if (result.code !== 0) throw new Error(`${step}: ${result.stderr.trim() || result.stdout.trim() || "CLI refused"}`);
	return result.stdout.trim();
}

/** Read the current device's writer status without registering anything. */
export async function readVaultWriterState(
	vaultRoot: string, binaryPath: string, run: CommandRunner = runPaniolo,
	manifestExists: (path: string) => boolean = existsSync,
): Promise<VaultWriterState> {
	if (!manifestExists(join(vaultRoot, ".paniolo", "stale-vault.json"))) return "unregistered";
	const state = deviceStatePath(vaultRoot);
	const result = await run(resolveBinary(binaryPath), ["stale", "vault-status", "--vault", vaultRoot, "--device-state", state], vaultRoot, 10_000);
	const value: unknown = JSON.parse(completed(result, "writer status"));
	if (value === "unclaimed" || value === "owned" || value === "refused") return value;
	throw new Error("invalid writer status response");
}

/** Explicitly register the selected saved page and claim only an unclaimed vault. */
export async function registerNonGitPage(
	vaultRoot: string, page: string, binaryPath: string, run: CommandRunner = runPaniolo,
	manifestExists: (path: string) => boolean = existsSync,
): Promise<{ vaultId: string; pageId: string }> {
	if (!page || isAbsolute(page) || page.split(/[\\/]/).some((part) => part === ".." || part === "." || !part)
		|| !page.toLowerCase().endsWith(".md") || page.includes(`${sep}${sep}`)) {
		throw new Error("select one vault-relative Markdown page");
	}
	const binary = resolveBinary(binaryPath);
	const command = async (args: string[], step: string): Promise<unknown> => {
		const result = await run(binary, ["stale", ...args], vaultRoot, 20_000);
		return JSON.parse(completed(result, step)) as unknown;
	};
	const manifest = join(vaultRoot, ".paniolo", "stale-vault.json");
	if (!manifestExists(manifest)) await command(["vault-register", "--vault", vaultRoot], "vault registration");
	const state = deviceStatePath(vaultRoot);
	const status = await command(["vault-status", "--vault", vaultRoot, "--device-state", state], "writer status");
	if (status === "unclaimed") await command(["vault-claim", "--vault", vaultRoot, "--device-state", state], "writer claim");
	else if (status !== "owned") throw new Error("this device does not own the non-Git vault writer");
	const identity = await command(["page-register", "--vault", vaultRoot, "--page", page], "page registration");
	if (typeof identity !== "object" || identity === null || !("vault_id" in identity) || !("page_id" in identity)
		|| typeof identity.vault_id !== "string" || typeof identity.page_id !== "string") {
		throw new Error("invalid registered page identity");
	}
	return { vaultId: identity.vault_id, pageId: identity.page_id };
}
