---
name: extractoken
description: Extract a design system (DTCG tokens + DESIGN.md + audit) from any SwiftUI codebase
trigger_phrases:
  - "extract design tokens from this repo"
  - "run extractoken"
  - "audit my SwiftUI design system"
  - "what design tokens does this app use"
  - "recover the design system from this codebase"
---

# Extractoken

Reverse-engineers an implicit SwiftUI design system into three artifacts:
- `tokens.json` — W3C DTCG 2025.10 design tokens
- `DESIGN.md` — LLM-readable brand narrative companion (Google @google/design.md alpha format)
- `audit.md` — Drift report: magic numbers, near-duplicate colors, harmonization recommendations

Invoke as: `/extractoken --path <swift-repo> [--output <dir>] [--no-llm]`

---

## Pipeline

When invoked, run this pipeline. Each step is restartable; if any LLM task fails,
re-running picks up where it left off (findings.raw.json is durable).

### Step 1 — Parse + analyze (deterministic)

```bash
node /Users/conor/Development/Extoken/.claude/skills/extractoken/dist/extract.js parse \
  --path <path> \
  --output <out> \
  [--no-llm] \
  [--max-files 2000] \
  [--delta-e-threshold 2.5]
```

This emits:
- `<out>/.extractoken/findings.raw.json` — AST + regex extraction results
- `<out>/.extractoken/clusters.json` — color cluster analysis
- `<out>/.extractoken/llm-tasks.json` — manifest of pending LLM passes (unless --no-llm)
- `<out>/.extractoken/prompts/normalize-color.md` — prompt for the normalize subagent

### Step 2 — Run pending LLM tasks (skip if --no-llm)

Read `<out>/.extractoken/llm-tasks.json`. For each task with `status: "pending"`:

Spawn an Agent subagent with:
- `subagent_type`: "general-purpose"
- `model`: `task.recommendedModel` (e.g. "claude-haiku-4-5-20251001")
- `description`: `task.id` (e.g. "normalize-color")
- `prompt`: contents of `task.promptPath`, with this instruction prepended:

```
Read the prompt below and write your structured JSON response to <task.responsePath>
using the Write tool. Validate that your output matches the CandidateFile schema before writing.
Reply with exactly the word "done" after writing.

---
[contents of task.promptPath]
```

Independent tasks (different categories) can run in parallel — multiple Agent calls in one message.
All normalize tasks are independent. Harmonize and narrate depend on normalize completing.

After all tasks complete, verify each `task.responsePath` exists.

### Step 3 — Emit final artifacts (deterministic)

```bash
node /Users/conor/Development/Extoken/.claude/skills/extractoken/dist/extract.js emit \
  --output <out> \
  [--no-llm]
```

This:
- Reads LLM normalize outputs from `<out>/.extractoken/llm-out/`
- Validates against DTCG 2025.10 schema (Ajv — hard error on failure)
- Writes `<out>/tokens.json`, `<out>/audit.md`, `<out>/DESIGN.md` (stub)
- Snapshots `tokens.json` to `<out>/.extractoken/previous/tokens.json` for diff on next run

### Step 4 — Run narrate (if needed, skip if --no-llm)

If `<out>/.extractoken/llm-tasks.json` shows a `narrate` task still pending,
spawn one more subagent with `task.recommendedModel` against the narrate prompt,
instructing it to Write `<out>/DESIGN.md` directly using the Write tool.

*(Slice 1: narrate prompt not yet generated. DESIGN.md will be a stub.)*

### Step 5 — Finalize

```bash
node /Users/conor/Development/Extoken/.claude/skills/extractoken/dist/extract.js finalize \
  --output <out> \
  [--no-llm]
```

Runs the DESIGN.md lint pass (8 rules: broken-ref, missing-primary, contrast-ratio,
orphaned-tokens, token-summary, missing-sections, missing-typography, section-order).
Prints a summary of what was extracted.

---

## Flags

| Flag | Default | Description |
|---|---|---|
| `--path <dir>` | (required) | Swift repo root |
| `--output <dir>` | `<path>/.extractoken-out` | Output directory |
| `--no-llm` | false | Skip LLM passes (CI-safe, mechanical token names) |
| `--max-files <n>` | 2000 | Hard limit on .swift files |
| `--delta-e-threshold <n>` | 2.5 | CIEDE2000 distance for near-duplicate clustering |
| `--model-normalize <id>` | claude-haiku-4-5-20251001 | Model for normalize pass |
| `--skip <cats>` | (none) | Comma-separated categories to skip |
| `--verbose` | false | Verbose output |

---

## Output structure

```
<output-dir>/
├── tokens.json              # W3C DTCG 2025.10 — canonical machine truth
├── DESIGN.md                # Brand narrative (stub until narrate pass runs)
├── audit.md                 # Drift report
└── .extractoken/            # Internal state — delete to force clean re-run
    ├── findings.raw.json
    ├── clusters.json
    ├── llm-tasks.json
    ├── prompts/
    │   └── normalize-color.md
    ├── llm-out/
    │   └── normalize-color.json
    └── previous/
        └── tokens.json      # Snapshot for diff on next run
```

---

## Error handling

- `--max-files` exceeded → hard abort with clear error (don't silently degrade)
- Schema validation failure → hard abort with Ajv error details
- DESIGN.md lint failure → hard abort with lint rule details
- LLM task failure → mark task as `error` in manifest; re-run to retry
- Missing Asset Catalog file → finding emitted with `assetMissing: true`, `severity: error`

---

## Installation

This skill is installed at `/Users/conor/Development/Extoken/.claude/skills/extractoken/`. Build before use:

```bash
cd /Users/conor/Development/Extoken/.claude/skills/extractoken
npm install
npm run build
```
