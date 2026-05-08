# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project: conorluddy marketplace + Tokextract plugin

This repo is a **Claude Code plugin marketplace** named `conorluddy`, currently shipping one plugin: **Tokextract**. v1 ships. 246 tests pass. Validated on two distinct SwiftUI apps (Grapla + Ocras).

The marketplace is the user-facing entry point. The plugin lives at `plugins/tokextract/` and contains the entire Tokextract skill (Node/TypeScript) — parsers, analyzers, emitters, LLM prompt generators, schemas, tests.

**Tokextract** reverse-engineers a SwiftUI codebase's design system into three artifacts:

1. `tokens.json` — W3C DTCG 2025.10 design tokens (canonical machine truth)
2. `DESIGN.md` — Google `@google/design.md` alpha brand-narrative companion
3. `audit.md` — drift report (magic numbers, near-duplicate clusters, harmonization recommendations)

Direction is **code → tokens** — the inverse of Specify, Supernova, Tokens Studio, Penpot. No existing tool does this for Swift.

## Repo structure

```
.
├── .claude-plugin/marketplace.json   # marketplace catalog (plugin: tokextract)
├── plugins/
│   └── tokextract/                   # the plugin
│       ├── .claude-plugin/plugin.json
│       ├── skills/extract/SKILL.md   # entry point — Claude reads this when /tokextract:extract is invoked
│       ├── extract.ts                # Node CLI (parse / emit / finalize / plan-harmonize / plan-narrate)
│       ├── parsers/                  # 12 parsers (1 per category + swift-ast bootstrap + info-plist + asset-catalog)
│       ├── analyzers/                # cluster-color, cluster-numeric, drift-detector, usage-scanner, diff
│       ├── emitters/                 # dtcg, design-md, design-md-lint, audit-report
│       ├── llm/                      # normalize, harmonize, narrate, merge (slim-mapping LLM contract)
│       ├── schemas/                  # DTCG 2025.10 + mapping + harmonize JSON schemas
│       ├── tests/                    # 246 vitest tests + 2 golden fixtures (grapla-color-only, ocras-minimal)
│       └── package.json
├── PRD.md                            # product requirements doc — source of truth for what tokextract does
├── EXTOKEN.md                        # original research notes (historical)
├── README.md                         # marketplace overview + invocation
└── CLAUDE.md                         # this file
```

The plan file at `~/.claude/plans/fizzy-forging-ladybug.md` documents the build history (Slices 1 → 5).

## Working in this repo

### Build / test commands (from `plugins/tokextract/`)

```bash
cd plugins/tokextract
npm install
npm run build           # tsc + copy schemas/ to dist/
npm test                # 246 vitest tests
npx biome check .       # lint (54 files)
```

After modifying source, rebuild and refresh the installed plugin: `/plugin marketplace update conorluddy`.

### Invoking the skill

From any Claude Code session:

```
/plugin marketplace add /Users/conor/Development/Extoken    # one-time
/plugin install tokextract@conorluddy                        # one-time
/tokextract:extract --path <swift-repo> --output <dir>       # use it
```

### Test fixtures

- `plugins/tokextract/tests/fixtures/grapla-color-only/` — minimal SwiftUI snippet with 5–10 color declarations + 1 colorset. Exercises the Grapla-style asset-catalog-only pattern.
- `plugins/tokextract/tests/fixtures/ocras-minimal/` — exercises Ocras-style patterns: `Color("X", bundle: .module)`, hex-byte arithmetic in `Color(.sRGB, ...)`, and `enum WidgetFont { static let *Name = "FontName" }` typography abstraction.

Both have golden `tokens.json` snapshots in `expected/`. The e2e test compares actual vs expected.

### Live-test repos (not in this repo)

- `/Users/conor/Development/Grapla` — BJJ tracker, 727 .swift files, 113 colorsets, JetBrainsMono font stack, Liquid Glass usage.
- `/Users/conor/Development/Ocras` — fasting tracker, multi-target (main + Watch + Widgets + FastingKit SPM package), SpaceGrotesk font stack, hex-byte-arithmetic colors.

