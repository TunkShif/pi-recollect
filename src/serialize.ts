import { redactSecrets } from "./redact.ts";
import type { RawEntry } from "./sessions.ts";

/**
 * Turn a session's active branch into a compact, tiered transcript for Phase 1.
 * Evidence is selected newest-first within priority tiers, then rendered in source order.
 * (Port of codex-rs/memories/write/src/rollout_input.rs, simplified for pi entries.)
 */

enum Tier {
	Human = 0,
	Final = 1,
	Context = 2,
	Commentary = 3,
	Tool = 4,
}

interface Row {
	tier: Tier;
	text: string;
}

const TOOL_OUTPUT_CHARS = 8_000; // ~2k tokens
const TOOL_ARGS_CHARS = 1_500;
const MAX_ROW_CHARS = 40_000;
const OMITTED = "[... items omitted ...]";

export const estimateTokens = (s: string) => Math.ceil(s.length / 4);

function headTail(text: string, max: number): string {
	if (text.length <= max) return text;
	const half = Math.floor((max - 40) / 2);
	return `${text.slice(0, half)}\n[... ${text.length - 2 * half} chars truncated ...]\n${text.slice(-half)}`;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const p of content) {
		if (!p || typeof p !== "object") continue;
		const t = (p as any).type;
		if (t === "text" && typeof (p as any).text === "string") parts.push((p as any).text);
		else if (t === "image") parts.push("[image omitted]");
	}
	return parts.join("\n");
}

function fmtTime(ts: unknown): string {
	if (typeof ts !== "string") return "";
	return ts.replace("T", " ").replace(/\.\d+Z$/, "Z");
}

function rowsFor(entry: RawEntry): Row[] {
	const rows: Row[] = [];
	const ts = fmtTime(entry.timestamp);
	const push = (tier: Tier, text: string) => {
		if (text.trim()) rows.push({ tier, text: headTail(text, MAX_ROW_CHARS) });
	};

	if (entry.type === "compaction" && typeof entry.summary === "string") {
		push(Tier.Context, `[${ts}] SUMMARY OF EARLIER CONTEXT (compaction):\n${entry.summary}`);
		return rows;
	}
	if (entry.type === "branch_summary" && typeof entry.summary === "string") {
		push(Tier.Context, `[${ts}] SUMMARY OF ABANDONED BRANCH:\n${entry.summary}`);
		return rows;
	}
	if (entry.type !== "message") return rows;
	const msg = entry.message as any;
	if (!msg || typeof msg !== "object") return rows;

	switch (msg.role) {
		case "user":
			push(Tier.Human, `[${ts}] USER:\n${textOf(msg.content)}`);
			break;
		case "assistant": {
			const content: any[] = Array.isArray(msg.content) ? msg.content : [];
			const texts = content.filter((c) => c?.type === "text" && typeof c.text === "string").map((c) => c.text);
			const calls = content.filter((c) => c?.type === "toolCall");
			// thinking blocks are deliberately dropped
			if (texts.length) {
				// assistant text that precedes tool calls is commentary; text-only turns are final answers
				push(calls.length ? Tier.Commentary : Tier.Final, `[${ts}] ASSISTANT:\n${texts.join("\n")}`);
			}
			for (const c of calls) {
				let args = "";
				try {
					args = JSON.stringify(c.arguments ?? {});
				} catch {
					args = "{}";
				}
				push(Tier.Tool, `TOOL CALL ${c.name}: ${headTail(args, TOOL_ARGS_CHARS)}`);
			}
			if (msg.stopReason === "error" && msg.errorMessage) push(Tier.Tool, `[assistant error] ${msg.errorMessage}`);
			break;
		}
		case "toolResult":
			push(
				Tier.Tool,
				`TOOL RESULT ${msg.toolName ?? ""} (${msg.isError ? "error" : "ok"}):\n${headTail(textOf(msg.content), TOOL_OUTPUT_CHARS)}`,
			);
			break;
		case "bashExecution":
			if (!msg.excludeFromContext) {
				push(Tier.Human, `[${ts}] USER RAN SHELL: ${msg.command}\n${headTail(String(msg.output ?? ""), TOOL_OUTPUT_CHARS)}`);
			}
			break;
		default:
			// system / custom / branchSummary / compactionSummary messages are dropped
			break;
	}
	return rows;
}

export interface SerializedSession {
	text: string;
	userMessages: number;
	totalChars: number;
	omittedRows: number;
}

export function serializeBranch(branch: RawEntry[], tokenLimit: number): SerializedSession {
	const rows: Row[] = [];
	for (const e of branch) for (const r of rowsFor(e)) rows.push({ ...r, text: redactSecrets(r.text) });
	const userMessages = rows.filter((r) => r.tier === Tier.Human).length;
	const totalChars = rows.reduce((n, r) => n + r.text.length + 2, 0);

	// key = row position; value = text to render (possibly truncated)
	const chosen = new Map<number, string>();
	if (Math.ceil(totalChars / 4) <= tokenLimit) {
		rows.forEach((r, k) => chosen.set(k, r.text));
	} else {
		let budget = tokenLimit * 4;
		for (const tier of [Tier.Human, Tier.Final, Tier.Context, Tier.Commentary, Tier.Tool]) {
			for (let k = rows.length - 1; k >= 0; k--) {
				const r = rows[k]!;
				if (r.tier !== tier) continue;
				const cost = r.text.length + 2;
				if (cost <= budget) {
					chosen.set(k, r.text);
					budget -= cost;
				} else if (tier <= Tier.Final && budget > 2_000) {
					// keep a truncated version of important rows rather than dropping them
					const t = headTail(r.text, budget - 100);
					chosen.set(k, t);
					budget -= t.length + 2;
				}
			}
		}
	}

	const out: string[] = [];
	let omittedRows = 0;
	let lastOmitted = false;
	rows.forEach((_r, k) => {
		const t = chosen.get(k);
		if (t !== undefined) {
			out.push(t);
			lastOmitted = false;
		} else {
			omittedRows++;
			if (!lastOmitted) out.push(OMITTED);
			lastOmitted = true;
		}
	});
	return { text: out.join("\n\n"), userMessages, totalChars, omittedRows };
}
