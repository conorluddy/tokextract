# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project: Extractoken

**Pre-code.** The repo currently contains only `EXTOKEN.md` — a research/architecture spec. No source, no build system, no tests, not yet a git repo.

**Extractoken** is a **repo-agnostic** Claude Code skill for extracting a design system from any SwiftUI codebase. Note: `EXTOKEN.md` references a Grapla-specific MVP and a `grapla-design-extract` skill name — that framing is **superseded**. Treat Grapla as one test fixture among many, not the target. The skill should accept any Swift/SwiftUI repo path.

Planned layout:

```
extractoken/                  # Claude Code skill, Node/TypeScript
├── SKILL.md
├── extract.ts                # entry, --path <swift-repo>
├── parsers/                  # tree-sitter-swift AST walkers per token category
├── analyzers/                # numeric/color clustering, drift detection
├── emitters/                 # dtcg.ts, design-md.ts, audit-report.ts
├── llm/                      # normalize / harmonize / narrate prompts
└── schemas/dtcg-2025.10.json
```

## What this tool does

Extracts a design system from a "vibe-coded" SwiftUI app and emits two artifacts in parallel:

1. **`tokens.json`** — W3C DTCG 2025.10 (canonical machine truth)
2. **`DESIGN.md`** — Google `@google/design.md` format (agent-readable narrative companion to `CLAUDE.md`)
3. **`audit.md`** — drift, magic numbers, near-duplicate values, harmonization suggestions

Direction is **code → tokens** (the inverse of Specify/Supernova/Tokens Studio). The spec confirms no existing tool does this for Swift; this is the gap.

## Load-bearing architectural decisions

These are settled — don't relitigate without explicit prompting:

- **Output format: DTCG 2025.10**, primary. **DESIGN.md (alpha)**, secondary. Reject Tokens Studio legacy, Theo, Diez as outputs.
- **Language: TypeScript/Node**, not Swift. Skills ship as Node bundles; avoiding the Swift toolchain dependency is the priority. Accept ~5% parser miss rate.
- **Parser: `alex-pinkus/tree-sitter-swift`** for v1. SwiftSyntax is more accurate but is a v2 `--accurate` opt-in only.
- **Extraction is hybrid: AST pass (deterministic) → regex side-channel (drift inventory) → LLM normalization pass (naming, clustering, prose).** Pure regex is fragile; pure LLM hallucinates. The split is *parse with code, name with AI*.
- **LLM calls run inside the Claude Code session**, reusing the user's context — no separate API key.
- **Don't auto-apply changes to user source.** Audit output is suggestions with confidence + source line references.

## Token categories — full scope

All categories are in scope from day one. The phasing in `EXTOKEN.md` §8 (Color/Typography/Spacing MVP, components in V2) is **superseded**.

- **Color** — `extension Color { static let ... }`, `Color(hex:)`, `Color(.sRGB, ...)`, plus `.xcassets/*.colorset/Contents.json` for light/dark pairs. Preserve system semantic colors (`Color.accentColor`, `.primary`) as aliases, not concretized values.
- **Typography** — `Font.custom("...", size:, relativeTo:)`, custom font enums, `extension Font` accessors, `extension Text { func textStyle...() }`. Preserve `relativeTo:` (Dynamic Type signal). Side-channel: `Info.plist` `UIAppFonts` and SPM `.process("Fonts")` resource bundles.
- **Spacing** — numeric literals in `.padding`, `EdgeInsets`, `VStack/HStack(spacing:)`. Cluster into a 4/8 scale; flag off-scale values as drift.
- **Corner radius / shape** — `.cornerRadius()`, `RoundedRectangle(cornerRadius:style:)`, `.clipShape(...)`. Cluster into a sm/md/lg/xl/full scale.
- **Shadows / elevation** — `.shadow(color:radius:x:y:)`. Cluster by `(radius, y)` tuples.
- **Animation** — `.easeInOut`, `.spring(...)`, `extension Animation { static let ... }`. DTCG motion module is drafty — emit via `$extensions` plus DESIGN.md prose.
- **Components** — `ButtonStyle`, `ViewModifier`, `extension View { func ...Style() }` wrappers, and custom `View` structs that wrap natives. Represent as DTCG composite tokens + `$extensions` for the modifier chain.
- **iOS 26 Liquid Glass** — `.glassEffect(...)`, `GlassEffectContainer`, `glassEffectID`, `.buttonStyle(.glass / .glassProminent)`. No DTCG primitive — use `$extensions.<vendor>.material` (vendor namespace per repo). Audit should flag glass used on cards/lists/media as a violation (Apple guidance: navigation layer only).
- **Theme injection patterns** — custom `EnvironmentKey` + `EnvironmentValues`, `@Entry` macro, `@Observable` theme providers, FluentUI-style Global/Alias/Control token tiers.

## Where the AI matters most

The single highest-leverage AI use is generating the **DESIGN.md prose** — DTCG can be produced deterministically; the *intent* narrative cannot. Other strong AI wins: clustering near-identical colors (deltaE + semantic naming), proposing semantic names for unnamed values, distinguishing primitive vs component tokens. Don't burn tokens having the LLM do AST parsing or hex math.

## Round-trip to Figma

- Variables REST API requires Enterprise plan for PAT scope. For non-Enterprise users, the path is: emit DTCG → user imports via **TokensBrücke** or **Tokens Studio** plugin. Document the import as a manual step; don't try to automate it.
- **Components cannot be created via REST API.** Don't try to round-trip components in v1 — emit a Markdown component spec for the designer to build manually.

## Caveats to remember

- DESIGN.md is alpha; isolate the emitter so swapping the schema is a one-file change.
- Style Dictionary v4 is DTCG-draft-compatible; full 2025.10 support is in v5 (in progress). Pin a specific SD version when integrating.
- Figma native DTCG export omits `description` fields (community-reported late 2025).
- Penpot DTCG export occasionally drifts to Tokens Studio shape — validate exports.
- Liquid Glass tokens are iOS-26-only and Apple-proprietary; don't try to translate them to web/Android.

## Working conventions

- **Repo-agnostic from day one.** Skill takes `--path <swift-repo>` and makes no assumptions about app name, font family, or token naming. Test fixtures should cover ≥2 distinct Swift apps (e.g. Grapla + one other) before any pattern is treated as canonical.
- Vendor namespaces in `$extensions` should be derived from the target repo (e.g. parse bundle ID), not hardcoded.
- For UI/visual claims about extracted tokens, you cannot just type-check — say so explicitly rather than claiming success.
- Commands (build/lint/test) will be added here once a `package.json` exists.
