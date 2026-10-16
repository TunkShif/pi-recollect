import { readFile } from "node:fs/promises";
import { loadPrompt, render } from "./prompts.ts";

/**
 * Filter memory_summary.md down to what matters for the current cwd:
 * - always keep everything before `## What's in Memory` (profile, preferences, tips)
 * - inside `## What's in Memory`: keep `### <scope> (cwd=...)` blocks whose cwd equals or contains
 *   the current cwd, `(cwd=*)` scopes, plus the `recentOther` (default 0) most recent other scopes
 * - inside `### Older Memory Topics`: keep matching `#### <scope>` blocks
 * - every other scope is listed by name only in one trailing line (grep MEMORY.md for details)
 * - any later `## ` sections are kept
 * Then hard-truncate so the whole injected section (instructions + summary) fits `maxTokens` (~4 chars/token).
 */

interface Block {
	heading: string;
	cwd?: string;
	body: string[];
}

const CWD_RE = /\(cwd=([^)]*)\)\s*$/;

/**
 * True when the current cwd is the scope's cwd or inside it. A scope *below* the cwd does not match:
 * otherwise launching from a parent such as `~` would inject every project scope.
 */
export function cwdMatches(scopeCwd: string | undefined, cwd: string): boolean {
	if (!scopeCwd) return false;
	const s = scopeCwd.trim().replace(/\/+$/, "");
	if (s === "*" || s === "") return true;
	const c = cwd.replace(/\/+$/, "");
	return c === s || c.startsWith(`${s}/`);
}

/** `### Name (cwd=/x)` -> `Name` */
function scopeName(heading: string): string {
	return heading.replace(/^#+\s*/, "").replace(CWD_RE, "").trim();
}

function splitBlocks(lines: string[], prefix: string): { pre: string[]; blocks: Block[] } {
	const pre: string[] = [];
	const blocks: Block[] = [];
	for (const line of lines) {
		if (line.startsWith(prefix) && !line.startsWith(`${prefix}#`)) {
			const m = CWD_RE.exec(line);
			blocks.push({ heading: line, cwd: m?.[1], body: [] });
		} else if (blocks.length) blocks[blocks.length - 1]!.body.push(line);
		else pre.push(line);
	}
	return { pre, blocks };
}

export function filterSummary(summary: string, cwd: string, opts: { recentOther?: number } = {}): string {
	const recentOther = opts.recentOther ?? 0;
	const lines = summary.replace(/\r\n/g, "\n").split("\n");
	const wimIdx = lines.findIndex((l) => /^## What's in Memory\s*$/i.test(l.trim()));
	if (wimIdx < 0) return summary.trim();
	let endIdx = lines.findIndex((l, i) => i > wimIdx && /^## /.test(l));
	if (endIdx < 0) endIdx = lines.length;

	const head = lines.slice(0, wimIdx + 1);
	const wim = lines.slice(wimIdx + 1, endIdx);
	const tail = lines.slice(endIdx);

	const olderIdx = wim.findIndex((l) => /^### Older Memory Topics\s*$/i.test(l.trim()));
	const recentPart = olderIdx >= 0 ? wim.slice(0, olderIdx) : wim;
	const olderPart = olderIdx >= 0 ? wim.slice(olderIdx + 1) : [];

	const out: string[] = [...head];
	const recent = splitBlocks(recentPart, "### ");
	out.push(...recent.pre);
	let others = 0;
	const hidden: string[] = [];
	for (const b of recent.blocks) {
		if (cwdMatches(b.cwd, cwd)) out.push(b.heading, ...b.body);
		else if (others < recentOther) {
			others++;
			out.push(b.heading, ...b.body);
		} else hidden.push(scopeName(b.heading));
	}

	if (olderPart.length) {
		const older = splitBlocks(olderPart, "#### ");
		const kept = older.blocks.filter((b) => cwdMatches(b.cwd, cwd));
		for (const b of older.blocks) if (!kept.includes(b)) hidden.push(scopeName(b.heading));
		if (kept.length) {
			out.push("### Older Memory Topics");
			for (const b of kept) out.push(b.heading, ...b.body);
		}
	}
	if (hidden.length) {
		const names = [...new Set(hidden)];
		out.push("", `(Other scopes omitted for this cwd; grep MEMORY.md if needed: ${names.join("; ")})`);
	}
	out.push(...tail);
	return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

const TRUNCATION_MARKER = "\n[... memory summary truncated; grep MEMORY.md for more ...]";

export function truncateToChars(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const room = Math.max(0, maxChars - TRUNCATION_MARKER.length);
	const cut = text.lastIndexOf("\n", room);
	return `${text.slice(0, cut > room * 0.8 ? cut : room)}${TRUNCATION_MARKER}`;
}

export function truncateToTokens(text: string, maxTokens: number): string {
	return truncateToChars(text, maxTokens * 4);
}

/** Never shrink the summary below this many chars, even if the instructions alone exceed the budget. */
const MIN_SUMMARY_CHARS = 800;

export async function buildMemorySection(opts: { root: string; summaryPath: string; cwd: string; maxTokens: number }): Promise<string | undefined> {
	const raw = await readFile(opts.summaryPath, "utf8").catch(() => "");
	if (!raw.trim()) return undefined;
	const body = raw.replace(/^v1\s*\n/, "");
	// The budget covers the whole injected section, so subtract the fixed instructions first.
	const overhead = render(loadPrompt("read_path"), { base_path: opts.root, memory_summary: "" }).length;
	const budget = Math.max(opts.maxTokens * 4 - overhead, MIN_SUMMARY_CHARS);
	const filtered = truncateToChars(filterSummary(body, opts.cwd), budget);
	if (!filtered.trim()) return undefined;
	return render(loadPrompt("read_path"), { base_path: opts.root, memory_summary: filtered });
}
