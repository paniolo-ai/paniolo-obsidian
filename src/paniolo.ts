import { execFile } from "child_process";
import { existsSync } from "fs";
import { basename, dirname, join } from "path";

export interface PanioloResult {
	stdout: string;
	stderr: string;
	code: number;
}

export type VaultRegistration = {
	name: string;
	root: string;
	changed: boolean;
};

/** Ask the CLI to register a vault and return its structured result. */
export async function registerVault(
	binary: string,
	vaultRoot: string,
	run: typeof runPaniolo = runPaniolo,
): Promise<VaultRegistration> {
	const result = await run(
		binary,
		["wiki", "init", "--root", vaultRoot, "--slug", basename(vaultRoot), "--json"],
		vaultRoot,
	);
	if (result.code !== 0) {
		throw new Error(result.stderr.trim() || `paniolo exited with code ${result.code}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(result.stdout);
	} catch {
		throw new Error("paniolo returned invalid registration JSON");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("paniolo returned an invalid registration");
	}
	const registration = parsed as Record<string, unknown>;
	if (
		typeof registration.name !== "string" ||
		typeof registration.root !== "string" ||
		typeof registration.changed !== "boolean"
	) {
		throw new Error("paniolo returned an invalid registration");
	}
	return {
		name: registration.name,
		root: registration.root,
		changed: registration.changed,
	};
}

export class PanioloNotFoundError extends Error {
	constructor(binary: string) {
		super(`paniolo binary not found: ${binary}`);
		this.name = "PanioloNotFoundError";
	}
}

export class PanioloTimeoutError extends Error {
	constructor(timeoutMs: number) {
		super(`paniolo timed out after ${timeoutMs}ms`);
		this.name = "PanioloTimeoutError";
	}
}

/** Resolve the paniolo binary: an explicit setting wins, else PATH. */
export function resolveBinary(configured: string): string {
	return configured.trim() || "paniolo";
}

/**
 * Walk up from `startDir` looking for a directory containing
 * `paniolo.config.json`. Returns the directory, or null when the walk
 * reaches the filesystem root — a vault that is not paniolo-configured.
 */
export function findConfigRoot(startDir: string): string | null {
	let dir = startDir;
	for (;;) {
		if (existsSync(join(dir, "paniolo.config.json"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/**
 * Run `paniolo <args>` and capture output. A nonzero exit code is not an
 * error — paniolo exits nonzero to report findings — so only spawn
 * failures and timeouts reject.
 */
export function runPaniolo(
	binary: string,
	args: string[],
	cwd: string,
	timeoutMs = 120_000,
): Promise<PanioloResult> {
	return new Promise((resolve, reject) => {
		execFile(
			binary,
			args,
			{
				cwd,
				timeout: timeoutMs,
				windowsHide: true,
				maxBuffer: 32 * 1024 * 1024,
			},
			(error, stdout, stderr) => {
				if (error) {
					const code = (error as NodeJS.ErrnoException).code;
					if (code === "ENOENT") {
						reject(new PanioloNotFoundError(binary));
						return;
					}
					if (error.killed) {
						reject(new PanioloTimeoutError(timeoutMs));
						return;
					}
				}
				resolve({
					stdout: stdout.toString(),
					stderr: stderr.toString(),
					code: typeof (error as { code?: unknown })?.code === "number"
						? (error as { code: number }).code
						: 0,
				});
			},
		);
	});
}
