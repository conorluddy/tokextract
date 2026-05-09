# Tokextract — Figma plugin

Imports a Tokextract `tokens.json` (DTCG 2025.10) into Figma as **Variables**, **text styles**, **effect styles**, and an auto-generated **spec page**.

Companion to the [Tokextract Claude Code plugin](../tokextract/) — that one extracts tokens from a SwiftUI codebase, this one ingests the result into a Figma file.

## Status

`v0.1.0` — scaffolded, not yet published. Lives in `feat/figma-plugin`.

## What it imports

| DTCG `$type`  | Figma representation                            |
|---------------|-------------------------------------------------|
| `color`       | `COLOR` variable                                |
| `dimension`   | `FLOAT` variable (px-normalised)                |
| `number`      | `FLOAT` variable                                |
| `fontFamily`  | `STRING` variable                               |
| `fontWeight`  | `FLOAT` variable (numeric weight)               |
| `duration`    | `FLOAT` variable (ms-normalised)                |
| `cubicBezier` | `STRING` variable (`cubic-bezier(...)`)         |
| `typography`  | Text style                                      |
| `shadow`      | Effect style (drop or inner)                    |
| `$extensions.<vendor>.material` | `STRING` variable (JSON serialised) |

Materials (Liquid Glass et al.) have no native Figma equivalent — we import them as JSON-serialised string variables so designers can at least see what the codebase declared.

## Develop

```bash
cd plugins/tokextract-figma
npm install
npm run build       # → dist/code.js, dist/ui.html
```

In Figma desktop: **Plugins → Development → Import plugin from manifest…** → select `manifest.json`.

## Use

1. Run the plugin in any Figma file.
2. Paste your Tokextract `tokens.json` (or upload it).
3. Set a collection name and choose whether to generate a spec page.
4. Click **Import**.

Variables land in the named collection, text styles and effect styles in their respective panels, and (if checked) a `Tokextract — Tokens` page is created with swatches / type ramp / spacing bars.

## Architecture

```
src/
  code.ts            # Figma sandbox entry — message handler, orchestrator
  ui.ts / ui.html    # iframe UI — paste + import button
  dtcg.ts            # DTCG types + flatten()
  color.ts           # hex / DTCG color → Figma RGBA
  importers/
    color.ts         # COLOR variable
    dimension.ts     # FLOAT variable (px-normalised)
    number.ts        # bare number / opacity
    typography.ts    # fontFamily, fontWeight, typography (text style)
    motion.ts        # duration, cubicBezier
    shadow.ts        # effect style
    material.ts      # $extensions.<vendor>.material
  spec-page.ts       # generated page builder
```

`dtcg.ts#flatten()` turns the nested DTCG tree into a flat list of `{ path, name, type, value }`. The router in `importers/index.ts` dispatches each token to its category importer.

## Caveats

- Token aliases (`{color.primary.500}` reference syntax) are resolved by name lookup at the end of import; circular references are skipped with a warning. Not yet implemented — see TODO.
- `gradient`, `border`, `strokeStyle`, `transition` composites: not in v1, will route to the spec page only.
- Modes are single (default `Mode 1`). Light/dark mode support is straightforward but waits for Tokextract to start emitting `$extensions.tokextract.modes`.
