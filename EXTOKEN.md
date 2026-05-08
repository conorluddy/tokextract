# Extracting Design Systems from "Vibe-Coded" SwiftUI Apps: A Technical Research Report

**TL;DR**
- **Build a hybrid Claude Code skill that combines a deterministic SwiftSyntax-based extractor with an LLM semantic-classification pass, emitting two artifacts in parallel: a W3C DTCG `tokens.json` (the canonical, machine-truth source) and a Google `DESIGN.md` (the agent-truth narrative). DTCG reached its first stable version 2025.10 in October 2025 and is now the only spec worth betting on; treat Style Dictionary v4+ as the build/round-trip engine and DESIGN.md as the LLM-friendly companion.**
- **For Grapla specifically, the highest-leverage extractions are: (1) `Color` extension static lets + Asset Catalog colorsets (light/dark pairs), (2) the JetBrains Mono custom-font typography stack — `Font.custom(...)` calls, `relativeTo:` pairings, and weight/size scales, (3) magic-number padding/spacing literals to harmonize into a 4/8 scale, (4) `ButtonStyle`/`ViewModifier` definitions as component tokens, and (5) iOS 26 `.glassEffect()` usage as a separate "material layer" token group. SwiftSyntax (Apple-official) is the right parser; tree-sitter-swift is a viable JavaScript/Node fallback if you want the skill to run without a Swift toolchain.**
- **Recommended MVP architecture (2–3 weekends): a Claude Code skill `grapla-design-extract` that walks the repo with SwiftSyntax → emits raw findings JSON → LLM normalization pass classifies/groups/names tokens → outputs `tokens.json` (DTCG), `DESIGN.md`, and a Markdown audit report flagging drift. Round-trip to Figma via Tokens Studio plugin or Style Dictionary → Figma Variables REST API. Skip building component-shape extraction in v1; that's the long-tail problem where AI value drops sharply.**

---

## Key Findings

1. **DTCG 2025.10 is the new standard.** Released October 28, 2025 by the W3C Design Tokens Community Group, this is the first *stable* version after years of drafts. It defines `$value`/`$type`/`$description`, group inheritance, aliasing via `{path.to.token}`, modern color spaces (Display P3, Oklch, CSS Color Module 4), themes/modes, and resolvers. Style Dictionary v4 has first-class DTCG support; Tokens Studio, Penpot, Figma (via beta variable export), Knapsack, Supernova, zeroheight, and Terrazzo all support or are implementing it.

2. **Google's DESIGN.md is the agent-native companion, not a competitor.** Released as open-source in early 2026 (alpha), `@google/design.md` is YAML front-matter tokens + Markdown prose, designed specifically to be read by coding agents (Claude Code, Cursor). It has a CLI (`lint`, `diff`, `export --format dtcg|tailwind|css-tailwind|json-tailwind`), Apache-2.0 licensed, and explicitly exports to DTCG. The pattern to copy is: tokens for machines, prose for *why*. It's already at 11.3k GitHub stars.

3. **Style Dictionary remains the workhorse build engine** — but you should use it in DTCG mode, not its legacy `value`/`type` format. It ships built-in `ios-swift` and `ios-swift-separate-enums` transform groups producing `UIColor`/`Color` extensions and CGFloat enums. Custom actions can also generate `.xcassets` Colorsets with light/dark pairs. For a code-→-tokens flow, you use SD *in reverse* — you generate the JSON, not start from it.

4. **No existing tool does code→tokens for Swift well.** Specify, Supernova, Tokens Studio, Knapsack, Penpot, zeroheight, and Diez (archived) all extract tokens *from Figma/Sketch* and emit code. The reverse direction — Swift code → DTCG → Figma — is the gap. Supernova has a Swift exporter (Color/Token, Gradient.Token, AppMeasures), confirming the target shape, but no importer. Diez had this conceptually right (TypeScript as source of truth, transpile to native) but is archived. This validates building your own.

5. **SwiftSyntax is the correct parser, not regex.** It's Apple-maintained, ships with Swift 5.9+ as `swiftlang/swift-syntax`, and gives you a typed AST (`SourceFileSyntax`, `ExtensionDeclSyntax`, `VariableDeclSyntax`, `FunctionCallExprSyntax`, etc.). It does NOT give you semantic/type information (use SourceKit-LSP for that), but for token extraction you don't need types — you need to find `extension Color { static let foo = ... }` patterns, and SwiftSyntax handles that perfectly. SwiftSemantics (a thin layer over SwiftSyntax) makes declaration-walking more ergonomic.

6. **Tree-sitter-swift is the viable Node.js alternative** for an extractor that runs without a Swift toolchain installed. `alex-pinkus/tree-sitter-swift` is the maintained fork (the official `tree-sitter/tree-sitter-swift` is marked WIP and points to alex-pinkus). Available as Rust crate, NPM package, and Python bindings. Less semantically accurate than SwiftSyntax but good enough for design-system pattern-matching, and crucially, it lets the Claude Code skill be a single-bundle Node script.

7. **The hybrid extraction pattern is winning.** Recent literature (CodeAgents, CODESTRUCT, agentic skill design) and practitioner blogs converge on: deterministic AST extraction → LLM normalization/semantic naming → human review. Pure regex is fragile; pure LLM is hallucinatory and expensive on big codebases. The right split is *parse with code, name with AI*.

8. **Figma round-trip is solved by Tokens Studio + Style Dictionary, or directly via the Figma Variables REST API** (Enterprise-only for PAT-based access; otherwise plugin-based). TokensBrücke and tokenhaus are mature plugins that import DTCG JSON and create Variable Collections with modes preserved; Figma added native DTCG-based import/export at Schema 2025 (rolling out late 2025). Plan to support both paths.

