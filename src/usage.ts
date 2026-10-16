import { basename, isAbsolute, relative, resolve } from "node:path";
import { DIRS, FILES } from "./paths.ts";
import type { State } from "./state.ts";

/**
 * Attribute memory reads to source sessions:
 *  - reading/grepping a session_summaries/<file> credits that session
 *  - narrow search results that mention `session_summaries/<file>` (e.g. grep hits in MEMORY.md) credit those sessions
 * Returns summary file names (basename) that were used.
 */
/** A grep matching more distinct session summaries than this is considered a broad scan. */
export const MAX_NARROW_HITS = 2;

export function usedSummaryFiles(opts: {
	root: string;
	cwd: string;
	toolName: string;
	input: Record<string, unknown>;
	resultText: string;
}): string[] {
	const { root, cwd, toolName, input, resultText } = opts;
	const found = new Set<string>();
	const relToRoot = (p: string) => relative(root, resolve(cwd, p));
	const touchesRoot = (p: string) => {
		const r = relToRoot(p);
		return r === "" || (!r.startsWith("..") && !isAbsolute(r));
	};

	let touched = false;
	if (["read", "grep", "find", "ls"].includes(toolName)) {
		const p = typeof input.path === "string" && input.path ? input.path : ".";
		if (touchesRoot(p)) {
			touched = true;
			const r = relToRoot(p);
			if (toolName === "read" && r.startsWith(`${DIRS.summaries}/`)) found.add(basename(r));
		}
	} else if (toolName === "bash") {
		const cmd = typeof input.command === "string" ? input.command : "";
		if (cmd.includes(root)) touched = true;
		for (const m of cmd.matchAll(new RegExp(`${DIRS.summaries}/([\\w.:-]+\\.md)`, "g"))) found.add(m[1]!);
	}
	if (!touched) return [...found];

	// Grep output referencing summary files. Broad searches (many distinct hits, e.g. a pattern
	// matching every `session_path=` line) are not evidence of use, so only narrow hits count.
	const hits = new Set<string>();
	for (const m of resultText.matchAll(new RegExp(`${DIRS.summaries}/([\\w.:-]+\\.md)`, "g"))) hits.add(m[1]!);
	if (toolName !== "read" && hits.size > 0 && hits.size <= MAX_NARROW_HITS) for (const h of hits) found.add(h);
	return [...found];
}

export function touchesMemoryHandbook(root: string, cwd: string, input: Record<string, unknown>): boolean {
	const p = typeof input.path === "string" ? input.path : "";
	return !!p && resolve(cwd, p) === resolve(root, FILES.handbook);
}

export function applyUsage(state: State, files: Iterable<string>, now = Date.now()): number {
	const bySummary = new Map<string, string>();
	for (const [id, rec] of Object.entries(state.sessions)) if (rec.summaryFile) bySummary.set(rec.summaryFile, id);
	let n = 0;
	for (const f of files) {
		const id = bySummary.get(f);
		if (!id) continue;
		const rec = state.sessions[id]!;
		rec.usageCount = (rec.usageCount ?? 0) + 1;
		rec.lastUsageAt = now;
		n++;
	}
	return n;
}
