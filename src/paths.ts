import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const FILES = {
	summary: "memory_summary.md",
	handbook: "MEMORY.md",
	raw: "raw_memories.md",
	diff: "phase2_workspace_diff.md",
	gitignore: ".gitignore",
} as const;

export const DIRS = {
	summaries: "session_summaries",
	notes: "notes",
	state: ".state",
	stateRaw: join(".state", "raw"),
	stateSummaries: join(".state", "summaries"),
} as const;

export interface Layout {
	root: string;
	summary: string;
	handbook: string;
	raw: string;
	diff: string;
	summariesDir: string;
	notesDir: string;
	stateDir: string;
	stateRawDir: string;
	stateSummariesDir: string;
	stateFile: string;
	lockFile: string;
	logFile: string;
}

export function layout(root: string): Layout {
	return {
		root,
		summary: join(root, FILES.summary),
		handbook: join(root, FILES.handbook),
		raw: join(root, FILES.raw),
		diff: join(root, FILES.diff),
		summariesDir: join(root, DIRS.summaries),
		notesDir: join(root, DIRS.notes),
		stateDir: join(root, DIRS.state),
		stateRawDir: join(root, DIRS.stateRaw),
		stateSummariesDir: join(root, DIRS.stateSummaries),
		stateFile: join(root, DIRS.state, "state.json"),
		lockFile: join(root, DIRS.state, "lock"),
		logFile: join(root, DIRS.state, "log.ndjson"),
	};
}

const GITIGNORE = `.state/\n${FILES.diff}\n`;

/** Create directories and static files. Idempotent. Does not touch git. */
export async function ensureLayout(l: Layout): Promise<void> {
	for (const d of [l.root, l.summariesDir, l.notesDir, l.stateDir, l.stateRawDir, l.stateSummariesDir]) {
		await mkdir(d, { recursive: true });
	}
	const gi = join(l.root, FILES.gitignore);
	if (!existsSync(gi)) await writeFile(gi, GITIGNORE);
	const keep = join(l.notesDir, ".gitkeep");
	if (!existsSync(keep)) await writeFile(keep, "");
}
