import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { ModelRef, ThinkingLevel } from "./config.ts";

export interface ResolvedModel {
	model: Model<Api>;
	ref: ModelRef;
	source: "configured" | "fallback" | "session";
}

export function resolveModel(
	registry: ModelRegistry,
	preferred: ModelRef | undefined,
	fallback: ModelRef | undefined,
	sessionModel: Model<Api> | undefined,
): { resolved?: ResolvedModel; error?: string } {
	const tryRef = (ref: ModelRef | undefined, source: ResolvedModel["source"]) => {
		if (!ref) return undefined;
		const m = registry.find(ref.provider, ref.id);
		if (!m) return { err: `model ${ref.provider}/${ref.id} not found` };
		if (!registry.hasConfiguredAuth(m)) return { err: `no auth configured for ${ref.provider}/${ref.id}` };
		return { ok: { model: m, ref, source } as ResolvedModel };
	};
	const errors: string[] = [];
	for (const [ref, source] of [
		[preferred, "configured"],
		[fallback, "fallback"],
	] as const) {
		const r = tryRef(ref, source);
		if (r?.ok) return { resolved: r.ok };
		if (r?.err) errors.push(r.err);
	}
	if (!preferred && sessionModel) {
		return {
			resolved: { model: sessionModel, ref: { provider: sessionModel.provider, id: sessionModel.id }, source: "session" },
		};
	}
	return { error: errors.join("; ") || "no memory model configured and no session model available" };
}

export interface CompletionResult {
	text: string;
	usage: { input: number; output: number; cost: number };
}

export async function completeText(opts: {
	registry: ModelRegistry;
	model: Model<Api>;
	systemPrompt: string;
	user: string;
	thinking?: ThinkingLevel;
	signal?: AbortSignal;
	maxTokens?: number;
}): Promise<CompletionResult> {
	const reasoning = opts.thinking && opts.thinking !== "off" && opts.model.reasoning ? (opts.thinking as Exclude<ThinkingLevel, "off">) : undefined;
	const stream = opts.registry.streamSimple(
		opts.model,
		{
			systemPrompt: opts.systemPrompt,
			messages: [{ role: "user", content: [{ type: "text", text: opts.user }], timestamp: Date.now() }],
		},
		{
			signal: opts.signal,
			maxTokens: opts.maxTokens ?? Math.min(opts.model.maxTokens || 32_000, 32_000),
			cacheRetention: "none",
			...(reasoning ? { reasoning } : {}),
		},
	);
	const msg: AssistantMessage = await stream.result();
	if (msg.stopReason === "error" || msg.stopReason === "aborted") {
		throw new Error(`model ${msg.stopReason}: ${msg.errorMessage ?? "unknown error"}`);
	}
	const text = msg.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("");
	const u = msg.usage;
	return { text, usage: { input: u?.input ?? 0, output: u?.output ?? 0, cost: u?.cost?.total ?? 0 } };
}

/** Lenient JSON object extraction: strips fences, takes the outermost {...}. */
export function extractJsonObject(text: string): Record<string, unknown> | undefined {
	let t = text.trim();
	const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
	if (fence) t = fence[1]!;
	const tryParse = (s: string) => {
		try {
			const v = JSON.parse(s);
			return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
		} catch {
			return undefined;
		}
	};
	const direct = tryParse(t);
	if (direct) return direct;
	const start = t.indexOf("{");
	const end = t.lastIndexOf("}");
	if (start >= 0 && end > start) return tryParse(t.slice(start, end + 1));
	return undefined;
}
