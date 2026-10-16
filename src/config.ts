import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelRef {
	provider: string;
	id: string;
	thinking?: ThinkingLevel;
}

export interface RecollectConfig {
	enabled: boolean;
	/** Run the background pipeline (Phase 1 + Phase 2). */
	generate: boolean;
	/** Inject memory into the system prompt. */
	use: boolean;
	/** Memory root directory. */
	root: string;
	/** Directory with pi session files. */
	sessionsDir: string;
	extract?: ModelRef;
	consolidate?: ModelRef;
	fallbackModel?: ModelRef;
	minIdleHours: number;
	maxAgeDays: number;
	maxSessionsPerRun: number;
	extractConcurrency: number;
	minSessionChars: number;
	maxRawForConsolidation: number;
	maxUnusedDays: number;
	minNewInputs: number;
	summaryMaxBytes: number;
	/** Token budget for the injected summary (after cwd filtering). */
	summaryMaxTokens: number;
	phase2TimeoutMinutes: number;
	startupDelaySeconds: number;
	excludeCwds: string[];
	debugLog: boolean;
	/** Command used to spawn the consolidation worker. */
	piCommand: string;
}

export const SETTINGS_KEY = "recollect";
export const WORKER_ENV = "PI_RECOLLECT_WORKER";

const THINKING: ReadonlySet<string> = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export function expandHome(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return join(homedir(), p.slice(2));
	return p;
}

export function agentDir(): string {
	const env = process.env.PI_CODING_AGENT_DIR;
	return env ? resolve(expandHome(env)) : join(homedir(), ".pi", "agent");
}

export function defaultConfig(): RecollectConfig {
	const agent = agentDir();
	return {
		enabled: true,
		generate: true,
		use: true,
		root: join(agent, "recollect"),
		sessionsDir: process.env.PI_CODING_AGENT_SESSION_DIR
			? resolve(expandHome(process.env.PI_CODING_AGENT_SESSION_DIR))
			: join(agent, "sessions"),
		minIdleHours: 3,
		maxAgeDays: 10,
		maxSessionsPerRun: 4,
		extractConcurrency: 4,
		minSessionChars: 4000,
		maxRawForConsolidation: 256,
		maxUnusedDays: 30,
		minNewInputs: 1,
		summaryMaxBytes: 10_000,
		summaryMaxTokens: 2_500,
		phase2TimeoutMinutes: 15,
		startupDelaySeconds: 15,
		excludeCwds: [],
		debugLog: false,
		piCommand: "pi",
	};
}

function parseModelRef(v: unknown, field: string, errors: string[]): ModelRef | undefined {
	if (v === undefined || v === null) return undefined;
	if (typeof v === "string") {
		// "provider/id[:thinking]"
		const m = /^([^/]+)\/([^:]+)(?::(\w+))?$/.exec(v.trim());
		if (!m) {
			errors.push(`${field}: expected "provider/id[:thinking]" or {provider,id,thinking}`);
			return undefined;
		}
		const thinking = m[3];
		if (thinking && !THINKING.has(thinking)) errors.push(`${field}: invalid thinking "${thinking}"`);
		return { provider: m[1]!, id: m[2]!, thinking: thinking && THINKING.has(thinking) ? (thinking as ThinkingLevel) : undefined };
	}
	if (typeof v === "object") {
		const o = v as Record<string, unknown>;
		if (typeof o.provider !== "string" || typeof o.id !== "string") {
			errors.push(`${field}: provider and id must be strings`);
			return undefined;
		}
		let thinking: ThinkingLevel | undefined;
		if (o.thinking !== undefined) {
			if (typeof o.thinking === "string" && THINKING.has(o.thinking)) thinking = o.thinking as ThinkingLevel;
			else errors.push(`${field}.thinking: invalid value`);
		}
		return { provider: o.provider, id: o.id, thinking };
	}
	errors.push(`${field}: invalid model reference`);
	return undefined;
}

/** Merge raw settings (pi.getSettings()[SETTINGS_KEY]) over defaults. Never throws. */
export function resolveConfig(raw: unknown): { config: RecollectConfig; errors: string[] } {
	const config = defaultConfig();
	const errors: string[] = [];
	if (raw === undefined || raw === null) return { config, errors };
	if (typeof raw !== "object" || Array.isArray(raw)) {
		errors.push(`settings.${SETTINGS_KEY} must be an object`);
		return { config, errors };
	}
	const r = raw as Record<string, unknown>;

	const bool = (k: keyof RecollectConfig) => {
		if (r[k] === undefined) return;
		if (typeof r[k] === "boolean") (config as any)[k] = r[k];
		else errors.push(`${k}: expected boolean`);
	};
	const num = (k: keyof RecollectConfig, min: number) => {
		if (r[k] === undefined) return;
		if (typeof r[k] === "number" && Number.isFinite(r[k]) && (r[k] as number) >= min) (config as any)[k] = r[k];
		else errors.push(`${k}: expected number >= ${min}`);
	};
	const str = (k: keyof RecollectConfig) => {
		if (r[k] === undefined) return;
		if (typeof r[k] === "string" && (r[k] as string).trim()) (config as any)[k] = (r[k] as string).trim();
		else errors.push(`${k}: expected non-empty string`);
	};

	bool("enabled");
	bool("generate");
	bool("use");
	bool("debugLog");
	str("root");
	str("sessionsDir");
	str("piCommand");
	num("minIdleHours", 0);
	num("maxAgeDays", 1);
	num("maxSessionsPerRun", 1);
	num("extractConcurrency", 1);
	num("minSessionChars", 0);
	num("maxRawForConsolidation", 1);
	num("maxUnusedDays", 1);
	num("minNewInputs", 1);
	num("summaryMaxBytes", 1000);
	num("summaryMaxTokens", 200);
	num("phase2TimeoutMinutes", 1);
	num("startupDelaySeconds", 0);

	if (r.excludeCwds !== undefined) {
		if (Array.isArray(r.excludeCwds) && r.excludeCwds.every((x) => typeof x === "string")) {
			config.excludeCwds = r.excludeCwds as string[];
		} else errors.push("excludeCwds: expected string[]");
	}

	config.extract = parseModelRef(r.extract, "extract", errors);
	config.consolidate = parseModelRef(r.consolidate, "consolidate", errors);
	config.fallbackModel = parseModelRef(r.fallbackModel, "fallbackModel", errors);

	config.root = resolve(expandHome(config.root));
	config.sessionsDir = resolve(expandHome(config.sessionsDir));
	config.excludeCwds = config.excludeCwds.map(expandHome);
	return { config, errors };
}

export function modelRefString(m: ModelRef | undefined): string {
	if (!m) return "(session model)";
	return `${m.provider}/${m.id}${m.thinking ? `:${m.thinking}` : ""}`;
}
