import { existsSync } from "node:fs";
import { appendFile, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Layout } from "./paths.ts";

export type SessionStatus = "succeeded" | "no_output" | "failed";

export interface SessionRecord {
	path: string;
	cwd: string;
	leafId: string;
	sourceMtimeMs: number;
	status: SessionStatus;
	attempts: number;
	nextRetryAt?: number;
	extractedAt: number;
	/** ISO timestamp of the last entry in the extracted branch. */
	updatedAt: string;
	slug?: string;
	summaryFile?: string;
	usageCount: number;
	lastUsageAt?: number;
	lastError?: string;
}

export interface RunRecord {
	startedAt: number;
	finishedAt?: number;
	trigger: string;
	extracted: number;
	noop: number;
	failed: number;
	skippedReason?: string;
	phase2?: "skipped_no_changes" | "skipped_batch" | "succeeded" | "failed" | "not_run";
	error?: string;
}

export interface State {
	version: 1;
	sessions: Record<string, SessionRecord>;
	phase2: {
		lastSuccessAt?: number;
		lastAttemptAt?: number;
		lastError?: string;
		consecutiveFailures: number;
		baselineCommit?: string;
		/** Session ids whose raw memory changed since the last successful Phase 2. */
		pendingSessionIds: string[];
		firstPendingAt?: number;
		usage?: { input: number; output: number; cost: number };
	};
	lastRun?: RunRecord;
	paused?: boolean;
}

export function emptyState(): State {
	return { version: 1, sessions: {}, phase2: { consecutiveFailures: 0, pendingSessionIds: [] } };
}

export async function loadState(l: Layout): Promise<State> {
	try {
		const raw = JSON.parse(await readFile(l.stateFile, "utf8"));
		if (raw && raw.version === 1 && typeof raw.sessions === "object") {
			const s = raw as State;
			s.phase2 ??= { consecutiveFailures: 0, pendingSessionIds: [] };
			s.phase2.pendingSessionIds ??= [];
			s.phase2.consecutiveFailures ??= 0;
			return s;
		}
	} catch {
		// missing or corrupt -> start fresh (raw files on disk remain the source for Phase 2)
	}
	return emptyState();
}

export async function saveState(l: Layout, s: State): Promise<void> {
	await mkdir(dirname(l.stateFile), { recursive: true });
	const tmp = `${l.stateFile}.${process.pid}.tmp`;
	await writeFile(tmp, JSON.stringify(s, null, 2));
	await rename(tmp, l.stateFile);
}

/** Load, mutate, save. Small critical section; callers already hold the pipeline lock or accept last-writer-wins for usage counters. */
export async function updateState(l: Layout, fn: (s: State) => void): Promise<State> {
	const s = await loadState(l);
	fn(s);
	await saveState(l, s);
	return s;
}

// ---------------------------------------------------------------------------
// Cross-process lock: a file holding {pid, heartbeatAt}. Stale after `staleMs`.

export interface Lock {
	heartbeat(): Promise<void>;
	release(): Promise<void>;
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e: any) {
		return e?.code === "EPERM";
	}
}

export async function tryAcquireLock(l: Layout, staleMs = 10 * 60_000): Promise<Lock | undefined> {
	await mkdir(dirname(l.lockFile), { recursive: true });
	const body = () => JSON.stringify({ pid: process.pid, heartbeatAt: Date.now() });
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fh = await open(l.lockFile, "wx");
			await fh.writeFile(body());
			await fh.close();
			let released = false;
			return {
				heartbeat: async () => {
					if (!released) await writeFile(l.lockFile, body()).catch(() => {});
				},
				release: async () => {
					released = true;
					await rm(l.lockFile, { force: true }).catch(() => {});
				},
			};
		} catch (e: any) {
			if (e?.code !== "EEXIST") throw e;
			// Inspect the existing lock; take over if stale.
			let stale = false;
			try {
				const info = JSON.parse(await readFile(l.lockFile, "utf8"));
				const age = Date.now() - Number(info.heartbeatAt ?? 0);
				stale = age > staleMs || !pidAlive(Number(info.pid));
			} catch {
				const st = await stat(l.lockFile).catch(() => undefined);
				stale = !st || Date.now() - st.mtimeMs > staleMs;
			}
			if (!stale) return undefined;
			await rm(l.lockFile, { force: true }).catch(() => {});
		}
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Debug log

export function makeLogger(l: Layout, enabled: boolean) {
	return (event: string, data: Record<string, unknown> = {}) => {
		if (!enabled) return;
		const line = JSON.stringify({ t: new Date().toISOString(), pid: process.pid, event, ...data });
		void appendFile(l.logFile, `${line}\n`).catch(() => {});
	};
}
export type Logger = ReturnType<typeof makeLogger>;

export function lockExists(l: Layout): boolean {
	return existsSync(l.lockFile);
}
