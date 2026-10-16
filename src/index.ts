import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { modelRefString, resolveConfig, SETTINGS_KEY, WORKER_ENV, type RecollectConfig } from "./config.ts";
import { layout, type Layout } from "./paths.ts";
import { slugify } from "./phase1.ts";
import { runPipeline, type PipelineSummary } from "./pipeline.ts";
import { buildMemorySection } from "./read-path.ts";
import { loadState, lockExists, makeLogger, updateState } from "./state.ts";
import { applyUsage, usedSummaryFiles } from "./usage.ts";

const STATUS_KEY = "recollect";

function noteTimestamp(d = new Date()): string {
	return d.toISOString().replace(/\.\d+Z$/, "").replace(/:/g, "-");
}

export default function recollect(pi: ExtensionAPI) {
	// Never run inside our own consolidation worker.
	if (process.env[WORKER_ENV] === "1") return;

	let config: RecollectConfig | undefined;
	let configErrors: string[] = [];
	let l: Layout | undefined;
	let section: string | undefined;
	let abort: AbortController | undefined;
	let running: Promise<PipelineSummary> | undefined;
	let startupTimer: NodeJS.Timeout | undefined;
	const pendingUsage: string[] = [];

	const loadConfig = () => {
		const r = resolveConfig((pi.getSettings() as Record<string, unknown>)[SETTINGS_KEY]);
		config = r.config;
		configErrors = r.errors;
		l = layout(config.root);
		return config;
	};

	const refreshSection = async (cwd: string) => {
		if (!config || !l || !config.enabled || !config.use) {
			section = undefined;
			return;
		}
		section = await buildMemorySection({ root: l.root, summaryPath: l.summary, cwd, maxTokens: config.summaryMaxTokens }).catch(
			() => undefined,
		);
	};

	const launch = (ctx: ExtensionContext, trigger: string, extra: { ignoreIdle?: boolean; only?: "phase1" | "phase2"; forcePhase2?: boolean } = {}) => {
		if (!config || !l || running) return running;
		const cfg = config;
		const lay = l;
		// Capture plain data only: ctx must not be used after the session is replaced.
		const registry = ctx.modelRegistry;
		const sessionModel = ctx.model;
		const currentSessionFile = ctx.sessionManager.getSessionFile();
		const hasUI = ctx.hasUI;
		const ui = ctx.ui;
		abort = new AbortController();
		const log = makeLogger(lay, cfg.debugLog);
		log("pipeline.start", { trigger });
		running = runPipeline({
			config: cfg,
			l: lay,
			registry,
			sessionModel,
			currentSessionFile,
			signal: abort.signal,
			log,
			trigger,
			...extra,
		})
			.then(async (r) => {
				log("pipeline.end", { ...r });
				if (hasUI && !abort?.signal.aborted) {
					try {
						const st = await loadState(lay);
						const fails = st.phase2.consecutiveFailures;
						if (r.error && (fails >= 3 || (r.failed > 0 && r.extracted === 0 && r.failed >= 3))) {
							ui.setStatus(STATUS_KEY, "⚠ memory: background run failing (/memory status)");
						} else ui.setStatus(STATUS_KEY, undefined);
					} catch {
						// stale ui after session replacement; ignore
					}
				}
				return r;
			})
			.catch((e) => ({ startedAt: Date.now(), trigger, extracted: 0, noop: 0, failed: 0, error: String(e) }) as PipelineSummary)
			.finally(() => {
				running = undefined;
				abort = undefined;
			});
		return running;
	};

	const flushUsage = async () => {
		if (!l || pendingUsage.length === 0) return;
		const files = pendingUsage.splice(0);
		await updateState(l, (s) => void applyUsage(s, files)).catch(() => {});
	};

	// -------------------------------------------------------------------------
	pi.on("session_start", async (event, ctx) => {
		loadConfig();
		if (!config!.enabled) return;
		await refreshSection(ctx.cwd);
		if (event.reason === "startup" && config!.generate) {
			startupTimer = setTimeout(() => {
				startupTimer = undefined;
				try {
					launch(ctx, "startup");
				} catch {
					// ctx may be stale; ignore
				}
			}, config!.startupDelaySeconds * 1000);
			startupTimer.unref?.();
		}
	});

	pi.on("before_agent_start", (event) => {
		if (!section) return;
		event.systemPromptOptions.sections.memory = section;
	});

	pi.on("tool_result", (event, ctx) => {
		if (!l) return;
		const text = event.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n");
		const files = usedSummaryFiles({
			root: l.root,
			cwd: ctx.cwd,
			toolName: event.toolName,
			input: (event.input ?? {}) as Record<string, unknown>,
			resultText: text.slice(0, 200_000),
		});
		if (files.length) pendingUsage.push(...files);
	});

	pi.on("agent_settled", async () => {
		await flushUsage();
	});

	pi.on("session_shutdown", async () => {
		if (startupTimer) clearTimeout(startupTimer);
		startupTimer = undefined;
		abort?.abort();
		await flushUsage();
		if (running) await Promise.race([running, new Promise((r) => setTimeout(r, 3_000))]);
	});

	// -------------------------------------------------------------------------
	const sub = ["status", "run", "remember", "forget", "pause", "resume", "reload"];
	pi.registerCommand("memory", {
		description: "Background cross-session memory: status | run [phase1|phase2] | remember <text> | forget <text> | pause | resume | reload",
		getArgumentCompletions: (prefix) => {
			const items = sub.filter((s) => s.startsWith(prefix.trim())).map((s) => ({ value: s, label: s }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			if (!config) loadConfig();
			const cfg = config!;
			const lay = l!;
			const [cmd = "status", ...rest] = args.trim().split(/\s+/);
			const text = args.trim().slice(cmd.length).trim();
			const say = (msg: string, type: "info" | "warning" | "error" = "info") => {
				if (ctx.hasUI) ctx.ui.notify(msg, type);
				else process.stdout.write(`${msg}\n`);
			};

			switch (cmd) {
				case "status": {
					say(await statusText(cfg, lay, configErrors, !!running));
					return;
				}
				case "run": {
					if (running) return say("memory pipeline is already running");
					const only = rest[0] === "phase1" || rest[0] === "phase2" ? (rest[0] as "phase1" | "phase2") : undefined;
					say(`memory: running ${only ?? "pipeline"} in background…`);
					const r = await launch(ctx, "manual", { ignoreIdle: true, only, forcePhase2: true });
					if (!r) return;
					const parts = [`extracted ${r.extracted}`, `no-op ${r.noop}`, `failed ${r.failed}`, `phase2 ${r.phase2 ?? "-"}`];
					if (r.skippedReason) parts.push(`skipped: ${r.skippedReason}`);
					say(`memory run done: ${parts.join(", ")}${r.error ? `\nerror: ${r.error}` : ""}`, r.error ? "warning" : "info");
					return;
				}
				case "remember":
				case "forget": {
					if (!text) return say(`usage: /memory ${cmd} <text>`, "warning");
					await mkdir(lay.notesDir, { recursive: true });
					const file = join(lay.notesDir, `${noteTimestamp()}-${slugify(text.slice(0, 40))}.md`);
					const body =
						cmd === "remember"
							? `# Remember (user request)\n\n${text}\n`
							: `# Forget / correct (user request)\n\nRemove or correct any memory about the following:\n\n${text}\n`;
					await writeFile(file, body);
					say(`memory note saved; it will be applied on the next consolidation (/memory run phase2 to apply now)`);
					return;
				}
				case "pause":
				case "resume": {
					await updateState(lay, (s) => void (s.paused = cmd === "pause"));
					say(`memory background pipeline ${cmd === "pause" ? "paused" : "resumed"}`);
					return;
				}
				case "reload": {
					loadConfig();
					await refreshSection(ctx.cwd);
					say(section ? `memory section reloaded (${section.length} chars)` : "no memory summary to inject");
					return;
				}
				default:
					say(`unknown subcommand "${cmd}". Use: ${sub.join(" | ")}`, "warning");
			}
		},
	});
}

async function statusText(cfg: RecollectConfig, l: Layout, errors: string[], running: boolean): Promise<string> {
	const st = await loadState(l);
	const recs = Object.values(st.sessions);
	const count = (s: string) => recs.filter((r) => r.status === s).length;
	const failing = recs.filter((r) => r.lastError);
	const summarySize = await stat(l.summary).then((s) => s.size).catch(() => 0);
	const notes = await readdir(l.notesDir).catch(() => [] as string[]);
	const fmt = (t?: number) => (t ? new Date(t).toLocaleString() : "never");
	const lr = st.lastRun;
	const lines = [
		`pi-recollect — ${cfg.enabled ? "enabled" : "disabled"}${st.paused ? " (paused)" : ""}${running ? " — running now" : ""}${lockExists(l) && !running ? " — locked by another process" : ""}`,
		`root: ${l.root}`,
		`models: extract=${modelRefString(cfg.extract)} consolidate=${modelRefString(cfg.consolidate ?? cfg.extract)}${cfg.fallbackModel ? ` fallback=${modelRefString(cfg.fallbackModel)}` : ""}`,
		`sessions: ${count("succeeded")} with memory, ${count("no_output")} no-op, ${count("failed")} failed${failing.length ? ` (${failing.length} with errors)` : ""}`,
		`pending for consolidation: ${st.phase2.pendingSessionIds.length}; notes: ${notes.filter((n) => n.endsWith(".md")).length}`,
		`memory_summary.md: ${summarySize} bytes (limit ${cfg.summaryMaxBytes})`,
		`phase2: last success ${fmt(st.phase2.lastSuccessAt)}${st.phase2.lastError ? `; last error: ${st.phase2.lastError}` : ""}`,
		st.phase2.usage ? `phase2 usage: in ${st.phase2.usage.input} / out ${st.phase2.usage.output} tokens, $${st.phase2.usage.cost.toFixed(4)}` : "",
		lr
			? `last run (${lr.trigger}) ${fmt(lr.startedAt)}: extracted ${lr.extracted}, no-op ${lr.noop}, failed ${lr.failed}, phase2 ${lr.phase2 ?? "-"}${lr.skippedReason ? `, skipped: ${lr.skippedReason}` : ""}${lr.error ? `\n  error: ${lr.error}` : ""}`
			: "last run: never",
		!cfg.extract ? "note: no `recollect.extract` model configured; using the session model (can be expensive)" : "",
		errors.length ? `config errors: ${errors.join("; ")}` : "",
		...failing.slice(0, 3).map((r) => `  failed: ${r.path.split("/").pop()} — ${r.lastError}`),
	];
	return lines.filter(Boolean).join("\n");
}

