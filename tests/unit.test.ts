import { mkdtemp, readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.ts";
import { extractJsonObject } from "../src/llm.ts";
import { ensureLayout, layout } from "../src/paths.ts";
import { parsePhase1Output, prune, stampRawMemory, summaryFileName } from "../src/phase1.ts";
import { selectInputs, syncArtifacts, validateSummary } from "../src/phase2.ts";
import { buildMemorySection, cwdMatches, filterSummary, truncateToTokens } from "../src/read-path.ts";
import { redactSecrets } from "../src/redact.ts";
import { serializeBranch } from "../src/serialize.ts";
import { activeBranch, cwdExcluded, discoverCandidates, parseJsonl } from "../src/sessions.ts";
import { emptyState, loadState, saveState, tryAcquireLock } from "../src/state.ts";
import { applyUsage, usedSummaryFiles } from "../src/usage.ts";
import { checkToolCall } from "../src/worker-guard.ts";
import { render } from "../src/prompts.ts";

const tmp = () => mkdtemp(join(tmpdir(), "recollect-test-"));

function sessionJsonl(id: string, cwd: string, opts: { branch?: boolean; ts?: string } = {}) {
	const ts = opts.ts ?? "2026-10-01T10:00:00.000Z";
	const lines: any[] = [
		{ type: "session", version: 3, id, timestamp: ts, cwd },
		{ type: "message", id: "s1", parentId: null, timestamp: ts, message: { role: "system", content: "sys" } },
		{ type: "message", id: "u1", parentId: "s1", timestamp: ts, message: { role: "user", content: [{ type: "text", text: "Please use rg not grep. ".repeat(10) }] } },
		{
			type: "message",
			id: "a1",
			parentId: "u1",
			timestamp: ts,
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "SECRET THOUGHTS" },
					{ type: "text", text: "Running search" },
					{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "rg foo" } },
				],
			},
		},
		{ type: "message", id: "r1", parentId: "a1", timestamp: ts, message: { role: "toolResult", toolCallId: "t1", toolName: "bash", isError: false, content: [{ type: "text", text: "foo.ts:1: foo" }] } },
		{ type: "message", id: "a2", parentId: "r1", timestamp: ts, message: { role: "assistant", content: [{ type: "text", text: "Found it in foo.ts" }] } },
	];
	if (opts.branch) {
		// abandoned branch from u1, then the active leaf continues from a2
		lines.push({ type: "message", id: "x1", parentId: "u1", timestamp: ts, message: { role: "assistant", content: [{ type: "text", text: "ABANDONED" }] } });
		lines.push({ type: "message", id: "u2", parentId: "a2", timestamp: ts, message: { role: "user", content: "thanks" } });
	}
	return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

describe("config", () => {
	it("applies defaults and parses model strings", () => {
		const { config, errors } = resolveConfig({ extract: "openrouter/gpt-6-luna:low", minIdleHours: 3 });
		expect(errors).toEqual([]);
		expect(config.extract).toEqual({ provider: "openrouter", id: "gpt-6-luna", thinking: "low" });
		expect(config.minIdleHours).toBe(3);
		expect(config.root.endsWith("/recollect")).toBe(true);
	});
	it("reports invalid fields without throwing", () => {
		const { errors } = resolveConfig({ minIdleHours: "x", extract: { provider: 1 } });
		expect(errors.length).toBe(2);
	});
});

