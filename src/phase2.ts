import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WORKER_ENV, type ModelRef, type RecollectConfig } from "./config.ts";
import { commitAll, ensureRepo, restorePaths, stagedDiff } from "./git.ts";
import { DIRS, FILES, type Layout } from "./paths.ts";
import { loadPrompt, render } from "./prompts.ts";
import type { Logger, State } from "./state.ts";

const DIFF_MAX_BYTES = 4 * 1024 * 1024;
const RAW_EMPTY = "No raw memories yet.\n";
const SUMMARY_HEADER = "v1\n\n## User Profile";

export interface SelectedInput {
	id: string;
	summaryFile: string;
	score: [number, number];
}

/** Rank eligible memories by usage count, then most recent usage/extraction. */
export function selectInputs(state: State, config: RecollectConfig, now = Date.now()): SelectedInput[] {
	const cutoff = now - config.maxUnusedDays * 86_400_000;
	const out: SelectedInput[] = [];
	for (const [id, rec] of Object.entries(state.sessions)) {
		if (rec.status !== "succeeded" || !rec.summaryFile) continue;
		const last = rec.lastUsageAt ?? rec.extractedAt;
		if (last < cutoff) continue;
		out.push({ id, summaryFile: rec.summaryFile, score: [rec.usageCount ?? 0, last] });
	}
	out.sort((a, b) => b.score[0] - a.score[0] || b.score[1] - a.score[1]);
	return out.slice(0, config.maxRawForConsolidation);
}

/** Write raw_memories.md + session_summaries/ to match the selection exactly. */
export async function syncArtifacts(l: Layout, selected: SelectedInput[]): Promise<void> {
	const byId = [...selected].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	const parts: string[] = [];
	const wanted = new Set<string>();
	for (const s of byId) {
		const raw = await readFile(join(l.stateRawDir, `${s.id}.md`), "utf8").catch(() => undefined);
		const sum = await readFile(join(l.stateSummariesDir, `${s.id}.md`), "utf8").catch(() => undefined);
		if (raw === undefined || sum === undefined) continue;
		parts.push(`<!-- session_id: ${s.id} | session_summary_file: ${DIRS.summaries}/${s.summaryFile} -->\n${raw.trim()}\n`);
		wanted.add(s.summaryFile);
		const target = join(l.summariesDir, s.summaryFile);
		const existing = await readFile(target, "utf8").catch(() => undefined);
		if (existing !== sum) await writeFile(target, sum);
	}
	await writeFile(l.raw, parts.length ? `# Raw memories\n\n${parts.join("\n")}` : RAW_EMPTY);
	for (const f of await readdir(l.summariesDir).catch(() => [] as string[])) {
		if (f.endsWith(".md") && !wanted.has(f)) await rm(join(l.summariesDir, f), { force: true });
	}
}

export function validateSummary(text: string, maxBytes: number): string | undefined {
	if (!text.startsWith(SUMMARY_HEADER)) return `memory_summary.md must start with "v1\\n\\n## User Profile"`;
	const bytes = Buffer.byteLength(text);
	if (bytes > Math.floor(maxBytes * 1.15)) return `memory_summary.md is ${bytes} bytes (limit ${maxBytes})`;
	return undefined;
}

// ---------------------------------------------------------------------------
// Worker process

export interface WorkerResult {
	code: number;
	error?: string;
	usage: { input: number; output: number; cost: number };
	lastText: string;
	stderr: string;
}

const GUARD_PATH = join(dirname(fileURLToPath(import.meta.url)), "worker-guard.ts");

