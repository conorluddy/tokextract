# Tokextract

Reverse-engineer a SwiftUI app's design system into DTCG tokens, brand-narrative DESIGN.md, and an audit report.

---

## What it does

Every major token platform — Specify, Supernova, Tokens Studio, Penpot — flows from Figma to code. Tokextract runs the opposite direction: Swift source is the source of truth, and it recovers the implicit design system already living there.

Given a `--path` to any SwiftUI repo, Tokextract emits three artifacts:

| Artifact | Format | Purpose |
|---|---|---|
| `tokens.json` | W3C DTCG 2025.10 | Machine-readable canonical token inventory. Pipe directly into Style Dictionary. |
| `DESIGN.md` | Google `@google/design.md` alpha | LLM-readable brand narrative. Lives next to `CLAUDE.md`; feeds brand context to AI coding sessions. |
| `audit.md` | Markdown | Drift report: magic numbers, near-duplicate color clusters, off-scale spacing, Liquid Glass violations, harmonization suggestions. |

All 9 token categories are extracted in a single run: color, typography, spacing, corner radius, shadow, animation, components, Liquid Glass materials, and theme injection patterns.

---

## Installation

Tokextract is a Claude Code plugin in the `conorluddy` marketplace. End users install via:

```
/plugin marketplace add conorluddy/tokextract
/plugin install tokextract@tokextract
```

For local development on the plugin source (Node 20+):

```bash
cd plugins/tokextract
npm install
npm run build           # tsc + copy schemas to dist/
npm test                # 246 vitest tests
npx biome check .       # lint
```

After modifying source, refresh the installed plugin: `/plugin marketplace update tokextract`.

---

## Invocation

### Full pipeline (LLM mode)

Run from inside a Claude Code session:

```
/tokextract --path <swift-repo> [--output <dir>]
```

This triggers the 8-step pipeline. Steps 2, 3, 4, 6, and 7 spawn subagents (Haiku for normalize, Sonnet for harmonize/narrate). LLM mode produces semantic token names and the full brand-narrative `DESIGN.md`.

Default output directory: `<swift-repo>/.tokextract-out/`

### `--no-llm` mode (CI / deterministic)

Safe for automated pipelines. LLM steps are skipped; token names are mechanical (e.g. `color-1A1C1E`); `DESIGN.md` is a stub. Steps 1, 5, and 8 still run.

```bash
node dist/extract.js parse --path <repo> --output <out> --no-llm
node dist/extract.js emit  --output <out> --no-llm
node dist/extract.js finalize --output <out> --no-llm
```

---

## Flags

All flags apply to the `parse` subcommand unless noted.

| Flag | Default | Description |
|---|---|---|
| `--path <dir>` | (required) | Swift repo root |
| `--output <dir>` | `<path>/.tokextract-out` | Output directory |
| `--no-llm` | false | Skip LLM passes |
| `--max-files <n>` | 2000 | Hard limit on `.swift` files scanned |
| `--delta-e-threshold <n>` | 2.5 | CIEDE2000 distance used for near-duplicate color clustering |
| `--skip <category,...>` | (none) | Comma-separated categories to skip (e.g. `animation,shadow`) |
| `--force-color-space {srgb\|display-p3\|oklch}` | (auto) | Override output color space |
| `--target-os <ver>` | (auto-detect) | Target iOS version; gates Liquid Glass (26) and `@Entry` (18) extraction |
| `--vendor-namespace <s>` | (from Info.plist) | Override the `$extensions` vendor key (default: derived from `CFBundleIdentifier`) |
| `--model-normalize <id>` | `claude-haiku-4-5-20251001` | Model for normalize pass |
| `--model-harmonize <id>` | `claude-sonnet-4-6` | Model for harmonize pass |
| `--model-narrate <id>` | `claude-sonnet-4-6` | Model for narrate pass |
| `--self-critique` | false | Run a self-critique pass after narrate; appends fragment to `audit.md` |
| `--verbose` | false | Per-category counts and timing |

---

## Output structure

```
<output-dir>/
├── tokens.json        # W3C DTCG 2025.10 — all 9 categories, Ajv-validated
├── DESIGN.md          # Brand narrative (stub in --no-llm mode)
├── audit.md           # Drift report: 7 sections
└── .tokextract/      # Internal state — delete to force a clean re-run
    ├── findings.raw.json
    ├── clusters.json
    ├── numericClusters.json
    ├── drift.json
    ├── meta.json
    ├── llm-tasks.json
    ├── prompts/
    │   ├── normalize-color-1.md
    │   ├── harmonize.md
    │   └── narrate.md
    ├── llm-out/
    │   ├── mapping.color.1.json
    │   └── mapping.harmonize.json
    └── previous/
        └── tokens.json   # Snapshot for diff on next run
```