describe("sessions", () => {
	it("resolves the active branch, skipping abandoned entries", () => {
		const entries = parseJsonl(sessionJsonl("s", "/p", { branch: true }));
		const ab = activeBranch(entries)!;
		expect(ab.leafId).toBe("u2");
		expect(ab.branch.map((e) => e.id)).toEqual(["s1", "u1", "a1", "r1", "a2", "u2"]);
	});
	it("matches excluded cwds", () => {
		expect(cwdExcluded("/tmp/x/y", ["/tmp/**"])).toBe(true);
		expect(cwdExcluded("/tmp", ["/tmp/**"])).toBe(true);
		expect(cwdExcluded("/home/a", ["/tmp/**"])).toBe(false);
	});
	it("discovers idle sessions and skips current/unchanged/too-new", async () => {
		const dir = await tmp();
		await mkdir(join(dir, "--p--"));
		const a = join(dir, "--p--", "a.jsonl");
		const b = join(dir, "--p--", "b.jsonl");
		await writeFile(a, sessionJsonl("A", "/p"));
		await writeFile(b, sessionJsonl("B", "/p"));
		const { config } = resolveConfig({ sessionsDir: dir, minIdleHours: 3 });
		const future = Date.now() + 4 * 3_600_000;
		const r1 = await discoverCandidates({ config, state: emptyState(), currentSessionFile: b, now: future, limit: 10 });
		expect(r1.candidates.map((c) => c.session.header.id)).toEqual(["A"]);
		const r2 = await discoverCandidates({ config, state: emptyState(), now: Date.now(), limit: 10 });
		expect(r2.candidates.length).toBe(0);
		expect(r2.skipped.not_idle).toBe(2);
		// unchanged
		const st = emptyState();
		const c = r1.candidates[0]!.session;
		st.sessions.A = { path: c.path, cwd: "/p", leafId: c.leafId, sourceMtimeMs: c.mtimeMs, status: "succeeded", attempts: 0, extractedAt: 0, updatedAt: "", usageCount: 0 };
		const r3 = await discoverCandidates({ config, state: st, currentSessionFile: b, now: future, limit: 10 });
		expect(r3.candidates.length).toBe(0);
	});
});

describe("serialize", () => {
	it("drops thinking, keeps user/assistant/tool, redacts secrets", () => {
		const entries = parseJsonl(sessionJsonl("s", "/p"));
		const ab = activeBranch(entries)!;
		(ab.branch[1] as any).message.content[0].text += " my key is sk-ant-abcdefghijklmnopqrstuvwxyz123";
		const s = serializeBranch(ab.branch, 100_000);
		expect(s.text).not.toContain("SECRET THOUGHTS");
		expect(s.text).toContain("USER:");
		expect(s.text).toContain("TOOL CALL bash");
		expect(s.text).toContain("Found it in foo.ts");
		expect(s.text).toContain("[REDACTED_SECRET]");
		expect(s.text).not.toContain("sys");
		expect(s.userMessages).toBe(1);
	});
	it("drops low-tier rows first under budget", () => {
		const branch: any[] = [];
		for (let i = 0; i < 50; i++) {
			branch.push({ type: "message", id: `u${i}`, message: { role: "user", content: `user message ${i}` } });
			branch.push({ type: "message", id: `r${i}`, message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "x".repeat(4000) }] } });
		}
		const s = serializeBranch(branch, 2_000);
		expect(s.text).toContain("user message 0");
		expect(s.text).toContain("user message 49");
		expect(s.text).toContain("[... items omitted ...]");
		expect(s.omittedRows).toBeGreaterThan(0);
	});
});

describe("redact", () => {
	it("redacts common secret shapes", () => {
		const t = redactSecrets("password=hunter2xyz token: ghp_abcdefghijklmnopqrstuvwxyz0123456789 https://u:pa55word@h.com Bearer abcdefghijklmnopqrstuvwxyz");
		expect(t).not.toContain("hunter2xyz");
		expect(t).not.toContain("ghp_abc");
		expect(t).not.toContain("pa55word");
		expect(t).not.toContain("abcdefghijklmnopqrstuvwxyz");
	});
});

