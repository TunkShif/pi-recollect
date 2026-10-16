import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { RecollectConfig } from "./config.ts";
import type { SessionRecord, State } from "./state.ts";

/** Minimal shapes of pi session JSONL entries we rely on (see pi docs/session-format.md). */
export interface RawEntry {
	type: string;
	id?: string;
	parentId?: string | null;
	timestamp?: string;
	[key: string]: unknown;
}

export interface SessionHeader {
	type: "session";
	id: string;
	timestamp: string;
	cwd: string;
	parentSession?: string;
}

export interface LoadedSession {
	path: string;
	header: SessionHeader;
	/** Active branch, root -> leaf (last appended entry is the leaf). */
	branch: RawEntry[];
	leafId: string;
	mtimeMs: number;
	lastTimestampMs: number;
}

export async function listSessionFiles(dir: string): Promise<string[]> {
	const out: string[] = [];
	async function walk(d: string, depth: number) {
		let entries: import("node:fs").Dirent[];
		try {
			entries = await readdir(d, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const p = join(d, e.name);
			if (e.isDirectory() && depth < 3) await walk(p, depth + 1);
			else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
		}
	}
	await walk(dir, 0);
	return out;
}

export function parseJsonl(text: string): RawEntry[] {
	const out: RawEntry[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const v = JSON.parse(line);
			if (v && typeof v === "object" && typeof v.type === "string") out.push(v);
		} catch {
			// partial trailing line while the session is being written; ignore
		}
	}
	return out;
}

/**
 * Resolve the active branch: pi appends entries and the leaf is the last
 * appended entry with an id. Walk parentId links back to the root.
 */
export function activeBranch(entries: RawEntry[]): { branch: RawEntry[]; leafId: string } | undefined {
	const byId = new Map<string, RawEntry>();
	let leaf: RawEntry | undefined;
	for (const e of entries) {
		if (e.type === "session" || typeof e.id !== "string") continue;
		byId.set(e.id, e);
		leaf = e;
	}
	if (!leaf?.id) return undefined;
	const path: RawEntry[] = [];
	const seen = new Set<string>();
	let cur: RawEntry | undefined = leaf;
	while (cur && cur.id && !seen.has(cur.id)) {
		seen.add(cur.id);
		path.push(cur);
		cur = cur.parentId ? byId.get(cur.parentId) : undefined;
	}
	path.reverse();
	return { branch: path, leafId: leaf.id };
}

export async function loadSession(path: string): Promise<LoadedSession | undefined> {
	try {
		const [text, st] = await Promise.all([readFile(path, "utf8"), stat(path)]);
		const entries = parseJsonl(text);
		const header = entries.find((e) => e.type === "session") as SessionHeader | undefined;
		if (!header || typeof header.id !== "string") return undefined;
		const ab = activeBranch(entries);
		if (!ab) return undefined;
		let lastTs = Date.parse(header.timestamp) || 0;
		for (const e of ab.branch) {
			const t = e.timestamp ? Date.parse(e.timestamp) : NaN;
			if (Number.isFinite(t) && t > lastTs) lastTs = t;
		}
		return { path, header, branch: ab.branch, leafId: ab.leafId, mtimeMs: st.mtimeMs, lastTimestampMs: lastTs };
	} catch {
		return undefined;
	}
}

/** Glob-lite: supports trailing `/**` and `*` segments. */
export function cwdExcluded(cwd: string, patterns: string[]): boolean {
	for (const p of patterns) {
		const re = new RegExp(
			`^${p
				.replace(/[.+^${}()|[\]\\]/g, "\\$&")
				.replace(/\/\*\*$/, "(?:/.*)?")
				.replace(/\*\*/g, ".*")
				.replace(/(?<!\.)\*/g, "[^/]*")}$`,
		);
		if (re.test(cwd)) return true;
	}
	return false;
}

export interface Candidate {
	session: LoadedSession;
	previous?: SessionRecord;
}

export interface DiscoveryResult {
	candidates: Candidate[];
	scanned: number;
	skipped: Record<string, number>;
}

/**
 * Pick sessions eligible for Phase 1 extraction, newest first.
 * Cheap mtime/age checks are done before parsing files.
 */
export async function discoverCandidates(opts: {
	config: RecollectConfig;
	state: State;
	currentSessionFile?: string;
	now?: number;
	/** Ignore idle threshold (manual /memory run). */
	ignoreIdle?: boolean;
	limit: number;
}): Promise<DiscoveryResult> {
	const { config, state } = opts;
	const now = opts.now ?? Date.now();
	const idleMs = opts.ignoreIdle ? 0 : config.minIdleHours * 3_600_000;
	const maxAgeMs = config.maxAgeDays * 86_400_000;
	const skipped: Record<string, number> = {};
	const skip = (k: string) => (skipped[k] = (skipped[k] ?? 0) + 1);

	const files = await listSessionFiles(config.sessionsDir);
	const stats: Array<{ path: string; mtimeMs: number }> = [];
	for (const f of files) {
		if (opts.currentSessionFile && f === opts.currentSessionFile) {
			skip("current");
			continue;
		}
		const st = await stat(f).catch(() => undefined);
		if (!st) continue;
		if (now - st.mtimeMs > maxAgeMs) {
			skip("too_old");
			continue;
		}
		if (now - st.mtimeMs < idleMs) {
			skip("not_idle");
			continue;
		}
		stats.push({ path: f, mtimeMs: st.mtimeMs });
	}
	stats.sort((a, b) => b.mtimeMs - a.mtimeMs);

	const byPath = new Map<string, SessionRecord & { id: string }>();
	for (const [id, rec] of Object.entries(state.sessions)) byPath.set(rec.path, { ...rec, id });

	const candidates: Candidate[] = [];
	for (const s of stats) {
		if (candidates.length >= opts.limit) break;
		const prevByPath = byPath.get(s.path);
		// Fast path: unchanged file already processed.
		if (prevByPath && prevByPath.sourceMtimeMs === s.mtimeMs && prevByPath.status !== "failed") {
			skip("unchanged");
			continue;
		}
		if (prevByPath?.status === "failed" && prevByPath.nextRetryAt && prevByPath.nextRetryAt > now && prevByPath.sourceMtimeMs === s.mtimeMs) {
			skip("backoff");
			continue;
		}
		const session = await loadSession(s.path);
		if (!session) {
			skip("unparseable");
			continue;
		}
		if (cwdExcluded(session.header.cwd, config.excludeCwds)) {
			skip("excluded_cwd");
			continue;
		}
		const previous = state.sessions[session.header.id];
		if (previous && previous.leafId === session.leafId && previous.status !== "failed") {
			skip("unchanged");
			continue;
		}
		if (previous?.status === "failed" && previous.attempts >= 3 && previous.leafId === session.leafId) {
			skip("gave_up");
			continue;
		}
		candidates.push({ session, previous });
	}
	return { candidates, scanned: files.length, skipped };
}
