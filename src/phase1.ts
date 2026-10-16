import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { RecollectConfig } from "./config.ts";
import { completeText, extractJsonObject, type ResolvedModel } from "./llm.ts";
import type { Layout } from "./paths.ts";
import { loadPrompt, render } from "./prompts.ts";
import { redactSecrets } from "./redact.ts";
import { serializeBranch } from "./serialize.ts";
import type { Candidate } from "./sessions.ts";
import type { Logger, SessionRecord, State } from "./state.ts";

export interface Phase1Output {
	raw_memory: string;
	session_summary: string;
	session_slug: string;
}

export type Phase1Outcome =
	| { kind: "succeeded"; sessionId: string; slug: string }
	| { kind: "no_output"; sessionId: string; reason: string }
	| { kind: "failed"; sessionId: string; error: string };

const RETRY_BACKOFF_MS = [3_600_000, 4 * 3_600_000, 24 * 3_600_000];

export function slugify(s: string): string {
	return (
		s
			.toLowerCase()
			.replace(/[^a-z0-9_-]+/g, "_")
			.replace(/_+/g, "_")
			.replace(/^[_-]+|[_-]+$/g, "")
			.slice(0, 60) || "session"
	);
}

/** File name for the session summary in session_summaries/: <ts>-<id4>-<slug>.md */
export function summaryFileName(createdIso: string, sessionId: string, slug: string): string {
	const ts = (createdIso || new Date(0).toISOString()).replace(/\.\d+Z$/, "").replace(/:/g, "-");
	const short = sessionId.replace(/-/g, "").slice(-4);
	return `${ts}-${short}-${slugify(slug)}.md`;
}

export function parsePhase1Output(text: string): Phase1Output | undefined {
	const o = extractJsonObject(text);
	if (!o) return undefined;
	const pick = (...keys: string[]) => {
		for (const k of keys) if (typeof o[k] === "string") return o[k] as string;
		return undefined;
	};
	const raw = pick("raw_memory");
	const summary = pick("session_summary", "rollout_summary");
	const slug = pick("session_slug", "rollout_slug") ?? "";
	if (raw === undefined || summary === undefined) return undefined;
	return { raw_memory: raw, session_summary: summary, session_slug: slug };
}

/** Insert deterministic provenance fields into the raw_memory frontmatter. */
export function stampRawMemory(raw: string, meta: Record<string, string>): string {
	const body = raw.trim();
	const lines = Object.entries(meta).map(([k, v]) => `${k}: ${v}`);
	const fm = /^---\s*\n([\s\S]*?)\n\s*---\s*\n?/.exec(body);
	if (fm) {
		const kept = fm[1]!
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l && !Object.keys(meta).some((k) => l.startsWith(`${k}:`)));
		return `---\n${[...lines, ...kept].join("\n")}\n---\n${body.slice(fm[0].length).trimStart()}\n`;
	}
	return `---\n${lines.join("\n")}\n---\n${body}\n`;
}