export function runWorker(opts: {
	config: RecollectConfig;
	model: ModelRef;
	cwd: string;
	systemPromptFile: string;
	task: string;
	signal: AbortSignal;
	timeoutMs: number;
	heartbeat: () => Promise<void>;
	log: Logger;
}): Promise<WorkerResult> {
	const modelArg = `${opts.model.provider}/${opts.model.id}`;
	const args = [
		"-p",
		"--mode",
		"json",
		"--no-session",
		"--no-extensions",
		"-e",
		GUARD_PATH,
		"--no-skills",
		"--no-context-files",
		"--no-prompt-templates",
		"--no-mcp",
		"--no-approve",
		"--tools",
		"read,edit,write,grep,find,ls",
		"--provider",
		opts.model.provider,
		"--model",
		opts.model.id,
		"--thinking",
		opts.model.thinking ?? "medium",
		"--system-prompt",
		opts.systemPromptFile,
		opts.task,
	];
	opts.log("phase2.worker_start", { model: modelArg, cwd: opts.cwd });
	return new Promise((resolve) => {
		const usage = { input: 0, output: 0, cost: 0 };
		let lastText = "";
		let stderr = "";
		let error: string | undefined;
		let settled = false;
		const proc = spawn(opts.config.piCommand, args, {
			cwd: opts.cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, [WORKER_ENV]: "1", PI_RECOLLECT_ROOT: opts.cwd },
		});
		let buf = "";
		const onLine = (line: string) => {
			if (!line.trim()) return;
			let ev: any;
			try {
				ev = JSON.parse(line);
			} catch {
				return;
			}
			if (ev.type === "message_end" && ev.message?.role === "assistant") {
				const m = ev.message;
				usage.input += m.usage?.input ?? 0;
				usage.output += m.usage?.output ?? 0;
				usage.cost += m.usage?.cost?.total ?? 0;
				const t = (m.content ?? [])
					.filter((c: any) => c.type === "text")
					.map((c: any) => c.text)
					.join("");
				if (t) lastText = t;
				if (m.stopReason === "error") error = m.errorMessage ?? "worker model error";
			}
		};
		proc.stdout.on("data", (d) => {
			buf += d.toString();
			const lines = buf.split("\n");
			buf = lines.pop() ?? "";
			for (const l of lines) onLine(l);
		});
		proc.stderr.on("data", (d) => {
			stderr = (stderr + d.toString()).slice(-8_000);
		});
		const hb = setInterval(() => void opts.heartbeat(), 60_000);
		const kill = (why: string) => {
			if (settled) return;
			error ??= why;
			proc.kill("SIGTERM");
			setTimeout(() => {
				if (!settled) proc.kill("SIGKILL");
			}, 5_000).unref();
		};
		const timer = setTimeout(() => kill(`worker timed out after ${Math.round(opts.timeoutMs / 60_000)} min`), opts.timeoutMs);
		const onAbort = () => kill("aborted");
		if (opts.signal.aborted) onAbort();
		else opts.signal.addEventListener("abort", onAbort, { once: true });
		const finish = (code: number) => {
			if (settled) return;
			settled = true;
			clearInterval(hb);
			clearTimeout(timer);
			opts.signal.removeEventListener("abort", onAbort);
			if (buf.trim()) onLine(buf);
			if (code !== 0 && !error) error = `worker exited with code ${code}: ${stderr.trim().split("\n").slice(-3).join(" | ")}`;
			resolve({ code, error, usage, lastText, stderr });
		};
		proc.on("close", (code) => finish(code ?? 1));
		proc.on("error", (e) => {
			error = `failed to spawn ${opts.config.piCommand}: ${e.message}`;
			finish(127);
		});
	});
}

// ---------------------------------------------------------------------------

export type Phase2Status = "skipped_no_changes" | "skipped_batch" | "succeeded" | "failed";

export interface Phase2Result {
	status: Phase2Status;
	error?: string;
	changedFiles?: string[];
	usage?: { input: number; output: number; cost: number };
}

const AGENT_OWNED = [FILES.handbook, FILES.summary];

