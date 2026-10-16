import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface GitResult {
	code: number;
	stdout: string;
	stderr: string;
}

export function git(root: string, args: string[], maxBuffer = 64 * 1024 * 1024): Promise<GitResult> {
	return new Promise((resolve) => {
		execFile(
			"git",
			["-C", root, "-c", "core.quotepath=off", "-c", "commit.gpgsign=false", ...args],
			{ maxBuffer, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
			(err, stdout, stderr) => {
				const code = err ? (typeof (err as any).code === "number" ? (err as any).code : 1) : 0;
				resolve({ code, stdout: String(stdout), stderr: String(stderr) });
			},
		);
	});
}

async function ok(root: string, args: string[]): Promise<string> {
	const r = await git(root, args);
	if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.trim() || r.stdout.trim()}`);
	return r.stdout;
}

const IDENTITY = ["-c", "user.name=pi-recollect", "-c", "user.email=pi-recollect@localhost"];

/** Initialize the repo with an empty baseline commit if needed. Returns HEAD. */
export async function ensureRepo(root: string): Promise<string> {
	if (!existsSync(join(root, ".git"))) {
		await ok(root, ["init", "-q", "-b", "main"]);
	}
	const head = await git(root, ["rev-parse", "--verify", "HEAD"]);
	if (head.code !== 0) {
		await ok(root, ["add", "-A"]);
		await ok(root, [...IDENTITY, "commit", "-q", "--allow-empty", "-m", "Initialize memory baseline"]);
	}
	return (await ok(root, ["rev-parse", "HEAD"])).trim();
}

/** Stage everything and return the diff of the worktree vs HEAD (after staging). */
export async function stagedDiff(root: string, maxBytes: number): Promise<{ diff: string; changedFiles: string[]; truncated: boolean }> {
	await ok(root, ["add", "-A"]);
	const names = (await ok(root, ["diff", "--cached", "--name-status", "HEAD"])).trim();
	const changedFiles = names ? names.split("\n") : [];
	let diff = await ok(root, ["diff", "--cached", "--no-color", "--unified=3", "HEAD"]);
	let truncated = false;
	if (Buffer.byteLength(diff) > maxBytes) {
		diff = `${Buffer.from(diff).subarray(0, maxBytes).toString("utf8")}\n\n[... diff truncated at ${maxBytes} bytes; use the file list above and read files directly ...]\n`;
		truncated = true;
	}
	return { diff, changedFiles, truncated };
}

export async function commitAll(root: string, message: string): Promise<string> {
	await ok(root, ["add", "-A"]);
	const st = await git(root, ["diff", "--cached", "--quiet", "HEAD"]);
	if (st.code !== 0) await ok(root, [...IDENTITY, "commit", "-q", "-m", message]);
	return (await ok(root, ["rev-parse", "HEAD"])).trim();
}

/** Restore only the given paths to HEAD (index + worktree). Missing-in-HEAD paths are removed. */
export async function restorePaths(root: string, paths: string[]): Promise<void> {
	for (const p of paths) {
		const inHead = await git(root, ["cat-file", "-e", `HEAD:${p}`]);
		if (inHead.code === 0) await ok(root, ["checkout", "HEAD", "--", p]);
		else {
			await git(root, ["rm", "-q", "--cached", "--ignore-unmatch", "--", p]);
			await git(root, ["clean", "-q", "-f", "--", p]);
		}
	}
}

export async function headCommit(root: string): Promise<string | undefined> {
	const r = await git(root, ["rev-parse", "HEAD"]);
	return r.code === 0 ? r.stdout.trim() : undefined;
}
