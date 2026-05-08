# conorluddy — Claude Code plugin marketplace

A small, opinionated marketplace of Claude Code plugins built for indie iOS / SwiftUI work. Currently shipping one plugin: **Tokextract**.

---

## Plugins in this marketplace

### Tokextract — reverse-engineer a SwiftUI design system

Most design-token tools go Figma → code. Tokextract goes the other way. Point it at a SwiftUI codebase and it produces three artifacts:

- **`tokens.json`** — W3C DTCG 2025.10 design tokens. The canonical machine-truth source.
- **`DESIGN.md`** — Google [`@google/design.md`](https://github.com/google-labs-code/design.md) alpha-format brand-narrative companion. Reads like a designer wrote it.
- **`audit.md`** — drift report. Magic numbers, near-duplicate clusters, off-scale values, harmonization recommendations.

The pipeline is hybrid: a deterministic AST walk does the parsing (tree-sitter-swift, 9 token categories), then a chunked LLM pass adds semantic naming and the brand-narrative prose. The values come from your code; the *names* and *intent* come from Claude.

#### What it extracts

| Category | Patterns |
|---|---|
| **Color** | `extension Color`, `Color(hex:)`, `Color(.sRGB,…)`, `Color("Asset", bundle:)`, `Color(.assetName)`, `.foregroundColor(.foo)` shorthand, hex byte arithmetic (`0xF3 / 255`), Asset Catalog `.colorset` walk including dark/HC variants |
| **Typography** | `Font.custom`, `extension Font` static lets, `extension Text { textStyleX() }`, custom font enums (both `: String { case }` and `static let *Name` styles), font-weight inference from PostScript suffix |
| **Spacing** | `.padding(N)`, `.padding(.horizontal, N)`, `EdgeInsets`, `VStack(spacing:)`, `enum Spacing { static let xs = 4 }` |
| **Shape / radius** | `.cornerRadius`, `RoundedRectangle(cornerRadius:style:)`, `UnevenRoundedRectangle`, `Circle/Capsule/Ellipse/ContainerRelativeShape` |
| **Shadow** | `.shadow(color:radius:x:y:)`, `extension View` wrappers |
| **Animation** | `.easeInOut`, `.spring(response:dampingFraction:)`, `withAnimation`, `extension Animation` |
| **Components** | `ButtonStyle`, `ViewModifier`, `extension View` convenience wrappers, custom `View` structs (with confidence tiering) |
| **iOS 26 Liquid Glass** | `.glassEffect()`, `GlassEffectContainer`, content-layer-violation audit flag |
| **Theme injection** | `EnvironmentKey`, `EnvironmentValues` extensions, `@Entry` macro, `@Observable` providers |

Plus a vendor namespace derived automatically from the target's `Info.plist` `CFBundleIdentifier` or `.xcodeproj` `PRODUCT_BUNDLE_IDENTIFIER` (multi-target-aware: skips Watch / Widget / Complications variants).

#### What's validated

Two real iOS apps with structurally distinct token organizations:

| | Grapla (BJJ tracker) | Ocras (fasting tracker) |
|---|---|---|
| .swift files | 727 | ~250 |
| Parse time | 4 seconds | <2 seconds |
| Color tokens | 113 | 23 |
| Typography tokens | 5 | 5 |
| Total DTCG tokens | 270 | 40 |
| Harmonize recommendations | 29 (23 high-conf) | 9 (7 high) |
| DESIGN.md prose | 346 lines (BJJ-correct) | 266 lines (fasting-correct) |
| DESIGN.md lint | 8/8 ✓ | 8/8 ✓ |

Sample LLM-generated DESIGN.md from Ocras:

> *"Ocras is a fasting tracker. Its core job is communicating a single binary state — fasting vs. eating — at a glance, across iPhone, Apple Watch, and multiple widget families. Every design decision flows from that constraint: reduce cognitive load, maximize legibility in small viewports, and let color carry the primary status signal."*

---

## Install

From any Claude Code session:

```
/plugin marketplace add /Users/conor/Development/Extoken
/plugin install tokextract@conorluddy
```

Then invoke as:

```
/tokextract:extract --path <swift-repo> --output <dir>
```

This kicks off the full 8-step pipeline (parse → normalize → plan-harmonize → harmonize → emit → plan-narrate → narrate → finalize). The host Claude session spawns Haiku/Sonnet subagents for the LLM stages — no separate API key needed.

For deterministic / CI use without LLM passes, run the bundled CLI directly:

```bash
node ~/.claude/plugins/cache/conorluddy/tokextract/1.0.0/dist/extract.js \
  parse --path <swift-repo> --output <dir> --no-llm
```

See `plugins/tokextract/README.md` for the full flag reference.

---

## Repository layout

```
.
├── .claude-plugin/
│   └── marketplace.json           # marketplace catalog
├── plugins/
│   └── tokextract/                # the plugin
│       ├── .claude-plugin/
│       │   └── plugin.json        # plugin manifest
│       ├── skills/
│       │   └── extract/
│       │       └── SKILL.md       # skill body — Claude reads this when /tokextract:extract is invoked
│       ├── parsers/               # 11 source files (color, typography, spacing, shape,
│       │                            shadow, animation, component, glass, theme,
│       │                            asset-catalog, info-plist, swift-ast)
│       ├── analyzers/             # cluster-color, cluster-numeric, drift-detector,
│       │                            usage-scanner, diff
│       ├── emitters/              # dtcg, design-md, design-md-lint, audit-report
│       ├── llm/                   # normalize, harmonize, narrate, merge
│       ├── schemas/               # DTCG 2025.10, mapping schema, harmonize schema
│       ├── tests/                 # 246 unit + e2e tests, two golden fixtures
│       ├── extract.ts             # CLI entry (parse / emit / finalize / plan-* subcommands)
│       ├── package.json
│       └── README.md              # plugin-specific docs
├── PRD.md                         # product requirements doc (13 sections, source of truth)
├── EXTOKEN.md                     # original research notes (historical)
├── CLAUDE.md                      # project guide for AI sessions
└── README.md                      # this file
```

---

## Build / develop the plugin locally

```bash
cd plugins/tokextract
npm install
npm run build           # tsc + copy schemas to dist/
npm test                # 246 vitest tests
npx biome check .       # lint (54 files)
```

After modifying source, rebuild and refresh the installed plugin:

```bash
cd plugins/tokextract && npm run build
/plugin marketplace update conorluddy   # in a Claude Code session
```

---

## Architecture in one diagram

```
┌────────────────────────────────────────────────────────────────────┐
│  /tokextract:extract --path <swift-repo>                           │
└──┬─────────────────────────────────────────────────────────────────┘
   │
   ▼  Step 1                                                  [Node]
   parse: tree-sitter-swift × 9 category parsers (shared parse tree;
   Query cache; ~4s on 727 files)
   → findings.raw.json + clusters.json + LLM task manifest
   │
   ▼  Step 2                                            [host Claude]
   normalize: spawns 1-N Haiku subagents in parallel (≤50 declarations
   per chunk) per category. Slim Mapping[] output.
   │
   ▼  Step 3                                                  [Node]
   plan-harmonize: appends harmonize task to manifest.
   │
   ▼  Step 4                                            [host Claude]
   harmonize: spawns Sonnet subagent. Outputs ranked recommendations
   with confidence labels.
   │
   ▼  Step 5                                                  [Node]
   emit: merges all LLM outputs + deterministic findings → DTCG-valid
   tokens.json + audit.md (with diff section if previous run exists).
   │
   ▼  Step 6                                                  [Node]
   plan-narrate: appends narrate task referencing tokens.json + audit.md.
   │
   ▼  Step 7                                            [host Claude]
   narrate: Sonnet subagent reads the artifacts and writes DESIGN.md
   directly via Write tool.
   │
   ▼  Step 8                                                  [Node]
   finalize: 8-rule DESIGN.md lint + summary print.
   │
   ▼
   tokens.json · DESIGN.md · audit.md
```

`--no-llm` mode skips Steps 2, 3, 4, 6, 7. Steps 5 + 8 still run. Token names become mechanical (`color-1A1C1E`); DESIGN.md becomes a deterministic stub.

---

## Status & roadmap

**v1 ships.** Validated against two distinct SwiftUI apps with full LLM-generated brand prose. 246 tests pass. DTCG 2025.10 schema validation. Local-path marketplace distribution works end-to-end.

**Known v1 limitations** (all documented in `plugins/tokextract/README.md`):
- Local-path source only — pushing to GitHub requires bundling `node_modules/` somehow (esbuild bundle, post-install hook, or npm-package source).
- Max 2,000 `.swift` files per repo (`--max-files`).
- DESIGN.md schema is alpha (Google `@google/design.md`).
- No SPM target awareness — orphan-token detection is a single-target union walk.

**v2 candidates:**
- GitHub-hosted marketplace distribution
- esbuild bundle to handle native deps
- SwiftSyntax `--accurate` parser (opt-in for Apple-toolchain users)
- Direct Figma Variables REST API push (Enterprise)
- `--watch` mode
- UIKit fallback
- MCP server for non-Claude-Code agents

---

## License

MIT. See [LICENSE](LICENSE) (TODO).

## Maintainer

Conor Luddy · `conorluddy@gmail.com` · [github.com/conorluddy](https://github.com/conorluddy)
