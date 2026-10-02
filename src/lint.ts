import { Diagnostic } from "@codemirror/lint";
import { Text } from "@codemirror/state";
import { join, normalize } from "path";

export interface Finding {
	ruleId: string;
	severity: "error" | "warn" | "info" | string;
	message: string;
	file: string | null;
	line: number | null;
	hint?: string;
	source: "scan" | "wiki";
}

interface RawFinding {
	ruleId?: string;
	severity?: string;
	message?: string;
	file?: string | null;
	line?: number | null;
	hint?: string;
}

function norm(path: string): string {
	return normalize(path).replace(/\\/g, "/").toLowerCase();
}

/**
 * `paniolo` prints status lines to stdout before the JSON payload
 * (e.g. `scanning 1 requested file(s)`). Slice from the first `{`/`[`.
 */
function parseJsonLoose<T>(stdout: string): T | null {
	const start = Math.min(
		...["{", "["]
			.map((c) => stdout.indexOf(c))
			.filter((i) => i >= 0),
	);
	if (!Number.isFinite(start)) return null;
	try {
		return JSON.parse(stdout.slice(start)) as T;
	} catch {
		return null;
	}
}

/** Parse `paniolo scan --format json` output for findings against `absPath`. */
export function parseScanFindings(stdout: string, absPath: string): Finding[] {
	const parsed = parseJsonLoose<{ findings?: RawFinding[] }>(stdout);
	if (!parsed) return [];
	if (!Array.isArray(parsed.findings)) return [];
	return parsed.findings
		.filter((f) => f.file && f.message)
		.map((f) => ({
			ruleId: f.ruleId ?? "scan",
			severity: f.severity ?? "warn",
			message: f.message ?? "",
			file: f.file ?? null,
			line: f.line ?? null,
			hint: f.hint,
			source: "scan" as const,
		}));
}

/**
 * Parse `paniolo wiki --config … --format json` output — an array of
 * WikiResult objects — and keep findings whose `root + file` equals
 * `absPath`. Wiki findings are file-level (no line); the editor maps them
 * onto the offending wikilink text or line 1.
 */
export function parseWikiFindings(stdout: string, absPath: string): Finding[] {
	const parsed = parseJsonLoose<unknown>(stdout);
	if (!parsed) return [];
	const results = Array.isArray(parsed) ? parsed : [parsed];
	const target = norm(absPath);
	const findings: Finding[] = [];
	for (const result of results) {
		const root = (result as { root?: string }).root;
		const list = (result as { findings?: RawFinding[] }).findings;
		if (!root || !Array.isArray(list)) continue;
		for (const f of list) {
			if (!f.file || !f.message) continue;
			if (norm(join(root, f.file)) !== target) continue;
			findings.push({
				ruleId: f.ruleId ?? "wiki",
				severity: f.severity ?? "warn",
				message: f.message ?? "",
				file: f.file,
				line: f.line ?? null,
				hint: f.hint,
				source: "wiki",
			});
		}
	}
	return findings;
}

/**
 * Map findings onto the document as lint diagnostics. Findings carry a
 * 1-based line when the CLI knows it; wikilink findings locate the
 * offending `[[link]]` in the buffer; anything else anchors line 1.
 */
export function findingsToDiagnostics(doc: Text, findings: Finding[]): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	for (const f of findings) {
		const range = resolveRange(doc, f);
		if (!range) continue;
		diagnostics.push({
			from: range.from,
			to: range.to,
			severity: f.severity === "error" ? "error" : f.severity === "info" ? "info" : "warning",
			message: f.hint ? `${f.ruleId}: ${f.message} — ${f.hint}` : `${f.ruleId}: ${f.message}`,
			source: `paniolo ${f.source}`,
		});
	}
	return diagnostics;
}

function resolveRange(doc: Text, f: Finding): { from: number; to: number } | null {
	if (f.line && f.line >= 1 && f.line <= doc.lines) {
		const line = doc.line(f.line);
		return { from: line.from, to: Math.max(line.to, line.from + 1) };
	}
	const link = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/.exec(f.message);
	if (link) {
		const needle = `[[${link[1]}`;
		for (let i = 1; i <= doc.lines; i++) {
			const line = doc.line(i);
			const at = line.text.indexOf(needle);
			if (at >= 0) {
				const from = line.from + at;
				return { from, to: from + needle.length };
			}
		}
	}
	const first = doc.line(1);
	return { from: first.from, to: Math.max(first.to, first.from + 1) };
}