async function extractOne(opts: {
	cand: Candidate;
	registry: ModelRegistry;
	model: ResolvedModel;
	fallback?: ResolvedModel;
	config: RecollectConfig;
	l: Layout;
	signal: AbortSignal;
	log: Logger;
	usage: { input: number; output: number; cost: number };
}): Promise<{ outcome: Phase1Outcome; output?: Phase1Output; summaryFile?: string }> {
	const { cand, config, l } = opts;
	const s = cand.session;
	const id = s.header.id;
	const ctxWindow = opts.model.model.contextWindow || 0;
	const tokenLimit = ctxWindow > 0 ? Math.min(Math.floor(ctxWindow * 0.7) - 12_000, 150_000) : 100_000;
	const ser = serializeBranch(s.branch, Math.max(tokenLimit, 8_000));

	if (ser.userMessages === 0) return { outcome: { kind: "no_output", sessionId: id, reason: "no user messages" } };
	if (ser.totalChars < config.minSessionChars) {
		return { outcome: { kind: "no_output", sessionId: id, reason: `too small (${ser.totalChars} chars)` } };
	}

	const updatedAt = new Date(s.lastTimestampMs).toISOString();
	const user = render(loadPrompt("stage_one_input"), {
		session_id: id,
		session_path: s.path,
		session_cwd: s.header.cwd || "unknown",
		session_updated_at: updatedAt,
		transcript: ser.text,
	});
	const system = loadPrompt("stage_one_system");

	const call = async (m: ResolvedModel, extra = "") => {
		const r = await completeText({
			registry: opts.registry,
			model: m.model,
			systemPrompt: system,
			user: user + extra,
			thinking: m.ref.thinking ?? "low",
			signal: opts.signal,
		});
		opts.usage.input += r.usage.input;
		opts.usage.output += r.usage.output;
		opts.usage.cost += r.usage.cost;
		return r.text;
	};

	let parsed: Phase1Output | undefined;
	let lastErr = "";
	const models = [opts.model, ...(opts.fallback ? [opts.fallback] : [])];
	outer: for (const m of models) {
		for (let attempt = 0; attempt < 2; attempt++) {
			if (opts.signal.aborted) throw new Error("aborted");
			try {
				const text = await call(
					m,
					attempt > 0
						? "\n\nYour previous reply was not a valid JSON object. Return ONLY the JSON object with keys session_summary, session_slug, raw_memory."
						: "",
				);
				parsed = parsePhase1Output(text);
				if (parsed) break outer;
				lastErr = `invalid JSON output (${text.slice(0, 120).replace(/\s+/g, " ")})`;
			} catch (e: any) {
				lastErr = String(e?.message ?? e);
				if (opts.signal.aborted) throw e;
				break; // stream/provider error: go to fallback model
			}
		}
	}
	if (!parsed) return { outcome: { kind: "failed", sessionId: id, error: lastErr || "unknown" } };

	if (!parsed.raw_memory.trim() && !parsed.session_summary.trim()) {
		return { outcome: { kind: "no_output", sessionId: id, reason: "model no-op" } };
	}

	const slug = slugify(parsed.session_slug || "session");
	const meta = {
		session_id: id,
		session_path: s.path,
		updated_at: updatedAt,
	};
	const raw = redactSecrets(stampRawMemory(parsed.raw_memory || "(no raw memory)", { ...meta, cwd: s.header.cwd || "unknown" }));
	const summaryFile = summaryFileName(s.header.timestamp, id, slug);
	const summary = redactSecrets(
		`session_id: ${id}\nsession_path: ${s.path}\ncwd: ${s.header.cwd || "unknown"}\nupdated_at: ${updatedAt}\n\n${parsed.session_summary.trim()}\n`,
	);
	await mkdir(l.stateRawDir, { recursive: true });
	await mkdir(l.stateSummariesDir, { recursive: true });
	await writeFile(join(l.stateRawDir, `${id}.md`), raw);
	await writeFile(join(l.stateSummariesDir, `${id}.md`), summary);
	opts.log("phase1.extracted", { id, slug, chars: ser.totalChars, omitted: ser.omittedRows });
	return { outcome: { kind: "succeeded", sessionId: id, slug }, output: parsed, summaryFile };
}

export interface Phase1Result {
	outcomes: Phase1Outcome[];
	usage: { input: number; output: number; cost: number };
}

