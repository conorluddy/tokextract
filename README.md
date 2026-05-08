# Conor Luddy's Claude Code Plugin Marketplace

A small marketplace of Claude Code plugins. Currently shipping one plugin: **Tokextract**.

## Plugins

### tokextract

Reverse-engineer a SwiftUI app's design system into:
- **`tokens.json`** — W3C DTCG 2025.10 design tokens (canonical machine truth)
- **`DESIGN.md`** — Google `@google/design.md` alpha format brand-narrative companion
- **`audit.md`** — drift report with magic numbers, near-duplicate clusters, and harmonization recommendations

Goes the opposite direction of every other token tool — code → tokens, not Figma → code. Validated on two distinct SwiftUI apps (a BJJ tracker and a fasting tracker) with end-to-end LLM-driven extraction.

See `plugins/tokextract/README.md` for the full spec and flag reference.

## Install

From a Claude Code session:

```
/plugin marketplace add /Users/conor/Development/Extoken
/plugin install tokextract@conorluddy
```

Then invoke as:

```
/tokextract:extract --path <swift-repo> --output <dir>
```

For deterministic / CI use without LLM passes, run the bundled CLI directly. See `plugins/tokextract/README.md`.

## Repository structure

```
.
├── .claude-plugin/marketplace.json    Marketplace catalog
├── plugins/
│   └── tokextract/                    Tokextract plugin (skill + Node tooling)
├── PRD.md                             Original product spec
├── EXTOKEN.md                         Research notes (historical)
├── CLAUDE.md                          Project guide for AI sessions
└── README.md                          (this file)
```

## Status

v1 ships. Distribution is local-path-source for now (this repo). Future plans: GitHub-published marketplace, npm-distributed plugin to handle dependency installation, then eventual submission to a public Claude Code marketplace registry.

## License

MIT.