9. **iOS 26 Liquid Glass needs its own token category.** `.glassEffect()`, `.glassEffect(.regular.tint(...).interactive())`, `GlassEffectContainer`, and `glassEffectID` aren't representable as primitive tokens — they're a *material* layer. DESIGN.md doesn't have a slot for this; DTCG doesn't either. Use DTCG `$extensions.com.grapla.material` for custom material tokens, and document the rationale in DESIGN.md prose.

10. **Design system audits already use the methodology you'll automate.** Practitioner guides (Erica Scolaro, DOOR3, Lazarev, Customer.io, Aufait UX) describe a consistent flow: extract from code → extract from design → reconcile → output recommendations. Your skill should mirror this, with the AI doing the labor-intensive reconciliation/naming/clustering step that currently takes a designer 1–2 weeks.

---

## Details

### 1. Design System Specifications & Formats

**W3C DTCG 2025.10 (the one to use).** The Design Tokens Community Group, chaired by Kaelig Deloumeau-Prigent, published the first stable spec (`Design Tokens Format Module 2025.10`) on October 28, 2025. JSON-based, file media type `application/design-tokens+json` with `.tokens` or `.tokens.json` extensions. Core structure:

```json
{
  "color": {
    "$type": "color",
    "primary": {
      "$value": { "colorSpace": "srgb", "components": [0.067, 0.537, 1.0] },
      "$description": "Primary action color"
    },
    "primary-hover": { "$value": "{color.primary}" }
  }
}
```

Key 2025.10 capabilities: Display P3/Oklch/all CSS Color Module 4 spaces; multi-file support; resolvers module; theming with no file duplication; rich aliasing (`{path.to.token}`); composite tokens (typography, border, shadow, gradient); `$extensions` namespace for vendor-specific data using reverse-domain notation. The Format Module is split from Color/Motion/Typography modules that depend on it. Adopting orgs include Adobe, Amazon, Google, Microsoft, Meta, Salesforce, Shopify, Sony, Pinterest, Disney, NYT, GM, Intuit. **For Grapla: this is the canonical output format. Period.**

**Google DESIGN.md (the AI-companion format).** Open-sourced as `google-labs-code/design.md` on GitHub (Apache-2.0, currently `alpha`). YAML front-matter for machine-readable tokens + ##-section Markdown prose for rationale. Sections are ordered: Overview → Colors → Typography → Layout → Elevation & Depth → Shapes → Components → Do's and Don'ts. The CLI exports to Tailwind v3 JSON, Tailwind v4 CSS, or DTCG JSON. The lint rules (`broken-ref`, `missing-primary`, `contrast-ratio`, `orphaned-tokens`, `token-summary`, `missing-sections`, `missing-typography`, `section-order`) are exactly the audit checks you'd want to run on a vibe-coded extraction. **Strength**: optimized for LLM context — Markdown is the highest-fidelity format for transformer models. **Weakness**: limited token types (no animation, no shadow primitives natively); component model is shallow. **Verdict for Grapla**: emit DESIGN.md *alongside* DTCG JSON, where DTCG is the truth and DESIGN.md is the agent-readable summary that lives next to `CLAUDE.md`.

**Style Dictionary (the build/transform engine).** Created at Amazon (now under `style-dictionary` org), v4 has DTCG `$value`/`$type`/`$description` first-class support; v5 (in progress) adds full 2025.10 support including the new dimension object, all 14 DTCG color spaces (`srgb`, `display-p3`, `oklch`, `lab`, etc.), and resolvers. Built-in iOS transform groups include `ios-swift`, `ios-swift-separate-enums`. The `color/UIColorSwift` transform converts hex to `UIColor(red:..., green:..., blue:..., alpha:...)`. **You'll use it in reverse** — your extractor emits DTCG JSON, then dev consumers can pipe through SD to regenerate canonical Swift if they want. SD also has a `colorset` action (custom) for emitting `.xcassets` color sets with light/dark variants.

**Tokens Studio format.** The legacy Figma Tokens format predates DTCG; Tokens Studio now supports both "legacy" and "W3C DTCG" formats with one-click conversion. Key differentiator: **math expressions in token values** (e.g., `{spacing.small} * 2`, `{spacing.base} + 4`), evaluated by the JavaScript Expression Evaluator. Resolved by `@tokens-studio/sd-transforms` package. The legacy format uses `value`/`type`/`description` (no `$`), nested `typography` composite, and a `$themes` array for theme selection. Penpot natively exports W3C DTCG; community report (Nov 2025) noted Penpot's export still occasionally drifts toward Tokens Studio shape — verify against 2025.10 if integrating. **For Grapla**: don't emit Tokens Studio format. Emit DTCG. Tokens Studio (or Penpot) can import DTCG natively now.

**Theo (Salesforce, archived).** Public-archived on GitHub. Predates DTCG. YAML/JSON5-based with `aliases`, `props`, `imports`, predicate-based value transforms, Handlebars formats. Historically generated SCSS/CSS/JS/iOS/Android. Conceptually a forerunner of Style Dictionary. **Mention only for completeness — do not adopt.**

**Diez (archived).** TypeScript-as-source-of-truth design system framework. Compiled to native iOS/Android/Web SDKs. Conceptually elegant — write tokens once in TypeScript, get autocomplete in Swift — but project went stale ~2021–2022. The "extractors" pulled from Figma/Sketch/Adobe XD/InVision DSM into Diez TypeScript. **Lesson for Grapla**: Diez was designer-centric (extract from design tools); your tool inverts this (extract from code). Same plumbing, opposite direction.

**Penpot.** Open-source design tool, *first to natively support DTCG* (in collaboration with Tokens Studio, 2023–2025). Tokens panel with `+` to create tokens; supports aliases via `{}` syntax and math expressions. Export as single JSON or multi-file ZIP. Some users report current export still leans Tokens Studio-shaped rather than strict 2025.10 — keep an eye on this if Penpot becomes the Figma alternative.

**Side-by-side recommendation:**