When validating changes, run both deterministic (`--no-llm`) and live-LLM smokes. The plan file's verification section has the exact commands.

## Load-bearing architectural decisions

Settled — don't relitigate without explicit prompting:

- **Output format: DTCG 2025.10** primary, **Google DESIGN.md (alpha)** secondary, **audit.md** for drift.
- **Language: TypeScript / Node 20+**. tree-sitter-swift (NPM) for parsing — no Swift toolchain dependency. Accept ~5% parser miss rate vs SwiftSyntax.
- **Hybrid extraction:** AST pass (deterministic) → regex side-channel (drift inventory) → LLM normalization pass (naming + harmonization + brand prose). Parse with code, name with AI.
- **Slim-mapping LLM contract** (Slice 1.5). LLM subagents emit only a `Mapping[]` (decl → name + group + description), not full DTCG tokens. Node-side merger joins the mapping with deterministic findings to produce `tokens.json`. Keeps every subagent under the 20k output cap.
- **Lazy-staged LLM pipeline.** SKILL.md has 8 steps. Each LLM stage's manifest entry is appended by a `plan-*` Node helper that runs after the prior stage's outputs land.
- **LLM via host Claude session.** No separate Anthropic API key. The Node helpers emit prompt files + manifest; the host Claude spawns subagents per pending task via the `Agent` tool.
- **`${CLAUDE_PLUGIN_ROOT}` for plugin paths.** SKILL.md references CLI binaries through this variable so the skill works from the cached install location (`~/.claude/plugins/cache/conorluddy/tokextract/<version>/`).
- **Don't auto-apply changes to user source.** Audit output is suggestions with confidence + source line refs.

## Token categories — full scope

All 9 categories ship in v1. See PRD.md §6 for the full pattern catalog. Highlights of patterns added in Slice 4 to handle Ocras (real-world variants Grapla didn't have):

- `Color("Name", bundle: .module)` — SPM-resourced colorsets
- `Color(.sRGB, red: 0xF3 / 255, ...)` — hex byte arithmetic
- `extension Color { static let foo = Color("Bar") }` — declaration aliasing an asset
- `enum WidgetFont { static let heroDisplayName = "SpaceGrotesk-Bold" }` — typography abstraction layer

## Working conventions

- **Repo-agnostic from day one.** Tokextract takes `--path <swift-repo>` and makes no assumptions about app name, font family, or token naming. Test fixtures cover ≥2 distinct Swift apps.
- **Vendor namespace derived, not hardcoded.** From `Info.plist` `CFBundleIdentifier` first, then `.xcodeproj` `PRODUCT_BUNDLE_IDENTIFIER` (multi-target-aware: skips Watch/Widget/Complications). Falls back to `com.unknown.<dirname>`.
- **For UI/visual claims about extracted tokens, you cannot just type-check** — say so explicitly rather than claiming success. The PRD documents both quantitative gates (DTCG validation, parse latency) and qualitative ones (DESIGN.md prose brand-correctness).
- **Never push to main on Grapla/Ocras** — those are user repos used as live test fixtures, never modified by Tokextract.
- **Branch + PR for any meaningful change in this repo.** Main is shipping state.

## Caveats

- DESIGN.md schema is alpha — emitter is isolated to one file (`emitters/design-md.ts`) so swapping is trivial.
- Liquid Glass tokens are iOS-26-only and Apple-proprietary — namespaced under `$extensions.<vendor>.material`, not portable.
- Local-path marketplace source bundles `node_modules/` into the cache copy. For GitHub-hosted distribution later, this won't work — needs esbuild bundle (complicated by tree-sitter-swift native bindings), post-install hook, or npm-package source. Tracked as v2 work.
- Animation tokens emitted under `$extensions.motion` since DTCG motion module is still draft.
