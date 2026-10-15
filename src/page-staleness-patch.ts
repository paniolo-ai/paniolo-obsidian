export type ReviewedPatch = { allegationId: string; bundleId: string; patchHash: string; anchor: string; patch: string };
export type ReviewedPagePatches = { runId: string; target: string; snapshotSha256: string; patches: ReviewedPatch[] };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Bind the engine's reviewed patches to one report and one editor snapshot. */
export function parseReviewedPagePatches(stdout: string, runId: string, target: string, snapshotSha256: string): ReviewedPagePatches {
	const value: unknown = JSON.parse(stdout);
	if (!isRecord(value) || value.runId !== runId || value.target !== target || value.snapshotSha256 !== snapshotSha256
		|| !Array.isArray(value.patches)) throw new Error("reviewed patches do not match this editor snapshot");
	const patches: ReviewedPatch[] = [];
	for (const item of value.patches as unknown[]) {
		if (!isRecord(item) || typeof item.allegationId !== "string" || typeof item.bundleId !== "string"
			|| typeof item.patchHash !== "string" || typeof item.anchor !== "string" || typeof item.patch !== "string") {
			throw new Error("invalid reviewed patch");
		}
		patches.push({ allegationId: item.allegationId, bundleId: item.bundleId, patchHash: item.patchHash, anchor: item.anchor, patch: item.patch });
	}
	return { runId, target, snapshotSha256, patches };
}

/** Apply a reviewed single-file unified diff to exactly matching editor text. */
export function applyReviewedPatch(text: string, patch: string, path: string): string {
	const lines = patch.split("\n");
	const oldHeader = `--- a/${path}`;
	const newHeader = `+++ b/${path}`;
	const original = text.split("\n");
	const trailingNewline = text.endsWith("\n");
	if (trailingNewline) original.pop();
	let cursor = 0;
	while (cursor < lines.length && (lines[cursor].startsWith("diff --git ") || lines[cursor].startsWith("index "))) cursor++;
	if (lines[cursor] !== oldHeader || lines[cursor + 1] !== newHeader) throw new Error("patch targets a different page");
	cursor += 2;
	let offset = 0;
	let previousOldEnd = 0;
	let changed = false;
	while (cursor < lines.length && lines[cursor] !== "") {
		const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(lines[cursor]);
		if (!match) throw new Error("patch has unsupported metadata, another file, or malformed hunk");
		const oldStart = Number(match[1]);
		const oldCount = Number(match[2] ?? "1");
		const newStart = Number(match[3]);
		const newCount = Number(match[4] ?? "1");
		if (!Number.isSafeInteger(oldStart) || !Number.isSafeInteger(oldCount) || !Number.isSafeInteger(newStart)
			|| !Number.isSafeInteger(newCount) || oldStart < 1 || oldStart < previousOldEnd
			|| newStart !== oldStart + offset || oldStart - 1 + offset > original.length) throw new Error("patch hunk has invalid range");
		cursor++;
		let position = oldStart - 1 + offset;
		let readOld = 0;
		let wroteNew = 0;
		while (cursor < lines.length && (readOld < oldCount || wroteNew < newCount)) {
			const line = lines[cursor];
			if (line.startsWith("@@ ") || line === "") break;
			if (line === "\\ No newline at end of file") { cursor++; continue; }
			const tag = line[0];
			const content = line.slice(1);
			if (tag === " " || tag === "-") {
				if (original[position] !== content) throw new Error("editor text changed since the patch was reviewed");
				readOld++;
				if (tag === "-") { original.splice(position, 1); offset--; changed = true; }
				else { position++; wroteNew++; }
			} else if (tag === "+") {
				original.splice(position, 0, content);
				position++;
				wroteNew++;
				offset++;
				changed = true;
			} else throw new Error("patch hunk contains an unsupported line");
			cursor++;
		}
		if (readOld !== oldCount || wroteNew !== newCount) throw new Error("patch hunk line counts differ");
		if (lines[cursor] === "\\ No newline at end of file") cursor++;
		previousOldEnd = oldStart + oldCount;
	}
	if (!changed || lines.slice(cursor).some((line) => line !== "")) throw new Error("patch is empty or contains another file");
	return original.join("\n") + (trailingNewline ? "\n" : "");
}