| Format | Status | Best for | Use in Grapla? |
|---|---|---|---|
| DTCG 2025.10 | Stable, vendor-neutral standard | Single source of truth, build pipelines | **YES — primary output** |
| DESIGN.md | Alpha, agent-optimized | LLM context files (CLAUDE.md companion) | **YES — secondary output** |
| Style Dictionary native | v3 legacy, v4 DTCG-compat | Build/transform layer | Yes — runtime, not output format |
| Tokens Studio | Mature, math expressions | Figma plugin import | Optional, only if user uses TS |
| Theo | Archived | Reference only | No |
| Diez | Archived | Reference only | No |
| Penpot tokens | Open-source DTCG-aligned | Figma alternative path | Optional |

### 2. Existing Token Extraction Tools

**Specify (specifyapp.com).** Cloud platform with REST API and CLI. Sources include Figma styles + variables, Tokens Studio JSON (sync via GitHub URL like `https://api.github.com/repos/{owner}/{repo}/contents/{file_path}`), JSONBin, GitLab, Azure DevOps. Extractor parsers are open-source. Bidirectional Figma↔code via GitHub PRs. **Architecture lesson**: separate "sources" from "destinations" — useful pattern for your skill (the Swift codebase is one source; could later add Figma as another to enable reconciliation).

**Knapsack (knapsack.cloud).** Enterprise design-system platform. Imports Figma Variables/Collections/Modes via plugin, manages tokens visually but stores in code (Git-backed via npm). Multi-renderer (React/Vue/Angular/Twig/Handlebars). Enterprise-only pricing. **Lesson**: token-as-code with visual editing UI; not relevant for solo dev workflow.

**Supernova (supernova.io).** Closest to what you want, in reverse: imports from Figma Variables/Tokens Studio, generates production code via "exporters" (templated with their Pulsar templating engine, Handlebars-like). The official iOS SwiftUI exporter (`Supernova-Studio/exporter-ios`) generates exactly the shape Grapla likely already has:

```swift
extension Color {
  static let Token = Color.TokenColor()
  struct TokenColor {
    let primary = Color(.sRGB, red: 69/255, green: 137/255, blue: 255/255, opacity: 1)
  }
}
extension Text {
  func textStyleUi11Regular() -> some View {
    return self.font(Font.custom("PoppinsRegular", size: 11))
  }
}
```

**Lesson**: Supernova's exporter output is your **target reverse pattern**. Your extractor should be able to detect this exact pattern and read it back to tokens. Supernova explicitly markets itself as "AI-ready ground truth."

**Tokens Studio (Figma plugin).** Single most-mentioned tool. Bidirectional Figma↔JSON sync via GitHub/GitLab/Azure/JSONBin. Now supports W3C DTCG format toggle. Math expressions, multi-mode themes, `$themes` selection. Companion `@tokens-studio/sd-transforms` npm package handles the unique-to-Tokens-Studio things (color modifiers, lineheight %, fontweight names → numbers, opacity %, math resolution). **Use this for the Figma direction** of your round-trip.

**design-tokens.dev / design.dev.** Community resource with concise guides on token categorization (primitive/semantic/component) and modern workflow (design → export → transform → distribute → consume → update). Useful as link in your skill's `SKILL.md`.

**Diez.** As above — archived but conceptually closest to "code as source of truth." Its `extractors` ran from design tools → Diez TS; you're doing the opposite.

**Modulz / Stitches.** Stitches is a CSS-in-JS library; Modulz was the company. Token-system pattern they popularized: theme-as-typed-config-object. Stitches is in maintenance mode (creator joined Vercel). **Influence, not target.**

**Penpot.** As above. Best open-source design-tool pairing for an open-source extraction skill.

**Zeroheight.** Documentation-first. Imports DTCG JSON or syncs from GitHub repo, supports `@token` inline mentions in docs, 2-way GitHub sync via PRs, exports back to W3C format. **Worth integrating** if your user wants documentation, not just tokens.

**Tools that extract FROM code.** This is the gap you're filling. The closest things:
- `Manavarya09/design-extract`: extracts from *web* URLs (CSS/HTML via Playwright) → DTCG, with MCP server for Claude Code, Cursor, Windsurf, multi-platform emitters including SwiftUI. Not Swift→tokens, but the architecture (Playwright crawler → 9 extractor modules → 4 formatter modules including DTCG and Tailwind) is a useful template.
- Sketch2React's "Stratos Tokens API": extracts from Figma documents only.
- Nothing extracts FROM Swift code to tokens. **Confirmed gap.**

### 3. Swift/SwiftUI-Specific Patterns to Extract

For Grapla, the parser should look for the following patterns. (Effort/value rated: ★ low → ★★★★★ high.)

**Color (★★★★★ — start here):**
- `extension Color { static let primary = Color(...) }` — semantic token definitions
- `extension Color { static let primary = Color("PrimaryColor") }` — Asset Catalog reference (extract the Catalog name, then read the `.colorset/Contents.json` for sRGB components and dark/light variants)
- Hex literal parsing: `Color(hex: "#1A1C1E")` patterns and inline literal usage
- `Color(.sRGB, red:..., green:..., blue:..., opacity:...)` — explicit form (Supernova-style)
- `Color(red:..., green:..., blue:...)` — implicit sRGB
- `Color(uiColor: UIColor.systemIndigo)` — system semantic colors (preserve as semantic alias to system tokens)
- ColorScheme-conditional patterns: `init(dark:light:)` extensions (`UITraitCollection`-based)
- The `@Environment(\.colorScheme)` paired with conditional color picks (treat as theme tokens)