describe("phase1 helpers", () => {
	it("parses JSON leniently", () => {
		expect(extractJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
		expect(extractJsonObject('noise {"a":2} trailing')).toEqual({ a: 2 });
		expect(parsePhase1Output('{"raw_memory":"","session_summary":"","session_slug":""}')).toEqual({ raw_memory: "", session_summary: "", session_slug: "" });
		expect(parsePhase1Output('{"raw_memory":"x","rollout_summary":"y"}')?.session_summary).toBe("y");
		expect(parsePhase1Output("nope")).toBeUndefined();
	});
	it("stamps frontmatter deterministically", () => {
		const out = stampRawMemory("---\ndescription: d\ncwd: wrong\n---\nbody", { session_id: "S", cwd: "/right" });
		expect(out).toContain("session_id: S");
		expect(out).toContain("cwd: /right");
		expect(out).not.toContain("cwd: wrong");
		expect(out).toContain("description: d");
		expect(stampRawMemory("plain", { a: "1" })).toBe("---\na: 1\n---\nplain\n");
	});
	it("builds summary file names", () => {
		expect(summaryFileName("2026-10-01T10:00:00.123Z", "01a1-2005-722b", "Fix Fish Prompt!")).toBe("2026-10-01T10-00-00-722b-fix_fish_prompt.md");
	});
});

describe("phase2 helpers", () => {
	it("selects by usage then recency and respects maxUnusedDays", () => {
		const { config } = resolveConfig({});
		const st = emptyState();
		const now = Date.now();
		const rec = (o: any) => ({ path: "", cwd: "", leafId: "", sourceMtimeMs: 0, status: "succeeded", attempts: 0, updatedAt: "", usageCount: 0, summaryFile: "f.md", ...o });
		st.sessions.a = rec({ extractedAt: now - 1000, summaryFile: "a.md" });
		st.sessions.b = rec({ extractedAt: now - 5000, usageCount: 3, summaryFile: "b.md" });
		st.sessions.c = rec({ extractedAt: now - 40 * 86_400_000, summaryFile: "c.md" });
		st.sessions.d = rec({ extractedAt: now, status: "no_output" });
		expect(selectInputs(st, config, now).map((s) => s.id)).toEqual(["b", "a"]);
	});
	it("syncs artifacts and removes deselected summaries", async () => {
		const l = layout(await tmp());
		await ensureLayout(l);
		await writeFile(join(l.stateRawDir, "A.md"), "---\nsession_id: A\n---\nraw A");
		await writeFile(join(l.stateSummariesDir, "A.md"), "summary A");
		await writeFile(join(l.summariesDir, "old.md"), "stale");
		await syncArtifacts(l, [{ id: "A", summaryFile: "a-file.md", score: [0, 0] }]);
		expect(await readdir(l.summariesDir)).toEqual(["a-file.md"]);
		const raw = await readFile(l.raw, "utf8");
		expect(raw).toContain("raw A");
		expect(raw).toContain("session_summaries/a-file.md");
	});
	it("validates summary header and size", () => {
		expect(validateSummary("v1\n\n## User Profile\nx", 1000)).toBeUndefined();
		expect(validateSummary("## User Profile", 1000)).toMatch(/must start/);
		expect(validateSummary(`v1\n\n## User Profile\n${"x".repeat(2000)}`, 1000)).toMatch(/bytes/);
	});
	it("prunes records whose session file vanished", async () => {
		const l = layout(await tmp());
		await ensureLayout(l);
		const st = emptyState();
		st.sessions.gone = { path: "/nope", cwd: "", leafId: "", sourceMtimeMs: 0, status: "succeeded", attempts: 0, extractedAt: Date.now(), updatedAt: "", usageCount: 0 };
		st.phase2.pendingSessionIds = ["gone"];
		await writeFile(join(l.stateRawDir, "gone.md"), "x");
		const { config } = resolveConfig({});
		const removed = await prune({ l, state: st, config, exists: () => false });
		expect(removed).toEqual(["gone"]);
		expect(st.phase2.pendingSessionIds).toEqual([]);
		expect(await readdir(l.stateRawDir)).toEqual([]);
	});
});

describe("read path", () => {
	const summary = `## User Profile
Dev.

## User preferences
- use rg

## What's in Memory

### fish config (cwd=/home/u/.config/fish)

#### 2026-10-01
- prompt: fish_prompt, git
  - desc: prompt work

### nvim (cwd=/home/u/.config/nvim)

#### 2026-09-30
- lsp: lua_ls

### global (cwd=*)
- tools: rg

### a (cwd=/a)
- a1

### b (cwd=/b)
- b1

### c (cwd=/c)
- c1

### Older Memory Topics

#### old proj (cwd=/home/u/old)
- topic1: k1, k2
  - desc: long description here
`;
	it("matches cwd scopes (scope equal to or containing cwd only)", () => {
		expect(cwdMatches("/home/u", "/home/u")).toBe(true);
		expect(cwdMatches("/home/u", "/home/u/x")).toBe(true);
		expect(cwdMatches("/home/u/x/y", "/home/u/x")).toBe(false); // parent cwd must not pull in child scopes
		expect(cwdMatches("/home/u2", "/home/u")).toBe(false);
		expect(cwdMatches("/home/v", "/home/u")).toBe(false);
		expect(cwdMatches("*", "/z")).toBe(true);
	});
	it("keeps only matching scopes; lists others by name", () => {
		const out = filterSummary(summary, "/home/u/.config/nvim/lua");
		expect(out).toContain("## User preferences");
		expect(out).toContain("### nvim");
		expect(out).toContain("- lsp: lua_ls");
		expect(out).toContain("### global");
		expect(out).not.toContain("### fish config");
		expect(out).not.toContain("- a1");
		expect(out).not.toContain("### Older Memory Topics");
		expect(out).not.toContain("topic1");
		expect(out).toContain("Other scopes omitted for this cwd; grep MEMORY.md if needed: fish config; a; b; c; old proj)");
		expect(out).not.toContain("cwd=/a)");
	});
	it("can still include a few recent other scopes", () => {
		const out = filterSummary(summary, "/home/u/.config/nvim", { recentOther: 1 });
		expect(out).toContain("### fish config");
		expect(out).not.toContain("- a1");
	});
	it("does not inject child scopes when launched from a parent dir", () => {
		const out = filterSummary(summary, "/home/u");
		expect(out).not.toContain("- lsp: lua_ls");
		expect(out).not.toContain("prompt work");
		expect(out).toContain("### global");
	});
	it("keeps full older block when it matches", () => {
		const out = filterSummary(summary, "/home/u/old");
		expect(out).toContain("### Older Memory Topics");
		expect(out).toContain("long description here");
	});
	it("dedupes omitted scope names", () => {
		const s2 = summary.replace("#### old proj (cwd=/home/u/old)", "#### a (cwd=/a)");
		const out = filterSummary(s2, "/home/u/.config/nvim");
		expect(out).toContain("if needed: fish config; a; b; c)");
	});
	it("truncates to token budget", () => {
		expect(truncateToTokens("a\n".repeat(1000), 50).length).toBeLessThanOrEqual(200);
		expect(truncateToTokens("short", 50)).toBe("short");
	});
	it("budgets the whole injected section, instructions included", async () => {
		const dir = await mkdtemp(join(tmpdir(), "recollect-rp-"));
		const p = join(dir, "memory_summary.md");
		await writeFile(p, `v1\n\n## User Profile\n${"- line of profile text\n".repeat(2000)}`);
		const section = (await buildMemorySection({ root: dir, summaryPath: p, cwd: "/x", maxTokens: 1500 }))!;
		expect(section).toContain("memory summary truncated");
		expect(section).toContain("MEMORY_SUMMARY ENDS");
		expect(section.length).toBeLessThanOrEqual(1500 * 4);
	});
	it("renders templates in a single pass", () => {
		expect(render("{{ a }} {{b}} {{ c }}", { a: "{{ b }}", b: 2 })).toBe("{{ b }} 2 {{ c }}");
	});
});

describe("usage", () => {
	it("attributes reads and grep hits", () => {
		const root = "/m";
		expect(usedSummaryFiles({ root, cwd: "/x", toolName: "read", input: { path: "/m/session_summaries/a.md" }, resultText: "" })).toEqual(["a.md"]);
		expect(
			usedSummaryFiles({ root, cwd: "/x", toolName: "grep", input: { pattern: "fish", path: "/m/MEMORY.md" }, resultText: "- session_summaries/b.md (cwd=...)" }),
		).toEqual(["b.md"]);
		expect(usedSummaryFiles({ root, cwd: "/x", toolName: "read", input: { path: "/x/session_summaries/a.md" }, resultText: "" })).toEqual([]);
		expect(usedSummaryFiles({ root, cwd: "/x", toolName: "bash", input: { command: "rg fish /m/MEMORY.md" }, resultText: "session_summaries/c.md" })).toEqual(["c.md"]);
	});
	it("applies usage counters", () => {
		const st = emptyState();
		st.sessions.A = { path: "", cwd: "", leafId: "", sourceMtimeMs: 0, status: "succeeded", attempts: 0, extractedAt: 0, updatedAt: "", usageCount: 1, summaryFile: "a.md" };
		expect(applyUsage(st, ["a.md", "zzz.md"], 42)).toBe(1);
		expect(st.sessions.A!.usageCount).toBe(2);
		expect(st.sessions.A!.lastUsageAt).toBe(42);
	});
});

describe("worker guard", () => {
	const root = "/m";
	it("allows reads in root and writes only to owned files", () => {
		expect(checkToolCall(root, root, "read", { path: "raw_memories.md" })).toBeUndefined();
		expect(checkToolCall(root, root, "grep", { pattern: "x" })).toBeUndefined();
		expect(checkToolCall(root, root, "write", { path: "MEMORY.md" })).toBeUndefined();
		expect(checkToolCall(root, root, "edit", { path: "/m/memory_summary.md" })).toBeUndefined();
	});
	it("blocks escapes, input edits, and other tools", () => {
		expect(checkToolCall(root, root, "read", { path: "/etc/passwd" })).toMatch(/outside/);
		expect(checkToolCall(root, root, "read", { path: "../x" })).toMatch(/outside/);
		expect(checkToolCall(root, root, "read", { path: ".git/config" })).toMatch(/\.git/);
		expect(checkToolCall(root, root, "write", { path: "notes/a.md" })).toMatch(/only MEMORY/);
		expect(checkToolCall(root, root, "edit", { path: "raw_memories.md" })).toMatch(/only MEMORY/);
		expect(checkToolCall(root, root, "bash", { command: "ls" })).toMatch(/not allowed/);
	});
});

describe("state", () => {
	it("round-trips and locks exclusively", async () => {
		const l = layout(await tmp());
		await ensureLayout(l);
		const s = emptyState();
		s.paused = true;
		await saveState(l, s);
		expect((await loadState(l)).paused).toBe(true);
		const lock1 = await tryAcquireLock(l);
		expect(lock1).toBeDefined();
		expect(await tryAcquireLock(l)).toBeUndefined();
		await lock1!.release();
		const lock2 = await tryAcquireLock(l);
		expect(lock2).toBeDefined();
		await lock2!.release();
	});
	it("takes over a stale lock from a dead pid", async () => {
		const l = layout(await tmp());
		await ensureLayout(l);
		await writeFile(l.lockFile, JSON.stringify({ pid: 999_999_999, heartbeatAt: Date.now() }));
		const lock = await tryAcquireLock(l);
		expect(lock).toBeDefined();
		await lock!.release();
	});
});

describe("usage breadth", () => {
	it("ignores broad grep hits", () => {
		const text = ["a.md", "b.md", "c.md"].map((f) => `- session_summaries/${f} (session_path=...)`).join("\n");
		expect(usedSummaryFiles({ root: "/m", cwd: "/x", toolName: "grep", input: { pattern: "path", path: "/m/MEMORY.md" }, resultText: text })).toEqual([]);
	});
});
