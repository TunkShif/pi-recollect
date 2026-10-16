# pi-recollect

Background memory for [Pi](https://pi.dev) that works across sessions, modeled on the Codex CLI memory pipeline.

- **It saves memory without you seeing it.** The chat model never calls a "save memory" tool. When Pi starts, a cheap model you pick learns from your *finished* sessions in the background (sessions idle ≥ 3 h).
- **Reading memory is cheap.** A compact `memory_summary.md`, filtered to your current project, goes into the system prompt. The agent greps `MEMORY.md` and opens a session recap only when the topic matches, using at most 4–6 tool calls.
- **Plain Markdown in a git repo** (`~/.pi/agent/recollect/`). You can read it, edit it, and check its history.

Automatic skill creation, vector search, and saving memory during the chat are out of scope for v0.1. See [`docs/design.md`](docs/design.md).

## Install

```bash
pi install git@github.com:TunkShif/pi-recollect.git
```

For development, install a local clone instead: `pi install ./pi-recollect`.

## Configure

`~/.pi/agent/settings.json` (a project's `.pi/settings.json` can override it):

```jsonc
{
  "recollect": {
    "extract": "provider/gpt-6-luna:low",        // Phase 1 model (provider/id[:thinking])
    "consolidate": "provider/gpt-6-luna:medium"  // Phase 2 model (defaults to extract)
  }
}
```

| Setting | Default | Meaning |
|---|---|---|
| `enabled` / `generate` / `use` | `true` | master switch / background pipeline / prompt injection |
| `root` | `~/.pi/agent/recollect` | memory folder (git repo) |
| `sessionsDir` | `~/.pi/agent/sessions` | where Pi session `.jsonl` files live |
| `extract`, `consolidate`, `fallbackModel` | unset (session model) | `"provider/id[:thinking]"` or `{provider,id,thinking}` |
| `minIdleHours` | `3` | a session must be idle this long before extraction |
| `maxAgeDays` | `10` | ignore sessions older than this |
| `maxSessionsPerRun` / `extractConcurrency` | `4` / `4` | Phase 1 work per startup |
| `minSessionChars` | `4000` | skip tiny sessions without an LLM call |
| `maxRawForConsolidation` | `256` | top-N memories (by usage, then recency) sent to consolidation |
| `maxUnusedDays` | `30` | memories not used or refreshed for this long are forgotten |
| `minNewInputs` | `1` | batch Phase 2 until this many new memories (notes always trigger) |
| `summaryMaxBytes` | `10000` | hard limit on `memory_summary.md` (checked; one repair pass) |
| `summaryMaxTokens` | `2500` | budget for the whole injected memory section (instructions + cwd-filtered summary) |
| `phase2TimeoutMinutes` | `15` | consolidation worker timeout |
| `startupDelaySeconds` | `15` | delay before the background run after startup |
| `excludeCwds` | `[]` | globs like `"/tmp/**"`; sessions from these cwds are ignored |
| `debugLog` | `false` | NDJSON events in `<root>/.state/log.ndjson` |
| `piCommand` | `pi` | binary used to spawn the consolidation worker |

## Commands

| Command | |
|---|---|
| `/memory status` | counts, models, last run, summary size, errors |
| `/memory run [phase1\|phase2]` | run now (ignores the idle threshold, forces consolidation) |
| `/memory remember <text>` / `/memory forget <text>` | write a note in `notes/`; the next consolidation applies it |
| `/memory pause` / `resume` | stop/start the background pipeline |
| `/memory reload` | rebuild the injected memory section mid-session (breaks the prompt cache once) |

You can also just ask the agent to "remember X". The injected instructions tell it to write a note in `notes/`.

## How it works

```
session_start (startup) ──15s──► lock ─► prune ─► Phase 1 ─► Phase 2 ─► commit
Phase 1: idle sessions → active branch → tiered/redacted transcript → extract model (JSON)
         → .state/raw/<id>.md + .state/summaries/<id>.md      (empty output = nothing saved)
Phase 2: sync raw_memories.md + session_summaries/ → git diff vs baseline
         → no changes? stop : spawn `pi -p` worker (file tools only, path guard)
         → edits MEMORY.md + memory_summary.md → validate → git commit
Read:    session_start → filter memory_summary.md by cwd → systemPromptOptions.sections.memory
Usage:   tool_result touching session_summaries/ → usage counters → ranking/forgetting
```

```
~/.pi/agent/recollect/
├── memory_summary.md      # injected; v1 header; scope headings carry (cwd=...)
├── MEMORY.md              # grep-able handbook
├── raw_memories.md        # generated Phase 2 input
├── session_summaries/     # one recap per selected session
├── notes/                 # explicit remember/forget requests (never deleted)
└── .state/                # state.json, lock, raw/, summaries/, log.ndjson (git-ignored)
```

The consolidation worker runs as `pi -p --no-session --no-extensions -e src/worker-guard.ts --tools read,edit,write,grep,find,ls`. The guard blocks any path outside the memory root and any write except to `MEMORY.md` and `memory_summary.md`. If validation fails, the agent's edits are rolled back and the next run retries.

## Development

```bash
npm install
npm run typecheck
npm test
```
