import { existsSync } from "node:fs";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { ModelRef, RecollectConfig } from "./config.ts";
import { resolveModel, type ResolvedModel } from "./llm.ts";
import { ensureLayout, type Layout } from "./paths.ts";
import { prune, runPhase1 } from "./phase1.ts";
import { runPhase2 } from "./phase2.ts";
import { ensureRepo } from "./git.ts";
import { discoverCandidates } from "./sessions.ts";
import { loadState, saveState, tryAcquireLock, type Logger, type RunRecord } from "./state.ts";

export interface PipelineOptions {
	config: RecollectConfig;
	l: Layout;
	registry: ModelRegistry;
	sessionModel?: Model<Api>;
	currentSessionFile?: string;
	signal: AbortSignal;
	log: Logger;
	trigger: string;
	ignoreIdle?: boolean;
	only?: "phase1" | "phase2";
	forcePhase2?: boolean;
}

export interface PipelineSummary extends RunRecord {
	lockBusy?: boolean;
}

function refOf(m: ResolvedModel): ModelRef {
	return m.ref;
}

/** Never throws. */
export async function runPipeline(o: PipelineOptions): Promise<PipelineSummary> {
	const run: PipelineSummary = { startedAt: Date.now(), trigger: o.trigger, extracted: 0, noop: 0, failed: 0 };
	let lock: Awaited<ReturnType<typeof tryAcquireLock>>;
	try {
		await ensureLayout(o.l);
		lock = await tryAcquireLock(o.l);
	} catch (e: any) {
		run.error = `setup failed: ${e?.message ?? e}`;
		return run;
	}
	if (!lock) {
		run.skippedReason = "another pi process is running the memory pipeline";
		run.lockBusy = true;
		return run;
	}
	const hb = () => lock!.heartbeat();
	try {
		await ensureRepo(o.l.root);
		const state = await loadState(o.l);
		if (state.paused) {
			run.skippedReason = "paused";
			return run;
		}

		await prune({ l: o.l, state, config: o.config, exists: existsSync });

		// ---- Phase 1
		if (o.only !== "phase2") {
			const ex = resolveModel(o.registry, o.config.extract, o.config.fallbackModel, o.sessionModel);
			if (!ex.resolved) {
				run.error = `extract model: ${ex.error}`;
			} else {
				const fb = o.config.fallbackModel ? resolveModel(o.registry, o.config.fallbackModel, undefined, undefined).resolved : undefined;
				const disc = await discoverCandidates({
					config: o.config,
					state,
					currentSessionFile: o.currentSessionFile,
					ignoreIdle: o.ignoreIdle,
					limit: o.config.maxSessionsPerRun,
				});
				o.log("phase1.discovered", { scanned: disc.scanned, candidates: disc.candidates.length, skipped: disc.skipped });
				if (disc.candidates.length) {
					const r = await runPhase1({
						candidates: disc.candidates,
						registry: o.registry,
						model: ex.resolved,
						fallback: fb && fb.ref !== ex.resolved.ref ? fb : undefined,
						config: o.config,
						l: o.l,
						state,
						signal: o.signal,
						log: o.log,
						heartbeat: hb,
					});
					for (const x of r.outcomes) {
						if (x.kind === "succeeded") run.extracted++;
						else if (x.kind === "no_output") run.noop++;
						else run.failed++;
					}
					const failures = r.outcomes.filter((x) => x.kind === "failed");
					if (failures.length && failures.length === r.outcomes.length) {
						run.error = `phase1: all ${failures.length} extractions failed: ${(failures[0] as any).error}`;
					}
				}
				await saveState(o.l, state);
			}
		}
		if (o.signal.aborted) {
			run.error ??= "aborted";
			return run;
		}

		// ---- Phase 2
		if (o.only !== "phase1") {
			const conRef = o.config.consolidate ?? o.config.extract;
			const con = resolveModel(o.registry, conRef, o.config.fallbackModel, o.sessionModel);
			if (!con.resolved) {
				run.phase2 = "failed";
				run.error = `consolidate model: ${con.error}`;
			} else {
				state.phase2.lastAttemptAt = Date.now();
				const ref = { ...refOf(con.resolved), thinking: conRef?.thinking ?? con.resolved.ref.thinking ?? "medium" };
				const r = await runPhase2({ l: o.l, state, config: o.config, model: ref, signal: o.signal, log: o.log, heartbeat: hb, force: o.forcePhase2 });
				run.phase2 = r.status;
				if (r.usage) {
					const u = (state.phase2.usage ??= { input: 0, output: 0, cost: 0 });
					u.input += r.usage.input;
					u.output += r.usage.output;
					u.cost += r.usage.cost;
				}
				if (r.status === "succeeded") {
					state.phase2.lastSuccessAt = Date.now();
					state.phase2.lastError = undefined;
					state.phase2.consecutiveFailures = 0;
				} else if (r.status === "failed") {
					state.phase2.lastError = r.error;
					state.phase2.consecutiveFailures++;
					run.error ??= `phase2: ${r.error}`;
				}
			}
		} else run.phase2 = "not_run";

		run.finishedAt = Date.now();
		state.lastRun = { ...run, lockBusy: undefined } as RunRecord;
		delete (state.lastRun as any).lockBusy;
		await saveState(o.l, state);
		return run;
	} catch (e: any) {
		run.error = String(e?.message ?? e);
		o.log("pipeline.error", { error: run.error, stack: e?.stack });
		try {
			const state = await loadState(o.l);
			run.finishedAt = Date.now();
			state.lastRun = run;
			await saveState(o.l, state);
		} catch {
			// ignore
		}
		return run;
	} finally {
		await lock.release();
	}
}
