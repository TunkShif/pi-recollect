/** Best-effort secret redaction. Applied before LLM calls and again on LLM output. */

const R = "[REDACTED_SECRET]";

const PATTERNS: Array<[RegExp, string | ((...m: string[]) => string)]> = [
	// PEM private keys / certificates
	[/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, R],
	// Authorization headers / bearer tokens
	[/\b(authorization\s*[:=]\s*)(?:bearer|basic|token)?\s*[A-Za-z0-9._~+/=-]{12,}/gi, (_m, p) => `${p}${R}`],
	[/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g, `Bearer ${R}`],
	// Well-known token formats
	[/\bsk-(?:proj-|ant-|or-)?[A-Za-z0-9_-]{20,}/g, R],
	[/\bgh[pousr]_[A-Za-z0-9]{30,}/g, R],
	[/\bgithub_pat_[A-Za-z0-9_]{40,}/g, R],
	[/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, R],
	[/\bAKIA[0-9A-Z]{16}\b/g, R],
	[/\bAIza[0-9A-Za-z_-]{35}\b/g, R],
	[/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, R], // JWT
	// key=value style secrets
	[
		/\b((?:api[_-]?key|secret(?:[_-]?key)?|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|pwd|private[_-]?key|secret[_-]?id)["']?\s*[:=]\s*["']?)([^\s"',;&]{6,})/gi,
		(_m, p) => `${p}${R}`,
	],
	// credentials in URLs: scheme://user:pass@host
	[/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]{3,})@/gi, (_m, p) => `${p}${R}@`],
];

export function redactSecrets(text: string): string {
	let out = text;
	for (const [re, rep] of PATTERNS) out = out.replace(re, rep as any);
	return out;
}