Delete `.tokextract/` to force a full re-parse. Subsequent runs diff `tokens.json` against `previous/tokens.json` and append a "Changes since last extraction" section to `audit.md`.

---

## Figma import

Direct Variables REST API push requires an Enterprise Figma plan (v2 scope). The manual path works today:

1. Run Tokextract to produce `tokens.json`.
2. Import `tokens.json` into Figma via the **TokensBrücke** or **Tokens Studio** plugin.
3. Variable Collections and Modes appear automatically from the DTCG group structure.

Component tokens are emitted as Markdown specs in `DESIGN.md` — the REST API does not support programmatic component creation, so that step remains a manual designer build.

---

## Pipeline architecture

```
parse
  → normalize (parallel Haiku chunks, ≤50 declarations each)
  → plan-harmonize
  → harmonize (single Sonnet pass)
  → emit
  → plan-narrate
  → narrate (single Sonnet pass — writes DESIGN.md directly)
  → finalize
```

Steps 2, 3, 4, 6, and 7 are LLM passes. All are skipped in `--no-llm` mode. The pipeline is restartable: if any LLM task fails it is marked `error` in `llm-tasks.json` and resumes on the next invocation.

The extraction approach is hybrid: deterministic AST parse + regex side-channel for finding values, then LLM normalization for naming and narrative. The LLM never touches hex math or DTCG structure — those are computed in Node. This keeps token *values* correct even when the naming pass degrades.

---

## What the narrate pass produces

The highest-leverage LLM step is `narrate`, which writes the full brand narrative in `DESIGN.md`. Two examples from validated runs:

**Ocras (fasting tracker):**

> Ocras is a fasting tracker. Its core job is communicating a single binary state — fasting vs. eating — at a glance, across iPhone, Apple Watch, and multiple widget families. Every design decision flows from that constraint: reduce cognitive load, maximize legibility in small viewports, and let color carry the primary status signal.

> `{{color.semantic.state-fasting}}` and `{{color.semantic.state-eating}}` are the only saturated hues in the palette. Using any other saturated color creates visual ambiguity about fasting state — avoid it. The disabled grey `{{color.semantic.state-disabled}}` sits within ΔE 1.49 of `{{color.semantic.ink-dim-dark}}` (audit Cluster F). These are semantically distinct: disabled signals interactive unavailability, ink-dim signals secondary hierarchy. Always use the token that matches the intent, not the one that looks similar.

**Grapla (BJJ tracker — deterministic stub, LLM prose available after `--no-llm` run):**

> Grapla design system extracted by Tokextract. 269 tokens across 6 categories. Primary brand accent: `{{color.semantic.accent-primary}}` (#FFC918). Belt rank colors (`color.semantic.belt-*`) map directly to BJJ rank progression from white through black.

---

## Limitations

- **Max 2000 `.swift` files.** Extraction aborts with a clear error above this limit. No silent degradation.
- **No SPM target awareness in v1.** All `.swift` files under `--path` are scanned as a single namespace. Cross-target findings can produce false-positive orphan-token warnings when two targets define overlapping names.
- **`DESIGN.md` schema is alpha.** The Google `@google/design.md` format may change; the emitter is isolated to `emitters/design-md.ts` for easy replacement.
- **Liquid Glass tokens are iOS 26-only.** They are not portable to web or Android. The audit flags any Glass usage outside navigation-layer contexts per Apple HIG guidance.
- **LLM mode requires a Claude Code session.** Subagents are spawned by the host Claude via the `Agent` tool. Running `extract.js` directly in a terminal skips LLM passes regardless of flags.
- **Animation tokens use `$extensions.motion`.** The DTCG motion module is still in draft; animation tokens are emitted under `$extensions.<vendor>.motion` rather than as first-class `$type: "motion"` tokens.
- **UIKit-only codebases are not supported in v1.** Extraction targets SwiftUI constructs. Mixed SwiftUI/UIKit apps work; UIKit-only apps will return sparse or empty findings.

---

## Tested fixtures

Validated on two structurally distinct apps:

- **Grapla** — BJJ training tracker. 727 `.swift` files, 113 colorsets, JetBrainsMono typography, single iOS target, 100% Asset Catalog color organization.
- **Ocras** — fasting tracker. Multi-target: main app + Watch complications + Widgets + FastingKit SPM package. Mixed `extension Color` + asset-catalog color patterns. SpaceGrotesk + AzeretMono type stack. Pre-existing `DesignTokens/Colors.swift` in FastingKit.

Both fixtures produce DTCG-valid `tokens.json` and DESIGN.md lint-clean at 8/8 rules.

---

## Future plans

v2: Figma Variables REST API push, SwiftSyntax parser as `--accurate` opt-in, MCP server, UIKit fallback. Eventual destination: Claude Code plugin / marketplace.
