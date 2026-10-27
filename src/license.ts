import { resolveBinary, runPaniolo } from "./paniolo";

export type LicenseState = "none" | "current" | "in_grace" | "expired" | "invalid";

export type LicenseReport = {
	state: LicenseState;
	product?: string;
	features?: string[];
};

/** Read only the CLI's nonsecret, offline entitlement status. */
export async function readLicenseStatus(binaryPath: string, cwd: string): Promise<LicenseReport> {
	const result = await runPaniolo(resolveBinary(binaryPath), ["license", "status", "--json"], cwd, 10_000);
	if (result.code !== 0) throw new Error("Paniolo could not read the entitlement status.");
	let parsed: unknown;
	try {
		parsed = JSON.parse(result.stdout);
	} catch {
		throw new Error("Paniolo returned an unreadable entitlement status.");
	}
	if (typeof parsed !== "object" || parsed === null || !("state" in parsed)) {
		throw new Error("Paniolo returned an invalid entitlement status.");
	}
	const state = parsed.state;
	if (state !== "none" && state !== "current" && state !== "in_grace" && state !== "expired" && state !== "invalid") {
		throw new Error("Paniolo returned an unknown entitlement state.");
	}
	const product = "product" in parsed && typeof parsed.product === "string" ? parsed.product : undefined;
	const features = "features" in parsed && Array.isArray(parsed.features)
		&& parsed.features.every((feature: unknown) => typeof feature === "string")
		? parsed.features as string[] : undefined;
	return { state, ...(product === undefined ? {} : { product }), ...(features === undefined ? {} : { features }) };
}

/** Hand a pasted signed token to the CLI through stdin; Obsidian never saves it. */
export async function importLicenseToken(binaryPath: string, cwd: string, token: string): Promise<void> {
	const result = await runPaniolo(resolveBinary(binaryPath), ["license", "import"], cwd, 10_000, token);
	if (result.code !== 0) throw new Error("Paniolo rejected this signed entitlement.");
}

/** Describe entitlement claims without exposing the signed token. */
export function licenseDescription({ state, product, features = [] }: LicenseReport): string {
	if (state === "none") return "No entitlement imported. Free features remain available.";
	if (state === "invalid") return "Stored entitlement is invalid. Free features remain available.";
	if (state === "expired") return "Entitlement expired. Free features remain available.";
	if (product !== "wiki" || !features.some((feature) => feature === "wiki.fix.bulk" || feature === "stale.watch")) {
		return "This entitlement does not include Wiki Pro features.";
	}
	return state === "in_grace" ? "Wiki Pro active in its offline grace period." : "Wiki Pro active.";
}
