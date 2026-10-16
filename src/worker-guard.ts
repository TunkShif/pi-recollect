/**
 * Loaded ONLY into the Phase 2 consolidation child process (`pi -p ... -e worker-guard.ts`).
 * Confines file tools to the memory root and makes inputs read-only.
 */
import { isAbsolute, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const WRITABLE = new Set(["MEMORY.md", "memory_summary.md"]);

function expand(p: string): string {
	if (p === "~" || p.startsWith("~/")) return (process.env.HOME ?? "") + p.slice(1);
	return p;
}

export function checkToolCall(root: string, cwd: string, toolName: string, input: Record<string, unknown>): string | undefined {
	const rel = (p: string) => relative(root, resolve(cwd, expand(p)));
	const inside = (p: string) => {
		const r = rel(p);
		return r === "" || (!r.startsWith("..") && !isAbsolute(r));
	};
	switch (toolName) {
		case "read":
		case "grep":
		case "find":
		case "ls": {
			const p = typeof input.path === "string" && input.path ? input.path : ".";
			if (!inside(p)) return `${toolName}: path outside the memory root is not allowed`;
			if (rel(p).split("/")[0] === ".git") return `${toolName}: .git is not accessible`;
			return undefined;
		}
		case "edit":
		case "write": {
			const p = typeof input.path === "string" ? input.path : "";
			if (!p || !inside(p)) return `${toolName}: path outside the memory root is not allowed`;
			const r = rel(p);
			if (!WRITABLE.has(r)) return `${toolName}: only MEMORY.md and memory_summary.md may be modified (got ${r})`;
			return undefined;
		}
		default:
			return `${toolName}: tool not allowed in memory consolidation`;
	}
}

export default function workerGuard(pi: ExtensionAPI) {
	const root = resolve(process.env.PI_RECOLLECT_ROOT || process.cwd());
	pi.on("tool_call", (event, ctx) => {
		const reason = checkToolCall(root, ctx.cwd, event.toolName, (event.input ?? {}) as Record<string, unknown>);
		if (reason) return { block: true, reason };
		return undefined;
	});
}
