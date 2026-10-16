import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "prompts");

const cache = new Map<string, string>();
export function loadPrompt(name: "stage_one_system" | "stage_one_input" | "consolidation" | "read_path"): string {
	let t = cache.get(name);
	if (t === undefined) {
		t = readFileSync(join(PROMPTS_DIR, `${name}.md`), "utf8");
		cache.set(name, t);
	}
	return t;
}

/** Replace `{{ key }}` placeholders. Unknown placeholders are left intact. Single pass (values are not re-expanded). */
export function render(template: string, vars: Record<string, string | number>): string {
	return template.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (m, k: string) => (k in vars ? String(vars[k]) : m));
}