**Typography (★★★★★ — JetBrains Mono is the headline feature):**
- `Font.custom("JetBrainsMono-Regular", size: 18, relativeTo: .body)` — note the `relativeTo:` for Dynamic Type pairing
- Custom enum patterns: `enum JetBrainsMono: String { case regular, bold, ... }` (typical SPM packaging)
- `extension Font { static let jetBrainsMono = ... }` static accessors
- `Font.TextStyle` extensions defining size scales (Apple's set: largeTitle/title/title2/title3/headline/body/callout/subheadline/footnote/caption/caption2)
- `.font(.custom(...))` direct call sites with magic numbers — these are *drift indicators*
- `extension Text { func bodyMd() -> some View { font(...) } }` — text style modifier patterns
- Dynamic Type: presence/absence of `relativeTo:` parameter on `.custom()` calls indicates accessibility readiness
- `Info.plist` `UIAppFonts` array — list of registered font files (parse as side-channel)
- SPM `.process("Fonts")` resource bundles for font registration via `CTFontManagerRegisterGraphicsFont`

For Grapla's "single font family with size/weight/spacing variants" pattern, the extracted typography block in DTCG should look like:

```json
"typography": {
  "$type": "typography",
  "body-md": {
    "$value": {
      "fontFamily": "JetBrainsMono-Regular",
      "fontSize": "16px",
      "fontWeight": 400,
      "lineHeight": 1.5,
      "letterSpacing": "0"
    }
  }
}
```

**Spacing (★★★★ — the "magic number" goldmine):**
- `.padding(16)`, `.padding(.horizontal, 24)`, `EdgeInsets(top: 8, leading: 12, bottom: 8, trailing: 12)`
- `enum Spacing { static let xs: CGFloat = 4; static let sm: CGFloat = 8; ... }` (Lato pattern)
- `VStack(spacing: 12)`, `HStack(spacing: 8)` parameter values
- Heuristic clustering: collect every numeric literal used as a spacing argument; cluster into a 4/8 scale (xs=4, sm=8, md=16, lg=24, xl=32, 2xl=48). Flag values not on the scale as "drift candidates."

**Corner Radius / Shape (★★★):**
- `.cornerRadius(12)` and `RoundedRectangle(cornerRadius: 12)` literals
- `.clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))`
- Custom shape extensions
- Cluster these similarly: sm=4, md=8, lg=12, xl=16, full=∞

**Shadows / Elevation (★★):**
- `.shadow(color:, radius:, x:, y:)` patterns
- Cluster by `(radius, y)` tuples — identifies the elevation scale

**Animation (★★):**
- `.animation(.easeInOut(duration: 0.3))`, `.spring(response: 0.5, dampingFraction: 0.8)`
- Custom `extension Animation { static let standard = ... }` patterns
- DTCG doesn't formally model animations yet; use `$extensions` or DESIGN.md prose

**Component patterns (★★★★ — high audit value, hard to fully tokenize):**
- `struct PrimaryButtonStyle: ButtonStyle { func makeBody(configuration:) ... }` — record the protocol conformance + emitted modifier chain as a **component token**
- `struct CardStyle: ViewModifier { func body(content:) ... }` — same
- `extension View { func cardStyle() -> some View { modifier(CardStyle()) } }` — convenience wrapper
- Custom `View` structs that wrap native components (`MyButton`, `Card`, `Pill`, etc.) — extract as components even if they don't conform to a `Style` protocol
- DTCG component representation (using composite + `$extensions`):

```json
"components": {
  "button-primary": {
    "background": "{color.brand}",
    "foreground": "{color.on-brand}",
    "padding": { "horizontal": "{space.md}", "vertical": "{space.sm}" },
    "radius": "{radius.md}",
    "typography": "{typography.label-md}"
  }
}
```

**iOS 26 / Liquid Glass (★★★ — Grapla-relevant if targeting iOS 26):**
- `.glassEffect()`, `.glassEffect(.regular)`, `.glassEffect(.clear)`, `.glassEffect(.identity)`
- `.glassEffect(.regular.tint(.blue).interactive())`
- `GlassEffectContainer { ... }`, `glassEffectID("name", in: namespace)`
- `.buttonStyle(.glass)`, `.buttonStyle(.glassProminent)`
- Apple guidance: glass is for navigation layer only, not content. Your audit should flag glass used on cards/lists/media as design violation.
- Token shape (custom — DTCG has no material primitive): use `$extensions.com.grapla.material` with `{ variant, tint, interactive, container }`.

**SF Symbols and system semantics:** Treat `Image(systemName:)` and `Color.accentColor`/`.primary`/`.secondary` as references to the system token set; preserve as aliases rather than concretizing. Document in DESIGN.md prose that these resolve dynamically.

**Theme injection patterns (worth extracting separately):**
- Custom `EnvironmentKey` + `EnvironmentValues` extensions defining a `theme` property
- `@Entry` macro (iOS 18+/Xcode 16+) for environment values: `@Entry var theme: Theme = .default`
- ObservableObject/`@Observable` theme providers
- Microsoft's FluentUI iOS pattern (GlobalTokens → AliasTokens → ControlTokens) is worth recognizing as a reference architecture and emitting in the same shape

### 4. AST Parsing & Code Analysis for Swift

**SwiftSyntax (recommended primary).** Apple-official, in `swiftlang/swift-syntax`. Major versions track Swift releases (509 = Swift 5.9, etc.). Provides:
- `SourceFileSyntax` root, walked via `SyntaxVisitor` subclass
- Typed nodes: `ExtensionDeclSyntax`, `VariableDeclSyntax`, `FunctionCallExprSyntax`, `MemberAccessExprSyntax`, `StringLiteralExprSyntax`, `IntegerLiteralExprSyntax`, `FloatLiteralExprSyntax`
- Parses without invoking the compiler (purely lexical/syntactic, no type info)
- Drives `swift-format`, SwiftLint (newer rules), Swift Macros, Sourcery
- `swift-ast-explorer.com` (by kishikawakatsumi) is invaluable for prototyping queries
- Companion: `SwiftSemantics` (`SwiftDocOrg/SwiftSemantics`) abstracts SyntaxVisitor walking into a `DeclarationCollector` with typed `Declaration` values — much easier ergonomics

For Grapla extraction, write `SyntaxVisitor` overrides for `visit(_ node: ExtensionDeclSyntax)` filtering for `extendedType` of `Color`, `Font`, `View`, etc., then walk children for static `let` declarations and recursively unpack the initializer's `FunctionCallExprSyntax` to extract argument labels and literal values.

**SourceKit-LSP.** Provides type information SwiftSyntax lacks. Useful for: resolving "is this `Color` actually `SwiftUI.Color` or a custom `Color` type?", finding all usages of a token across the codebase, understanding cross-module references. Heavier — requires building an index. Probably overkill for v1; revisit if you need usage counts for "orphaned token" detection.

**Tree-sitter-swift.** `alex-pinkus/tree-sitter-swift` is the actively maintained grammar (the official `tree-sitter/tree-sitter-swift` repo redirects users there). Available as Rust crate (`tree-sitter-swift = "=0.7.1"`), NPM package, and Python wheels. Less semantically accurate than SwiftSyntax — it's a CFG grammar with GLR parsing, error-recovers well but doesn't know Swift semantics. Pros: incremental parsing, runs anywhere Node/Python runs, no Swift toolchain needed. **For a Claude Code skill that ships as a single Node bundle, this is the pragmatic choice.** For a skill that runs `swift run` locally, SwiftSyntax wins.

**Sourcery.** Built on SwiftSyntax. Code *generation*, not analysis-first, but its `types.all`/`types.classes`/`types.enums`/`types.protocols` template variables expose a clean "what's in this code" model. You could use Sourcery as the parser and emit a JSON intermediate from a Stencil template, then post-process. Heavier than direct SwiftSyntax for this use case.

**SwiftLint's AST.** SwiftLint uses SwiftSyntax (newer rules) and SourceKitten (older rules) under the hood. Not exposed as a library for arbitrary AST queries; you'd be reverse-engineering. Skip.

**Regex.** Adequate as a *fallback* for hex literal extraction (`#[0-9A-Fa-f]{6,8}`) and for cases where you can't be bothered to walk an AST. Inadequate for: multi-line declarations, modifier chains, computed properties, anything where Swift's grammar lets you write the same thing many ways. **Use regex for the audit pass that finds raw hex/magic-number occurrences in non-design files; use AST for the canonical extraction.**

**Hybrid approach (recommended).**
1. **AST pass (SwiftSyntax):** structurally extract token candidates from `extension Color`, `extension Font`, `enum Spacing`, `ButtonStyle` conformances, `ViewModifier` conformances. Deterministic, fast, accurate.
2. **Regex side-channel:** scan all `.swift` files for hex literals, numeric literals in `.padding`/`.cornerRadius`/`.font(.system(size:))`, raw `Color(red:...)` calls. Build a "drift inventory."
3. **LLM normalization pass:** feed both inventories to Claude with the DTCG schema and a prompt to (a) cluster numeric literals into scales, (b) propose semantic names for un-named values, (c) detect duplicates with slightly different values (e.g., `#1A1C1E` and `#1A1C1F`), (d) write the DESIGN.md prose explaining *why*.

Real-world reference for hybrid: Erica Scolaro's typography audit methodology (2026) is exactly this flow performed manually. Your skill automates it.

### 5. AI-Assisted Extraction Patterns

**Claude Code Skills architecture.** Skills are prompt-based meta-tools that inject instructions and modify execution context (tool permissions, model selection). They're invoked via `/skill-name` or auto-triggered by description match. Lee Hanchung's deep dive (Oct 2025) shows the architecture: a skill = a `SKILL.md` (description for routing + body for instructions) + optional bundled scripts/resources. Reference repos: `VoltAgent/awesome-agent-skills` (1000+ skills), `Piebald-AI/claude-code-system-prompts` (Anthropic's official patterns including "Agent Design Patterns," "simplify").

**Token economics for skill design.** Recent papers (CodeAgents Jul 2025, CODESTRUCT Nov 2025, SkillReducer Mar 2026, TokDrift Oct 2025) converge on: (a) structured/codified prompts beat NL prompts, (b) AST-aware action spaces (CODESTRUCT) reduce token consumption 12–38% vs text-span editing, (c) skill descriptions should be 20–40 tokens with TF-IDF-distinguishable keywords, and (d) progressive disclosure — load only the resources needed for a given subtask.

**Prompt patterns for code → structured output.**
- **Schema-first prompting:** include the DTCG JSON Schema in the prompt; require output to validate against it. Claude is strong at schema adherence with sonnet-class models.
- **Two-pass extraction:** Pass 1 — "extract all candidate tokens, output raw findings JSON with file paths and line numbers." Pass 2 — "given these findings, produce DTCG-valid output, name semantic groups, dedupe."
- **Progressive disclosure:** include only one file's findings per LLM call, accumulate. Avoid the 30k-line monolithic prompt.
- **Self-critique pass:** after generating DTCG, re-run with a prompt asking "what's missing? what's misnamed? what conflicts?" — this catches naming inconsistencies (Romina Kavcic Dec 2025: AI-readable tokens need *intent* descriptions, not just values, for AI to use them well).

**Agentic patterns for codebase analysis.** Recent practitioner experience (Cursor, Claude Code skills, awesome-agent-skills): the right pattern is *subagents for parallel exploration*. Spawn a subagent per directory to extract; have the parent reconcile. Avoids polluting parent context with raw findings. For a typical Grapla-sized codebase (~50–500 files), this is overkill — single-pass is fine.

**"Design system audit via AI" — emerging concept.** Lazarev.agency (2026), Aufait UX, and others describe AI-assisted audits as their differentiator. Romina Kavcic (Dec 2025) describes connecting design tokens to Claude via Figma MCP and reports the AI generates code with `blue-5` instead of `color-feedback-error` because tokens lack intent metadata. **Implication for Grapla**: your DESIGN.md is the intent layer that DTCG alone can't carry, and that's why dual output matters.

### 6. Round-tripping to Figma

**Figma Variables API.** REST API supports query/create/update/delete via personal access tokens (Enterprise plan only for variables PAT scope; lower tiers must use plugins). Variables map naturally to DTCG: Collections ≈ token sets, Modes ≈ themes, Variables ≈ tokens. Aliases via `VARIABLE_ALIAS` type. Resolved types: `COLOR`, `FLOAT`, `BOOLEAN`, `STRING`. Figma has been adding native DTCG export/import (announced Schema 2025, rolling out late 2025/early 2026; currently incomplete — community noted `description` field omitted from export).

**Plugins for token import (best paths for non-Enterprise users):**
- **TokensBrücke** (`tokens-bruecke/figma-plugin`): converts Figma Variables to DTCG JSON; also imports DTCG/standard format JSON, creates Variable Collections + Modes. Handles aliases, scopes, opacity %, color styles → tokens conversion.
- **tokenhaus**: round-trip variable export/import preserving alias links.
- **DTCG Design Token Manager**: bidirectional DTCG bridge.
- **Tokens Studio**: most mature, handles math expressions, multi-mode themes, GitHub sync.
- **Styleframe**: TypeScript-config-driven, free/open-source, both directions.

**Figma REST API for component/style creation.** Components cannot be programmatically created via REST API — they must be created in the Figma editor (or via plugin API). Variables and styles can be programmatically managed. **Implication**: your code→Figma path can ship tokens cleanly but cannot ship components. Ship components as Markdown specs in DESIGN.md and let the user manually create them in Figma (or via a future Figma plugin you build).

**SwiftUI views vs Figma components — the impedance mismatch.**
- SwiftUI components are *function-of-data* (configuration → view); Figma components are *visual state machines* (variants × properties).
- Auto-layout in Figma maps to HStack/VStack in SwiftUI but with subtle differences (Figma's "fill container" vs SwiftUI's `.frame(maxWidth: .infinity)`).
- Don't try to round-trip components in v1. Output a "components-to-build" spec (per-component description, props, states, asset references).

**Best tools for code → Figma.** Honestly: nothing great exists. The mature direction is Figma → code. For your code → Figma direction:
1. Emit DTCG JSON with full mode support.
2. User installs TokensBrücke or Tokens Studio.
3. Plugin imports your JSON → creates Collections, Modes, Variables.
4. Designer manually creates components referencing those Variables.

Or, if user has Enterprise Figma:
1. Emit DTCG JSON.
2. POST directly to `/v1/files/:file_key/variables` via REST API. Reference: tonyward.dev (Feb 2025) and Nate Baldwin's Intuit writeup show working scripts (~200 lines of Node).

### 7. The "Vibe Coded App Recovery" Workflow

This is the unique angle. The framing in design-system practitioner literature is **"design system audit"** — typography audit, color audit, component inventory, drift detection. The methodology is consistent across DOOR3, Aufait UX, Netguru, Lazarev, House-of-Maestro, Customer.io, and Erica Scolaro:

1. **Inventory** — collect every UI element/token currently in use (manually, in screenshots or via scripts).
2. **Categorize** — group by type (button, input, card; color, type, space).
3. **Identify duplication/drift** — find values that are *almost* the same.
4. **Propose harmonization** — recommend a consolidated token set.
5. **Document** — produce developer-facing spec.
6. **Migrate** — apply tokens, removing magic numbers.

**Token harmonization** specifically (the word people use): finding values like `#1A1C1E`, `#1A1D1E`, `#1B1C1E` and concluding they should all be `color.surface.dark`. AI is *exceptionally good* at this clustering — it's a small problem (typically 50–500 values), pattern-matchable, and benefits from semantic understanding ("these all look like ink colors"). This is where the LLM adds the most value over pure programmatic clustering (which would need a hard-coded distance threshold).

**Magic number detection.** Programmatically: regex scan for numeric literals in spacing/sizing/radius positions. Cluster. Output histogram. Compare to canonical scale (4/8 px). Flag outliers. This is purely programmatic; no AI needed for the detection, but AI is useful for the proposal ("these 3 values around 14–17 should all become `space.md = 16`").

**Visual regression / screenshot diffing.** Complementary: after harmonization, run pixel-diff between before/after screenshots to confirm the consolidation didn't break anything visually. Tools: SnapshotTesting (`pointfreeco/swift-snapshot-testing`), Xcode UI tests + ImageMagick. Out of scope for v1 but worth a sentence in the audit report ("after applying these tokens, run snapshot tests to verify").

**Existing tools for retroactive design-system extraction from apps:** Effectively none for native iOS. `design-extract` (Manavarya09) does this for *web URLs* — same mental model, different medium. Confirms again: this is the gap.

### 8. Recommendations for the Build

Below is the build plan, opinionated, calibrated for a solo iOS dev who already knows Style Dictionary and lives in Claude Code.

#### Architecture

```
grapla-design-extract/                    (Claude Code skill)
├── SKILL.md                              (description, when to invoke)
├── extract.ts                            (Node.js entry)
├── parsers/
│   ├── tree-sitter-swift.ts             (primary AST walker)
│   ├── color-extractor.ts               (extension Color { ... })
│   ├── typography-extractor.ts          (Font.custom, JetBrains Mono pattern)
│   ├── spacing-extractor.ts             (numeric literals in positional/labeled args)
│   ├── shape-extractor.ts               (cornerRadius, RoundedRectangle)
│   ├── component-extractor.ts           (ButtonStyle, ViewModifier conformances)
│   └── asset-catalog-extractor.ts       (.xcassets/.colorset Contents.json)
├── analyzers/
│   ├── cluster-numeric.ts               (4/8 scale clustering)
│   ├── cluster-color.ts                 (deltaE-based color clustering)
│   └── drift-detector.ts                (compare extension defs to call-site usage)
├── emitters/
│   ├── dtcg.ts                          (W3C 2025.10 output)
│   ├── design-md.ts                     (Google DESIGN.md output)
│   ├── style-dictionary.ts              (legacy SD JSON, optional)
│   └── audit-report.ts                  (Markdown audit findings)
├── llm/
│   ├── normalize-prompt.ts              (semantic naming)
│   ├── harmonize-prompt.ts              (cluster + propose)
│   └── narrate-prompt.ts                (DESIGN.md prose generation)
└── schemas/
    └── dtcg-2025.10.json                (validation schema)
```

**Tech choices:**
- **Language: TypeScript/Node** (not Swift). Reason: Claude Code skills run as Node scripts; skipping the Swift toolchain dependency is huge for distribution. Tradeoff: tree-sitter-swift is less accurate than SwiftSyntax. Mitigation: focus on common, stable patterns and accept ~5% miss rate on weird cases.
- **Parser: tree-sitter-swift (alex-pinkus/tree-sitter-swift)** for v1. Add a `--swiftsyntax` mode in v2 that shells out to a small Swift Package binary if the user has Xcode (more accurate, slower).
- **LLM calls: Claude via the skill's Claude Code session** — no additional API key needed; you reuse the user's existing context.
- **Output format primary: DTCG 2025.10 JSON**. Secondary: DESIGN.md. Tertiary: a markdown audit report.

#### MVP (1–2 weekends)

**Scope:** Color + Typography + Spacing only. No components. No round-trip to Figma. No iOS 26 materials.

**Deliverables:**
1. CLI command: `claude-code skill grapla-design-extract --path ./Grapla --output ./design-system`
2. Outputs:
   - `design-system/tokens.json` — DTCG 2025.10
   - `design-system/DESIGN.md` — Google DESIGN.md
   - `design-system/audit.md` — findings (drift, magic numbers, duplicates)
3. Pipeline:
   - Walk all `.swift` files via tree-sitter-swift
   - Walk all `.xcassets/*.colorset` for color asset definitions
   - Extract `extension Color { static let X = ... }` declarations → primitive color tokens
   - Extract `Font.custom("Name", size: N, relativeTo: Style)` calls → typography tokens, group by font family
   - Extract numeric literals in `.padding`, `.cornerRadius`, `EdgeInsets`, `VStack(spacing:)` → spacing/radius candidate values
   - Single LLM normalization pass: take raw findings JSON + DTCG schema + naming-convention guidance → produce final tokens.json
   - Single LLM narration pass: take final tokens.json + raw findings → produce DESIGN.md prose with brand-rationale-shaped narrative
   - Audit pass: compare every numeric literal to nearest token; if delta > 0px and < 4px, flag as "drift candidate"; if delta == 0px to a defined token, suggest tokenization

#### V2 (next 2 weekends)

**Adds:**
- Component extraction (`ButtonStyle`, `ViewModifier`, custom `View` structs) → component tokens with `$extensions`
- Shadow + animation tokens
- iOS 26 material tokens (`.glassEffect()` patterns)
- `--watch` mode for live re-extraction during development
- Round-trip to Figma via Style Dictionary → TokensBrücke import workflow (document the manual import step rather than automating it)
- ColorTokensKit detection (if user uses metasidd's library, emit OKLCH-aware tokens)

#### V3 / Full vision

- SwiftSyntax-based parser as opt-in for higher accuracy
- Direct Figma Variables REST API push (Enterprise users)
- Visual regression integration (`SnapshotTesting` adapter)
- Bidirectional sync — pull token updates from Figma back into Swift, generate PR
- MCP server interface so other agents (Cursor, Windsurf) can invoke the extractor
- Multi-app comparison mode (extract from Afterset and Grapla, compare token sets, propose shared design system)

#### Hardest problems & where AI adds most value

| Problem | Difficulty | AI helps? |
|---|---|---|
| Parse `extension Color` declarations | Easy | No (deterministic AST) |
| Read Asset Catalog JSON | Easy | No (JSON parse) |
| Cluster spacing literals into 4/8 scale | Easy | Marginal (heuristic works) |
| Cluster colors that "look the same" | Medium | **Yes** (deltaE + semantic understanding) |
| Name unnamed values semantically | Hard | **Yes — biggest AI win** |
| Detect "this is a button-style token" vs "this is a primitive" | Hard | **Yes** (context understanding) |
| Generate brand-rationale prose for DESIGN.md | Hard | **Yes — only AI can do this** |
| Map SwiftUI components to Figma components | Very hard | Limited (impedance mismatch) |
| Round-trip component visual fidelity | Very hard | No (out of scope) |

**The single highest-leverage AI use:** generating the DESIGN.md prose. DTCG can be produced deterministically; DESIGN.md narrative cannot. This is the moat.

#### Concrete next-action sequence

1. **Day 1:** Stand up the Node skill skeleton. Add tree-sitter-swift. Get a 50-line Grapla-style sample file parsing into an AST you can query.
2. **Day 2:** Implement color extension extractor + Asset Catalog reader. Output raw findings JSON.
3. **Day 3:** Add typography (JetBrains Mono pattern) and spacing extractors.
4. **Day 4:** Wire up DTCG emitter. Validate against `designtokens.org/tr/drafts/format/` schema.
5. **Day 5:** Add LLM normalization pass (one prompt, one call per token category). Add DESIGN.md narration.
6. **Day 6:** Add audit report. Test on Grapla. Iterate prompts.
7. **Day 7+:** Components, then Figma round-trip via TokensBrücke import.

---

## Recommendations

**Stage 0 — Decide format commitments now (today).**
- Adopt **DTCG 2025.10** as your primary output. Don't hedge.
- Adopt **Google DESIGN.md (alpha)** as your secondary output. Accept the alpha risk.
- Reject Tokens Studio legacy format, Theo, Diez as outputs.
- **Threshold to revisit:** if DTCG 2025.10 sees a breaking change (unlikely now that it's stable), or if DESIGN.md gets abandoned by Google before reaching v1.0, re-evaluate.

**Stage 1 — Build the MVP (next 2 weekends, ~16h).**
- Scope: Color + Typography + Spacing extraction only, into DTCG + DESIGN.md.
- Tech: Node + tree-sitter-swift + Claude SDK (via skill context, no separate API key).
- Test exclusively on Grapla. Don't generalize prematurely.
- **Success threshold:** the generated `tokens.json` passes `npx style-dictionary build` and produces a `Color` extension that `diff`s to <10% from Grapla's existing one. The generated DESIGN.md, fed back as a CLAUDE.md companion, lets Claude generate a new Grapla view in correct brand without further prompting.

**Stage 2 — Add components and audit (next 2 weekends).**
- Add `ButtonStyle`/`ViewModifier`/custom `View` extraction.
- Add the audit report: drift candidates, orphaned tokens, magic-number occurrences, contrast warnings (port the DESIGN.md `contrast-ratio` lint check).
- Add the harmonization LLM pass that proposes "your three near-identical grays should be one token."
- **Success threshold:** running on Grapla produces an audit with 5–20 actionable harmonization recommendations the user agrees with.

**Stage 3 — Round-trip to Figma (1 weekend).**
- Document a manual workflow: run skill → import generated `tokens.json` into TokensBrücke (Figma plugin) → Variable Collections appear in Figma. Treat as the "happy path" for non-Enterprise users.
- For Enterprise users, add a `--push-to-figma <file_key>` flag using the Variables REST API directly.
- **Success threshold:** end-to-end demo: open Grapla repo → run skill → open Figma → see Grapla's color palette as Variables.

**Stage 4 — Productize as a Claude Code skill plugin (optional, 1 weekend).**
- Package as `grapla-design-extract` in the skill marketplace pattern (`.agents/skills/`).
- Generalize: make it `swiftui-design-extract` and accept any SwiftUI repo.
- Add an MCP server wrapper so Cursor/Windsurf can use it too.
- **Threshold to attempt:** only after Grapla and Afterset are both extracting cleanly. Don't generalize on n=1.

**Things to NOT build:**
- Don't build a custom DTCG parser; use existing schema validators.
- Don't build a Figma component creator (REST API doesn't expose component creation).
- Don't build a SwiftSyntax-based parser in v1 (toolchain dependency cost > marginal accuracy gain). Ship tree-sitter, add SwiftSyntax in v2 as `--accurate` flag.
- Don't build visual regression in v1 (orthogonal concern, mature tools exist).
- Don't try to extract animation timings into proper tokens (DTCG motion module is still drafty; punt to `$extensions` + DESIGN.md prose).

**Decision triggers that change the plan:**
- If Anthropic ships a first-party design-system skill: switch to extending it rather than competing.
- If Figma ships native DTCG round-trip in production (vs current rolling beta): drop the TokensBrücke step; use Figma's importer directly.
- If Apple ships an official "design tokens" framework at WWDC 2026 (rumored, not confirmed): pivot to align output with Apple's format.

---

## Caveats

- **DESIGN.md is alpha.** The format spec, token schema, and CLI are explicitly under active development. Spec changes are likely. Architect your emitter so swapping the DESIGN.md schema is a one-file change.
- **DTCG 2025.10 is stable but tooling lags.** Style Dictionary v4 supports the DTCG draft format; full 2025.10 support (new color module, dimension object, motion, resolvers) is in v5 (in progress as of November 2025). Expect to pin a specific SD version and update later.
- **Figma's native DTCG export omits `description` fields** (community-reported, late 2025). Don't rely on the description field surviving a Figma round-trip until Figma ships a fix.
- **tree-sitter-swift accuracy.** The parser is community-maintained, not Apple. Rare Swift syntax (some result builder patterns, some macro expansions, some new iOS 26 features) may parse imperfectly. Always include a "raw source location" pointer in extracted tokens so users can verify against the source.
- **Penpot's DTCG export** as of late 2025 was reported by community users to occasionally export Tokens Studio-shaped JSON instead of strict 2025.10. Validate exports against the spec; don't assume conformance.
- **Figma REST API for variables** is **Enterprise plan only** for personal access tokens with the variables scope. The plugin API is available to all plans. Solo developers without Enterprise must use plugins (TokensBrücke, Tokens Studio) for the Figma round-trip — automate the JSON generation and document the import as a manual step.
- **Liquid Glass is iOS-26-only and Apple-proprietary.** Glass tokens you extract are non-portable to web/Android. Mark them clearly in DTCG `$extensions.com.grapla.material` and don't try to "translate" them.
- **The "vibe-coded recovery" framing is novel and the audit's recommendations carry implicit value judgments** (e.g., "you should consolidate these grays"). Always present the LLM's recommendations as suggestions with confidence levels and source line references — never auto-apply changes to the user's source code.
- **Token economics in Claude Code:** for a Grapla-sized codebase (~hundreds of files), the LLM normalization pass should comfortably fit in a single Claude context. For larger apps (10k+ files), implement the subagent pattern (one extraction subagent per top-level directory, parent reconciles).
- **No published academic papers specifically address Swift→design-tokens extraction** as of November 2025; the closest analogues are AST-aware code-agent papers (CODESTRUCT, CodeAgents) and design-system audit practitioner literature. You're working in unstudied territory — expect to publish your own writeup as the primary citation.
- **One conflicting piece of information:** sources differ on whether Style Dictionary fully supports DTCG 2025.10 today. The official `style-dictionary/style-dictionary` GitHub issue #1590 (Nov 4, 2025) lists 2025.10 support as partially complete with several DTCG modules still in progress for v5. Plan to test specifically against your token shapes rather than assuming full support.