export async function runPhase2(opts: {
	l: Layout;
	state: State;
	config: RecollectConfig;
	model: ModelRef;
	signal: AbortSignal;
	log: Logger;
	heartbeat: () => Promise<void>;
	force?: boolean;
	now?: number;
}): Promise<Phase2Result> {
	const { l, state, config } = opts;
	const now = opts.now ?? Date.now();
	await ensureRepo(l.root);

	const selected = selectInputs(state, config, now);
	await syncArtifacts(l, selected);
	await rm(l.diff, { force: true });
	const { diff, changedFiles, truncated } = await stagedDiff(l.root, DIFF_MAX_BYTES);
	const summaryMissing = !existsSync(l.summary);

	if (changedFiles.length === 0 && !summaryMissing) {
		state.phase2.pendingSessionIds = [];
		state.phase2.firstPendingAt = undefined;
		return { status: "skipped_no_changes" };
	}
	if (changedFiles.length === 0 && summaryMissing && selected.length === 0) {
		return { status: "skipped_no_changes" };
	}

	// Batch gate: wait for enough new inputs unless notes changed, forced, or the oldest pending input is old.
	const notesChanged = changedFiles.some((f) => f.split("\t").pop()!.startsWith(`${DIRS.notes}/`));
	const pending = state.phase2.pendingSessionIds.length;
	const stale = state.phase2.firstPendingAt !== undefined && now - state.phase2.firstPendingAt > 24 * 3_600_000;
	if (!opts.force && !notesChanged && !stale && pending > 0 && pending < config.minNewInputs) {
		return { status: "skipped_batch", changedFiles };
	}

	const header = [
		"# Memory workspace diff",
		"",
		"Changed files since the previous successful consolidation (git name-status, A=added M=modified D=deleted):",
		"",
		...changedFiles.map((f) => `- ${f.replace("\t", " ")}`),
		"",
		truncated ? "NOTE: the diff below is truncated." : "",
		"```diff",
		diff,
		"```",
		"",
	].join("\n");
	await writeFile(l.diff, header);

	const mode = summaryMissing || !existsSync(l.handbook) ? "INIT" : "INCREMENTAL UPDATE";
	const systemPrompt = render(loadPrompt("consolidation"), {
		memory_root: l.root,
		phase2_workspace_diff_file: FILES.diff,
		summary_max_bytes: config.summaryMaxBytes,
	});
	const promptFile = join(l.stateDir, "consolidation.prompt.md");
	await writeFile(promptFile, systemPrompt);
	const task = [
		`Run memory consolidation now. Mode hint: ${mode}.`,
		`Memory root (your cwd): ${l.root}`,
		`Start by reading ${FILES.diff}, then follow the workflow in your instructions.`,
		`You may only create or edit ${FILES.handbook} and ${FILES.summary}.`,
		`memory_summary.md must start with "v1" followed by a blank line and "## User Profile", and must be at most ${config.summaryMaxBytes} bytes.`,
		"When finished, reply with one short line describing what changed.",
	].join("\n");

	const usage = { input: 0, output: 0, cost: 0 };
	const fail = async (error: string): Promise<Phase2Result> => {
		// Roll back agent-owned files; keep synced inputs staged-but-uncommitted so the next run retries.
		await restorePaths(l.root, AGENT_OWNED).catch(() => {});
		await rm(l.diff, { force: true });
		opts.log("phase2.failed", { error });
		return { status: "failed", error, changedFiles, usage };
	};

	const timeoutMs = config.phase2TimeoutMinutes * 60_000;
	let res = await runWorker({ config, model: opts.model, cwd: l.root, systemPromptFile: promptFile, task, signal: opts.signal, timeoutMs, heartbeat: opts.heartbeat, log: opts.log });
	addUsage(usage, res.usage);
	if (res.error) return fail(res.error);

	// Validate; one repair pass if needed.
	let summary = await readFile(l.summary, "utf8").catch(() => "");
	let handbookOk = existsSync(l.handbook);
	let problem = !handbookOk ? "MEMORY.md is missing" : validateSummary(summary, config.summaryMaxBytes);
	if (problem && !opts.signal.aborted) {
		opts.log("phase2.repair", { problem });
		const repairTask = [
			`The consolidation output failed validation: ${problem}.`,
			`Fix it now. Only edit ${FILES.handbook} and ${FILES.summary} in ${l.root}.`,
			`memory_summary.md must start exactly with "v1", a blank line, then "## User Profile", and be at most ${config.summaryMaxBytes} bytes total.`,
			"If it is too large: compact `## What's in Memory` first (merge low-signal topics, shorten older topics), then `## General Tips`. Keep every scope heading's (cwd=...) handle.",
			"Reply with one short line when done.",
		].join("\n");
		res = await runWorker({ config, model: opts.model, cwd: l.root, systemPromptFile: promptFile, task: repairTask, signal: opts.signal, timeoutMs: Math.min(timeoutMs, 10 * 60_000), heartbeat: opts.heartbeat, log: opts.log });
		addUsage(usage, res.usage);
		if (res.error) return fail(res.error);
		summary = await readFile(l.summary, "utf8").catch(() => "");
		handbookOk = existsSync(l.handbook);
		problem = !handbookOk ? "MEMORY.md is missing" : validateSummary(summary, config.summaryMaxBytes);
	}
	if (problem) return fail(problem);

	// Make sure the worker did not touch inputs (worker-guard should already prevent this).
	await rm(l.diff, { force: true });
	const after = await stagedDiff(l.root, 1024);
	const touched = after.changedFiles
		.map((f) => f.split("\t").pop()!)
		.filter((p) => !AGENT_OWNED.includes(p as any) && !changedFiles.some((c) => c.split("\t").pop() === p));
	if (touched.length) {
		await restorePaths(l.root, touched).catch(() => {});
		opts.log("phase2.reverted_unexpected", { touched });
	}

	const commit = await commitAll(l.root, `consolidate: ${selected.length} inputs, ${changedFiles.length} changed files`);
	state.phase2.baselineCommit = commit;
	state.phase2.pendingSessionIds = [];
	state.phase2.firstPendingAt = undefined;
	opts.log("phase2.succeeded", { commit, usage });
	return { status: "succeeded", changedFiles, usage };
}

function addUsage(a: { input: number; output: number; cost: number }, b: { input: number; output: number; cost: number }) {
	a.input += b.input;
	a.output += b.output;
	a.cost += b.cost;
}