export async function runPhase1(opts: {
	candidates: Candidate[];
	registry: ModelRegistry;
	model: ResolvedModel;
	fallback?: ResolvedModel;
	config: RecollectConfig;
	l: Layout;
	state: State;
	signal: AbortSignal;
	log: Logger;
	heartbeat: () => Promise<void>;
}): Promise<Phase1Result> {
	const usage = { input: 0, output: 0, cost: 0 };
	const outcomes: Phase1Outcome[] = [];
	const queue = [...opts.candidates];
	const worker = async () => {
		while (queue.length && !opts.signal.aborted) {
			const cand = queue.shift()!;
			const id = cand.session.header.id;
			let res: Awaited<ReturnType<typeof extractOne>>;
			try {
				res = await extractOne({ ...opts, cand, usage });
			} catch (e: any) {
				if (opts.signal.aborted) return;
				res = { outcome: { kind: "failed", sessionId: id, error: String(e?.message ?? e) } };
			}
			await opts.heartbeat();
			outcomes.push(res.outcome);
			const prev = opts.state.sessions[id];
			const now = Date.now();
			const base: SessionRecord = {
				path: cand.session.path,
				cwd: cand.session.header.cwd,
				leafId: cand.session.leafId,
				sourceMtimeMs: cand.session.mtimeMs,
				status: res.outcome.kind,
				attempts: 0,
				extractedAt: now,
				updatedAt: new Date(cand.session.lastTimestampMs).toISOString(),
				usageCount: prev?.usageCount ?? 0,
				lastUsageAt: prev?.lastUsageAt,
			};
			if (res.outcome.kind === "succeeded") {
				base.slug = res.outcome.slug;
				base.summaryFile = res.summaryFile;
				if (!opts.state.phase2.pendingSessionIds.includes(id)) opts.state.phase2.pendingSessionIds.push(id);
				opts.state.phase2.firstPendingAt ??= now;
			} else if (res.outcome.kind === "no_output") {
				// A session that previously produced memory but now yields nothing keeps its old raw memory.
				if (prev?.status === "succeeded") {
					base.status = "succeeded";
					base.slug = prev.slug;
					base.summaryFile = prev.summaryFile;
				}
			} else {
				const attempts = (prev?.leafId === cand.session.leafId ? prev.attempts : 0) + 1;
				base.attempts = attempts;
				base.lastError = res.outcome.error;
				base.nextRetryAt = now + RETRY_BACKOFF_MS[Math.min(attempts - 1, RETRY_BACKOFF_MS.length - 1)]!;
				if (prev?.status === "succeeded") {
					// keep previous good memory selectable; record failure on the side
					base.status = "succeeded";
					base.slug = prev.slug;
					base.summaryFile = prev.summaryFile;
				}
				opts.log("phase1.failed", { id, error: res.outcome.error, attempts });
			}
			opts.state.sessions[id] = base;
		}
	};
	await Promise.all(Array.from({ length: Math.max(1, opts.config.extractConcurrency) }, worker));
	return { outcomes, usage };
}

/** Drop state + raw files for sessions whose source file no longer exists or that fell out of the retention window. */
export async function prune(opts: { l: Layout; state: State; config: RecollectConfig; exists: (p: string) => boolean; now?: number }) {
	const now = opts.now ?? Date.now();
	const keepMs = Math.max(opts.config.maxUnusedDays, opts.config.maxAgeDays) * 86_400_000 * 3;
	const removed: string[] = [];
	for (const [id, rec] of Object.entries(opts.state.sessions)) {
		const lastTouch = Math.max(rec.lastUsageAt ?? 0, rec.extractedAt);
		if (!opts.exists(rec.path) || now - lastTouch > keepMs) {
			delete opts.state.sessions[id];
			removed.push(id);
		}
	}
	const known = new Set(Object.keys(opts.state.sessions));
	for (const dir of [opts.l.stateRawDir, opts.l.stateSummariesDir]) {
		const files = await readdir(dir).catch(() => [] as string[]);
		for (const f of files) {
			const id = f.replace(/\.md$/, "");
			if (!known.has(id)) await rm(join(dir, f), { force: true });
		}
	}
	opts.state.phase2.pendingSessionIds = opts.state.phase2.pendingSessionIds.filter((id) => known.has(id));
	return removed;
}
