# Tokextract — Product Requirements Document

**Version:** v1 draft
**Last updated:** 2026-05-08
**Companion docs:** `EXTOKEN.md` (research/architecture spec), `CLAUDE.md` (load-bearing decisions)

---

## 1. Overview

Tokextract is a repo-agnostic Claude Code skill that scans any SwiftUI codebase and reverse-engineers its implicit design system into three artifacts: a W3C DTCG 2025.10-valid `tokens.json` (the canonical machine-truth source), a Google `DESIGN.md` (an LLM-readable narrative companion sized to live alongside `CLAUDE.md`), and an `audit.md` flagging drift, magic numbers, and near-duplicate values. Every existing token toolchain — Specify, Supernova, Tokens Studio, Penpot — runs Figma-to-code; Tokextract runs the opposite direction, making it the first tool that treats Swift source as the source of truth.

## 2. Problem Statement

"Vibe-coded" SwiftUI apps accumulate design debt silently: magic-number padding literals scattered across hundreds of views, near-duplicate hex values that diverge by a single channel byte, ad-hoc `extension Color` declarations that multiply without a naming scheme, and font calls with hardcoded sizes rather than Dynamic Type pairings. No tooling exists to recover a design system from this state. Every major token platform (Specify, Supernova, Tokens Studio, Knapsack, Penpot, zeroheight, the now-archived Diez) extracts tokens *from Figma or Sketch* and emits code — none ingests Swift source. The current solution is a manual design audit by a senior designer: a 1–2 week exercise of opening every screen, cataloguing every value, and reconciling duplicates by hand before a single token can be defined. Tokextract automates that audit, making the recovery path from vibe-coded app to coherent, token-driven codebase a single command.

## 3. Goals

- Emit a `tokens.json` that passes DTCG 2025.10 schema validation and covers color, typography, spacing, corner radius, shadow, animation, components, and iOS 26 Liquid Glass materials.
- Run on any SwiftUI repo via `--path <dir>` with no repo-specific configuration; support ≥2 distinct apps as test fixtures before any extraction pattern is treated as canonical.
- Surface drift automatically: near-duplicate hex values (deltaE threshold), off-scale numeric literals, magic numbers with no corresponding token definition.
- Generate a `DESIGN.md` that is sufficient as a `CLAUDE.md` companion — feeding it back to an LLM should enable brand-correct UI generation without further prompting.
- Produce an `audit.md` with actionable harmonization suggestions (confidence levels, source file + line references); never auto-apply changes to user source.
- Ship as a single-bundle Node/TypeScript Claude Code skill; no Swift toolchain required on the host machine.

## 4. Non-Goals

- **Not a Figma-to-code generator.** Direction is code → tokens only; the Figma round-trip is a manual import step (TokensBrücke / Tokens Studio plugin), not an automated output.
- **Not a SwiftSyntax-based parser in v1.** The primary parser is `alex-pinkus/tree-sitter-swift` (Node-native); SwiftSyntax is a v2 `--accurate` opt-in only.
- **Not a visual regression tool.** Snapshot diffing (e.g. `pointfreeco/swift-snapshot-testing`) is out of scope; the audit report mentions it as a recommended post-harmonization step only.
- **Not a UIKit-only codebase tool in v1.** Extraction patterns target SwiftUI constructs; UIKit-specific token patterns are not supported in the initial release.
- **Not a component round-trip tool.** Figma REST API does not support programmatic component creation; component tokens are emitted as Markdown specs for manual designer build.
- **Not a Tokens Studio legacy format emitter.** Output formats are DTCG 2025.10 and Google DESIGN.md only; Tokens Studio legacy, Theo, and Diez formats are explicitly rejected.

---

## 5. User Stories & Workflows

### 5.1 Personas

**Conor — Solo indie iOS developer.** Has one or more "vibe-coded" SwiftUI apps where UI decisions accreted over weeks of rapid iteration. Colors are defined inline or scattered across extension files, spacing is mostly magic numbers, typography works but was never systematized. Wants a design system to exist retroactively — not to slow down future work, but so future Claude Code sessions can generate brand-correct UI without Conor re-specifying fonts, colors, and spacing every time. Comfortable in the terminal, already runs Claude Code as a daily driver.

**Mara — Design system practitioner / consultant.** Brought in to audit a client's iOS app before a design refresh. Needs to inventory the existing visual language quickly, produce a concrete audit deliverable (what's inconsistent, what's off-brand, what's a near-duplicate), and hand off a token spec the client's engineering team can actually use. Currently does this manually in two to four days; Tokextract compresses that to an hour. The DTCG output goes directly into Style Dictionary; the audit.md becomes the first section of her consulting report.

### 5.2 Primary User Stories

**Extraction**
- As Conor, I want to run a single command against any SwiftUI repo, so that I get a full token extraction without setting up tooling or writing parser code myself.
- As Mara, I want Tokextract to accept an arbitrary `--path` to any Swift repo I don't own, so that I can run it on a client codebase on day one of an engagement without modifying their project.

**DTCG output**
- As Conor, I want a DTCG 2025.10-valid `tokens.json` I can pipe directly into Style Dictionary, so that I can generate canonical Swift extensions and verify they match what's already in the app.
- As Mara, I want the `tokens.json` to include source file paths and line numbers for every extracted value, so that I can cite specific code locations in my audit deliverable.

**DESIGN.md companion**
- As Conor, I want a `DESIGN.md` that sits next to `CLAUDE.md` in my repo, so that future Claude Code sessions can generate new SwiftUI views that are brand-correct without me restating fonts, colors, or spacing.
- As Mara, I want the DESIGN.md prose to explain the *intent* behind extracted tokens (not just their values), so that the client's team understands the design rationale, not just the hex codes.

**Audit**
- As Conor, I want an `audit.md` that flags magic numbers, near-duplicate colors, and off-scale spacing values with actionable line-level callouts, so that I can prioritize which technical-design debt to pay down first.
- As Mara, I want the audit to group near-identical values (e.g. three similar dark grays) and propose a single harmonized token for each cluster, so that harmonization recommendations are ready-to-present without further analysis.

**Drift over time**
- As Conor, I want to re-run Tokextract after a refactor and see a diff against the previous extraction, so that I can confirm my design system is converging rather than accumulating new inconsistencies.

**Cross-repo comparison (v3)**
- As Conor, I want to compare token extractions from two different SwiftUI apps I own (e.g. Grapla and a second app), so that I can identify which tokens are shared and could live in a common design foundation. _(Tracked in §12 as v3 scope; included here for completeness.)_

### 5.3 End-to-End Workflows

#### Workflow 1 — First-time extraction on a fresh SwiftUI repo

**Command:**
```
/tokextract --path ./MyApp --output ./design-system
```

**What Tokextract does internally:**
1. Walks all `.swift` files with the tree-sitter-swift AST walker, running each category extractor in parallel (Color, Typography, Spacing, Shape, Shadow, Animation, Components, Liquid Glass).
2. Reads `.xcassets/*.colorset/Contents.json` for light/dark color pairs; reads `Info.plist` for registered font files.
3. Runs a regex side-channel pass to build a drift inventory of every numeric literal and hex value used at call sites across the codebase.
4. Sends the raw findings JSON to the LLM normalization pass: clusters near-duplicates, proposes semantic names for unnamed values, outputs a validated DTCG 2025.10 `tokens.json`.
5. Runs the LLM narration pass: generates DESIGN.md prose explaining brand intent, token hierarchy, and the rationale for each category.
6. Generates `audit.md`: drift candidates (call-site values that don't match any defined token), off-scale spacing (values not on a 4/8 grid), near-duplicate colors (deltaE < threshold), and contrast warnings.

**Artifacts produced:**
- `design-system/tokens.json` — DTCG 2025.10
- `design-system/DESIGN.md` — agent-readable brand narrative
- `design-system/audit.md` — prioritized list of inconsistencies with file:line references

**What the user does next:** Copies `DESIGN.md` to the repo root alongside `CLAUDE.md`. Opens `audit.md` and works through the top five drift items. Optionally runs `npx style-dictionary build` against `tokens.json` to verify the round-trip produces correct Swift extensions.

#### Workflow 2 — Iterative audit during a color harmonization refactor

**Scenario:** Conor has identified that his app has accumulated five slightly different dark-background colors and wants to collapse them to two.

**First run:**
```
/tokextract --path ./Grapla --output ./design-system
```

Conor reads `audit.md`. The audit flags four near-duplicate colors in the `#1A1C1E`–`#1B1D1F` range and proposes a single `color.surface.elevated` token. He edits his `Color` extension and inline usages in two view files, replacing all four variants with the proposed token.

**Second run, same output directory:**
```
/tokextract --path ./Grapla --output ./design-system
```

Tokextract detects a previous `tokens.json` in the output directory and emits a diff section at the top of the new `audit.md`: tokens added, tokens removed, values changed. Conor confirms the four near-duplicates have collapsed to one and no new drift was introduced.

**What the user does next:** Commits the updated design-system directory alongside the source changes, creating a verifiable record that the token set and the code are in sync at this point in the repo history.

#### Workflow 3 — Figma round-trip via TokensBrücke (optional path)

**Scenario:** Mara wants to hand the client a Figma file with Variables already populated from the extracted token set.

**Command:**
```
/tokextract --path ./ClientApp --output ./deliverable
```

Tokextract produces `deliverable/tokens.json` with full mode support (light/dark color pairs emitted as separate `$value` entries per theme).

**What Mara does next:**
1. Opens the client's Figma file and installs the **TokensBrücke** plugin (or Tokens Studio if already in use).
2. In the plugin, selects "Import DTCG JSON" and points it at `tokens.json`.
3. The plugin creates Variable Collections — one Collection per top-level token group (`color`, `typography`, `spacing`, `radius`) — with Modes for `light` and `dark` where applicable.
4. Mara renames Collections to match the client's Figma conventions and hands off the file.

**Figma Enterprise alternative (v2+):** with `--push-to-figma <file_key>`, Tokextract POSTs directly to the Figma Variables REST API, creating Collections and Variables without the plugin import step.

---

## 6. Functional Requirements — Extraction

### 6.1 Color

**Source patterns to detect:**

```swift
// 1. Static extension declarations — semantic tokens
extension Color {
    static let brandPrimary = Color(.sRGB, red: 0.067, green: 0.537, blue: 1.0, opacity: 1)
    static let surfaceDark = Color(red: 0.102, green: 0.110, blue: 0.118)
    static let accent = Color(hex: "#1A88FF")
    static let background = Color("AppBackground")        // Asset Catalog reference
    static let tintMuted = Color(uiColor: UIColor.systemIndigo)
}

// 2. Dark/light init extension
extension Color {
    init(light: Color, dark: Color) {
        self = Color(UIColor { $0.userInterfaceStyle == .dark ? UIColor(dark) : UIColor(light) })
    }
    static let surface = Color(light: .white, dark: Color(hex: "#1A1C1E"))
}

// 3. @Environment conditional pick
@Environment(\.colorScheme) var colorScheme
let cardBg = colorScheme == .dark ? Color.surfaceDark : Color.surfaceLight
```

**AST node types (tree-sitter-swift queries):**

```scheme
; Extension Color static lets
(extension_declaration
  (type_identifier) @ext.name (#eq? @ext.name "Color")
  (class_body
    (property_declaration
      (modifiers (modifier) @mod (#eq? @mod "static"))
      (pattern (simple_identifier) @decl.name)
      (call_expression
        (simple_identifier) @init.name
        (call_suffix (value_arguments ...) @args)))))

; Asset Catalog string references
(call_expression
  (simple_identifier) @fn (#eq? @fn "Color")
  (call_suffix
    (value_arguments
      (value_argument
        (line_string_literal) @asset.name))))
```

**`.xcassets/*.colorset/Contents.json` parsing** (separate JSON walk, not AST): extract the `components` block for `light`, `dark`, and `high-contrast` appearance entries; map `r/g/b/a` strings to normalized `[0,1]` floats.

**Edge cases / fallbacks:**
- Hex literal regex side-channel: `/#([0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})\b/g` across all `.swift` files.
- `Color.accentColor`, `.primary`, `.secondary`, `.red`, `.blue`: preserve as system aliases, never concretize. Record `isSystemAlias: true`.
- `Color(uiColor:)`: record verbatim `rawValue`; mark `requiresSemanticResolution: true`.
- **Asset Catalog missing-file:** when `Color("Foo")` references a name with no matching `.colorset/Contents.json` under the walked path, emit a finding with `assetMissing: true`, `severity: "error"`, `normalizedValue: null`. The token is retained in findings (so the LLM can flag and the audit can report) but not promoted to `tokens.json`.

**Output shape per finding:**
```ts
{
  category: "color",
  sourcePath: "Sources/UI/Tokens/Color+Brand.swift",
  line: 14, col: 4,
  declName: "brandPrimary",
  rawValue: "Color(.sRGB, red: 0.067, green: 0.537, blue: 1.0, opacity: 1)",
  normalizedValue: { r: 0.067, g: 0.537, b: 1.0, a: 1.0, colorSpace: "srgb" },
  context: "extension Color static let",
  isSystemAlias: false, assetName: null, hasDarkVariant: false
}
```

### 6.2 Typography

**Source patterns:**

```swift
Font.custom("JetBrainsMono-Regular", size: 16, relativeTo: .body)

extension Font {
    static let bodyMd  = Font.custom("JetBrainsMono-Regular", size: 16, relativeTo: .body)
    static let labelSm = Font.custom("JetBrainsMono-Regular", size: 11, relativeTo: .caption)
}

extension Text {
    func textStyleUi11Regular() -> some View {
        self.font(Font.custom("PoppinsRegular", size: 11))
    }
}

enum JetBrainsMono: String {
    case regular = "JetBrainsMono-Regular"
    case bold    = "JetBrainsMono-Bold"
    var font: Font { Font.custom(rawValue, size: 16) }
}
```

**Side-channels:** `Info.plist` `UIAppFonts` array; `Package.swift` `.process("Fonts")` resource rules. Absence of `relativeTo:` on a `Font.custom` call sets `hasDynamicType: false` (accessibility flag).

**Output shape:**
```ts
{
  category: "typography",
  sourcePath: "Sources/UI/Tokens/Font+App.swift", line: 8, col: 4,
  declName: "bodyMd",
  rawValue: "Font.custom(\"JetBrainsMono-Regular\", size: 16, relativeTo: .body)",
  normalizedValue: { fontFamily: "JetBrainsMono-Regular", fontSize: 16, textStyle: "body" },
  hasDynamicType: true,
  context: "extension Font static let"
}
```

### 6.3 Spacing

**Source patterns:**
```swift
.padding(16)
.padding(.horizontal, 24)
.padding(EdgeInsets(top: 8, leading: 12, bottom: 8, trailing: 12))
VStack(spacing: 12) { ... }
HStack(spacing: 8) { ... }
Spacer().frame(minHeight: 32)

enum Spacing {
    static let xs: CGFloat = 4
    static let sm: CGFloat = 8
    static let md: CGFloat = 16
}
```

**Edge cases:** computed spacing (`spacing: isCompact ? 8 : 16`) records both branch values with `context: "conditional"`. Named constants (`spacing: Constants.padding`) record the reference; LLM resolves it later if the declaration is also in findings.

### 6.4 Corner Radius / Shape

**Source patterns:**
```swift
.cornerRadius(12)
RoundedRectangle(cornerRadius: 16, style: .continuous)
.clipShape(RoundedRectangle(cornerRadius: 8))
.clipShape(Circle())
extension View {
    func cardShape() -> some View { clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous)) }
}
```

`Circle()` / `Capsule()` / `Ellipse()` → record shape name with `isFullRadius: true`. `UnevenRoundedRectangle(cornerRadii:)` (iOS 16+) captures all four radii. Output adds `shapeType` (`rounded` | `circle` | `capsule` | `adaptive`) and optional `style` (`continuous` | `circular`).

### 6.5 Shadows / Elevation

**Source patterns:**
```swift
.shadow(color: .black.opacity(0.12), radius: 8, x: 0, y: 4)
extension View {
    func cardShadow() -> some View {
        shadow(color: .black.opacity(0.08), radius: 4, x: 0, y: 2)
    }
}
```

Output: `{ color, radius, x, y, opacity }` plus `declName` if wrapped in a named convenience.

### 6.6 Animation

**Source patterns:**
```swift
.animation(.easeInOut(duration: 0.3), value: isVisible)
.animation(.spring(response: 0.5, dampingFraction: 0.75), value: offset)
withAnimation(.easeOut(duration: 0.2)) { ... }
extension Animation {
    static let standard = Animation.spring(response: 0.4, dampingFraction: 0.8)
}
```

DTCG motion module is unstable — emit findings into `$extensions.<vendor>.animation` with `{ type, duration, response, dampingFraction, curve }`. `withAnimation` call sites are flagged as drift candidates if their curve doesn't match a declared `extension Animation` constant.

### 6.7 Components

**Source patterns:**
```swift
struct PrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .padding(.horizontal, 24)
            .padding(.vertical, 12)
            .background(Color.brandPrimary)
            .foregroundStyle(Color.white)
            .clipShape(RoundedRectangle(cornerRadius: 12))
    }
}

struct CardModifier: ViewModifier {
    func body(content: Content) -> some View {
        content.background(Color.surfaceCard).clipShape(RoundedRectangle(cornerRadius: 16))
    }
}

extension View {
    func cardStyle() -> some View { modifier(CardModifier()) }
}
```

Walk `makeBody` / `body` to collect modifier chains. Custom `View` structs included when they wrap a single primary child view call. Output: `{ declName, protocol, modifierChain: [{ name, args }], sourcePath, line }`.

### 6.8 iOS 26 Liquid Glass

**Source patterns:**
```swift
.glassEffect()
.glassEffect(.regular)
.glassEffect(.regular.tint(Color.brandPrimary).interactive())
.glassEffect(.clear)
GlassEffectContainer(spacing: 8) { ... }
.glassEffectID("card", in: glassNamespace)
.buttonStyle(.glass)
.buttonStyle(.glassProminent)
```

No DTCG primitive — emit under `$extensions.<vendor>.material`:
```json
"$extensions": {
  "com.example.material": {
    "glass-card": { "variant": "regular", "tint": "{color.brandPrimary}", "interactive": true }
  }
}
```

**Audit flag:** if `.glassEffect()` is detected on a `List`, `ScrollView`, or content card (parent is not a navigation-layer container), record `severity: "warning"` — _Apple guidance reserves glass for navigation layer only._

### 6.9 Theme Injection

**Source patterns:**
```swift
private struct ThemeKey: EnvironmentKey {
    static let defaultValue: Theme = .default
}
extension EnvironmentValues {
    var theme: Theme { get { self[ThemeKey.self] } set { self[ThemeKey.self] = newValue } }
}

extension EnvironmentValues {
    @Entry var theme: Theme = .default        // iOS 18+
}

@Observable final class ThemeProvider {
    var colorScheme: AppColorScheme = .brand
    var radiusScale: RadiusScale = .rounded
}
```

Output: `{ keyName, valueType, defaultValue, tier: "global" | "alias" | "control" | null, sourcePath, line }` (FluentUI tier inferred from naming).

### 6.10 Font Weight, Line Height, Letter Spacing — Inference Rules

SwiftUI source rarely carries `lineHeight` or `letterSpacing` explicitly, and `fontWeight` is encoded in the PostScript font name rather than a standalone parameter. The typography emitter applies these inference rules:

- **`fontWeight`** is parsed from the PostScript font name suffix:
  `-Thin` → 100, `-ExtraLight`/`-UltraLight` → 200, `-Light` → 300, `-Regular`/`-Book` → 400, `-Medium` → 500, `-SemiBold`/`-DemiBold` → 600, `-Bold` → 700, `-ExtraBold`/`-Heavy` → 800, `-Black` → 900. Unmatched suffixes default to 400 with `_inferred: "fallback"`.
- **`lineHeight`** defaults to `1.5` (unitless multiplier) when not present in source. SwiftUI's `.lineSpacing` modifier on a `Text` is captured when adjacent to the font declaration; otherwise the default applies.
- **`letterSpacing`** defaults to `"0px"` when `.tracking()` and `.kerning()` modifiers are absent. When present, the captured CGFloat value is emitted in px.

Inferred values are tagged `_inferred: true` in the candidate token; the LLM normalize pass may overwrite the inference with a per-style decision recorded in `$description`.

### 6.11 Raw Findings JSON Shape

```ts
interface RawFinding {
  category:
    | "color" | "typography" | "spacing" | "cornerRadius"
    | "shadow" | "animation" | "component" | "liquidGlass" | "theme";

  sourcePath: string;
  line: number;
  col: number;

  declName: string | null;
  rawValue: string;
  normalizedValue: unknown | null;   // null = needs LLM
  context: string;

  isDeclaration: boolean;
  isSystemAlias?: boolean;
  assetName?: string;
  hasDarkVariant?: boolean;
  hasDynamicType?: boolean;
  shapeType?: string;
  modifierChain?: Array<{ name: string; args: string[] }>;
  severity?: "info" | "warning" | "error";
}

interface FindingsFile {
  tokextractVersion: string;
  targetRepo: string;
  extractedAt: string;
  findings: RawFinding[];
}
```

`normalizedValue` is populated only when the value is deterministically parseable. Hex strings, `Color(uiColor:)`, computed expressions, and modifier chains are left `null` for the LLM normalization pass. Every finding retains `sourcePath` + `line` + `rawValue` so output is always traceable.

### 6.12 Candidate Token JSON Shape

The contract between the LLM normalize pass and the DTCG emitter. One file per category, written by the subagent to `.tokextract/llm-out/normalize-<category>.json`.

```ts
interface CandidateToken {
  // Final canonical name, namespaced per DTCG group conventions
  name: string;                       // e.g. "color.semantic.brand"

  // DTCG fields — emitter copies these into tokens.json directly
  $type: string;                      // "color" | "dimension" | "typography" | "shadow" | ...
  $value: unknown;                    // type-appropriate; alias references allowed
  $description?: string;
  $extensions?: Record<string, unknown>;

  // Provenance — every candidate must cite its source(s)
  _provenance: Array<{
    sourcePath: string;
    line: number;
    rawValue: string;
  }>;

  // LLM metadata — never written to tokens.json
  _confidence: "high" | "medium" | "low";
  _llmDerived: boolean;               // false for direct extension Color extractions
  _inferred?: string;                 // "fallback" | "default" | description
}

interface CandidateFile {
  category: RawFinding["category"];
  candidates: CandidateToken[];
  // Tokens the LLM could not classify — preserved for the audit report
  unresolved: Array<{
    rawValue: string;
    sourcePath: string;
    line: number;
    reason: string;
  }>;
}
```

The DTCG emitter reads all `CandidateFile`s, strips `_provenance` / `_confidence` / `_llmDerived` / `_inferred` / `unresolved` fields (those land in `audit.md` instead), and writes the surviving DTCG fields to `tokens.json`. Schema validation runs on the stripped output.

---

## 7. Functional Requirements — Outputs

### 7.1 tokens.json (W3C DTCG 2025.10)

Primary output. Media type `application/design-tokens+json`, extension `.tokens.json`. Every token carries `$value` and `$type`; `$description` is emitted wherever intent can be derived from source context, semantic naming, or the LLM narration pass.

**Color space policy: preserve source space.** A Display-P3 `.colorset` emits as `display-p3`; a hex literal emits as `srgb`; an explicit `Color(.sRGB,...)` call emits as `srgb`. The output may legitimately contain mixed color spaces. Use `--force-color-space` (§8.5) only when a downstream consumer requires single-space input.

**Aliasing.** Semantic tokens reference primitives via `{path.to.token}` syntax. Rule: any token whose *purpose* differs from its *value* must alias rather than duplicate. Primitive layer holds raw values; semantic layer holds role-intent aliases; component layer aliases semantics.

**Color.** Explicit color-space components arrays, not hex strings. Hex literals are upgraded to `srgb`. Display P3 / OKLCH values from `.colorset` with wide-gamut components are preserved natively. Dark/light pairs become a token set with `$extensions.mode` or a separate `dark` group aliasing back to primitives.

**Typography.** Composite token: `fontFamily`, `fontSize` (`"18px"`), `fontWeight` (numeric), `lineHeight` (unitless), `letterSpacing`. The SwiftUI `relativeTo:` parameter is preserved in `$extensions.swiftui.relativeTo` (Dynamic Type signal).

**Spacing / radius.** `$type: "dimension"`, values as `"16px"`.

**Shadow.** DTCG composite: `color`, `offsetX`, `offsetY`, `blur`, `spread`.

**Animation.** Motion module is draft — emit under `$extensions.motion` with `{ easing, duration, response, dampingFraction }`. DESIGN.md prose covers intent.

**Components.** Composite combining typed sub-token references plus `$extensions.swiftui.modifierChain` for round-trip verification.

**Liquid Glass / materials.** No DTCG primitive — emit under `$extensions.<vendor>.material` where `<vendor>` is derived from the target's bundle ID (e.g. `com.myapp` → `$extensions.com_myapp.material`). Shape: `{ variant, tint, interactive, container }`.

**Validation.** Ajv runs the output against bundled `schemas/dtcg-2025.10.json` before writing. Schema failure is a hard error.

**Example snippet:**

```json
{
  "color": {
    "primitive": {
      "$type": "color",
      "blue-500": {
        "$value": { "colorSpace": "display-p3", "components": [0.067, 0.537, 1.0, 1.0] },
        "$description": "Wide-gamut blue extracted from Assets.xcassets/AccentColor.colorset"
      },
      "ink-900": {
        "$value": { "colorSpace": "srgb", "components": [0.102, 0.110, 0.118, 1.0] },
        "$description": "Darkest ink; sourced from Color(hex: \"#1A1C1E\") in 3 call sites"
      }
    },
    "semantic": {
      "$type": "color",
      "brand": { "$value": "{color.primitive.blue-500}", "$description": "Primary action color" },
      "surface-dark": { "$value": "{color.primitive.ink-900}" }
    }
  },
  "typography": {
    "$type": "typography",
    "body-md": {
      "$value": {
        "fontFamily": "JetBrainsMono-Regular", "fontSize": "16px",
        "fontWeight": 400, "lineHeight": 1.5, "letterSpacing": "0px"
      },
      "$extensions": { "swiftui": { "relativeTo": "body" } }
    }
  },
  "spacing": {
    "$type": "dimension",
    "sm": { "$value": "8px" },
    "md": { "$value": "16px", "$description": "4/8 scale step 4 — most common padding value" },
    "lg": { "$value": "24px" }
  },
  "components": {
    "button-primary": {
      "$value": {
        "background": "{color.semantic.brand}",
        "foreground": "{color.primitive.ink-900}",
        "paddingHorizontal": "{spacing.md}",
        "paddingVertical": "{spacing.sm}",
        "cornerRadius": "{radius.md}",
        "typography": "{typography.label-sm}"
      },
      "$extensions": {
        "swiftui": {
          "protocol": "ButtonStyle",
          "modifierChain": [
            ".background(Color.brand)",
            ".foregroundStyle(Color.inkDark)",
            ".padding(.horizontal, 16)",
            ".clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))"
          ]
        }
      }
    }
  }
}
```

### 7.2 DESIGN.md (Google @google/design.md alpha format)

Agent-readable narrative companion. YAML front-matter carries machine-readable token summary; Markdown prose carries *why* — brand intent, design decisions, usage rules DTCG cannot express. Prose is LLM-generated in the narration pass.

**Section order is mandatory** (the `section-order` lint rule enforces it): Overview → Colors → Typography → Layout → Elevation & Depth → Shapes → Components → Do's and Don'ts.

**Acceptance criterion.** An LLM given only this file plus a feature brief should produce brand-correct UI without additional token prompting. Failure means the narration pass must regenerate.

**Format isolation.** `emitters/design-md.ts` owns all schema knowledge. The format is alpha; emitter is architected as a single-file swap.

**Lint rules emitter must satisfy** before writing — each is a deterministic check, not an LLM judgment call:

| Rule | Definition |
|---|---|
| `broken-ref` | Every `{{token}}` reference in prose resolves to a token in front-matter or `tokens.json`. |
| `missing-primary` | At least one color is tagged as primary/brand in front-matter (any token whose name contains `primary`, `brand`, or `accent`). |
| `contrast-ratio` | Every pairing implied by Component-section prose meets WCAG AA (4.5:1 body, 3:1 large ≥18.66px). Computed via WCAG relative-luminance formula on the resolved token colors. |
| `orphaned-tokens` | Every token in front-matter is referenced in at least one prose section. |
| `token-summary` | The front-matter token count matches the number of distinct tokens referenced in prose ±0. |
| `missing-sections` | All eight mandatory sections present in canonical order. |
| `missing-typography` | At least one typography token documented in the Typography section. |
| `section-order` | Sections appear in the canonical sequence: Overview → Colors → Typography → Layout → Elevation & Depth → Shapes → Components → Do's and Don'ts. |

Lint failures abort the run with an actionable error. The lint module is `emitters/design-md-lint.ts` and is unit-tested against fixture markdown.

**Skeleton:**
```markdown
---
name: "MyApp Design System"
version: "1.0.0"
extracted: "2026-05-08"
source: "SwiftUI — tree-sitter pass + LLM normalization"
tokens:
  colors:
    brand: "{color.semantic.brand}"
    surface-dark: "{color.semantic.surface-dark}"
  typography:
    body-md: "{typography.body-md}"
  spacing:
    sm: "{spacing.sm}"
    md: "{spacing.md}"
---

## Overview
MyApp is a developer-facing tool with a dense information hierarchy. The design language
prioritizes legibility over decoration: a monospaced type stack, a restrained ink palette,
and a single accent blue that carries all interactive intent.

## Colors
The palette is built on two primitives: `color.primitive.blue-500` (Display P3 wide-gamut
blue, extracted from the Xcode Asset Catalog) and `color.primitive.ink-900` (consolidated
from three near-identical hex values found in the codebase — see audit.md §2). ...

## Typography
All text is set in JetBrains Mono. Dynamic Type: every `Font.custom` call includes
`relativeTo:` — accessibility scaling is preserved throughout. ...

## Layout
Spacing follows a strict 4/8 scale. `{{spacing.md}}` (16px) is the canonical interior
padding for cards and list rows. ...

## Elevation & Depth
Two elevation levels are in use. `elevation.low` for cards; `elevation.high` for modals
and sheets. No intermediate levels — adding a third requires an explicit design decision.

## Shapes
Corner radii follow a three-step scale; all radii use `.continuous` curve style.

## Components
**PrimaryButton**: brand background, ink foreground, md padding, md radius, label-sm typography.

## Do's and Don'ts
**Do** use `color.semantic.brand` for all interactive affordances.
**Don't** apply `.glassEffect()` to cards, list rows, or media containers — Apple's design
guidance reserves glass for the navigation layer.
```

### 7.3 audit.md

Markdown report. Tone: suggestions only, never auto-apply. Every finding includes a `file:line` reference.

```markdown
# Design System Audit
Generated: 2026-05-08 | Source: ./MyApp | Tokens: tokens.json v1.0.0

## 1. Magic Numbers
### Spacing
| Value | Occurrences | Example location |
|---|---|---|
| 14px | 7 | `Views/Feed/FeedRow.swift:88` |

> 14px is between `spacing.sm` (8) and `spacing.md` (16). Suggest rounding to `spacing.md`.

## 2. Near-Duplicate Values
### Colors (deltaE < 2.5)
**Cluster A — near-black ink** (proposed canonical: `color.primitive.ink-900` = `#1A1C1E`)
- `#1A1C1E` — `Styles/Colors.swift:12`
- `#1A1D1E` — `Views/Dashboard/DashboardView.swift:67`
- `#1B1C1E` — `Components/Card/CardBackground.swift:9`

## 3. Orphaned Tokens
| Token | Definition | Last seen |
|---|---|---|
| `Color.deprecated` | `Styles/Colors.swift:88` | Never used |

## 4. Off-Scale Literals
| Value | Type | Location | Nearest scale value |
|---|---|---|---|
| 14px | spacing | `Views/Auth/LoginView.swift:55` | 16px (`spacing.md`) |

## 5. Contrast Warnings
| Foreground | Background | Ratio | Required | Location |
|---|---|---|---|---|
| `#8A8F98` | `#1A1C1E` | 3.8:1 | 4.5:1 | `Components/Card/CardMeta.swift:41` |

## 6. Liquid Glass Violations
| Location | Component context | Violation |
|---|---|---|
| `Views/Feed/FeedCard.swift:18` | Card (content layer) | Glass on content card |

## 7. Harmonization Recommendations
| # | Confidence | Recommendation | Locations |
|---|---|---|---|
| 1 | High | Merge 3 near-black hex values into `color.primitive.ink-900` | See §2 Cluster A |
| 2 | High | Replace `14px` and `17px` literals with `spacing.md` (16px) | §4, 9 locations |
```

### 7.4 Output Directory Layout

```
<output-dir>/
├── tokens.json                      # W3C DTCG 2025.10 — canonical machine truth
├── DESIGN.md                        # Google @google/design.md alpha — narrative
├── audit.md                         # Drift report
└── .tokextract/                    # Internal state; safe to delete to force a clean re-run
    ├── findings.raw.json            # AST + regex extraction, pre-LLM
    ├── llm-tasks.json               # Manifest of pending / done LLM passes
    ├── prompts/
    │   ├── normalize-color.md
    │   ├── normalize-typography.md
    │   ├── ... (one per category)
    │   ├── harmonize.md
    │   └── narrate.md
    ├── llm-out/
    │   ├── normalize-color.json     # CandidateFile (§6.12)
    │   ├── ... (one per category)
    │   ├── harmonize.json           # ranked recommendations
    │   └── (DESIGN.md is written directly to <output-dir>/DESIGN.md by the narrate subagent)
    └── previous/
        └── tokens.json              # Snapshot of last run, for diff (§8.3)
```

All internal state is colocated under `.tokextract/`. Re-runs with adjusted prompts or a different model don't require re-parsing — `findings.raw.json` is durable. Deleting `.tokextract/` forces a full re-extraction.

---

## 8. Architecture & Tech Stack

### 8.1 Form Factor

Claude Code skill. Bundled as Node/TypeScript helpers + a `SKILL.md` that orchestrates the host Claude through a multi-step pipeline. Invoked via `/tokextract` or auto-triggered when the user's request matches skill activation phrases.

**LLM invocation model: skill emits prompts; host Claude spawns subagents.** The Node helpers handle deterministic work (parsing, clustering, schema validation, emitting). For each LLM pass, the helper writes a self-contained prompt file (e.g. `.tokextract/prompts/normalize-color.md`) and a manifest (`.tokextract/llm-tasks.json`) describing what needs to run, with a recommended model tier per task. `SKILL.md` instructs the host Claude to read the manifest, spawn one subagent per pending task **via the `Agent` tool** (recommendedModel → subagent model; promptPath → subagent prompt; responsePath → subagent's required Write target), and re-run the Node helper once all tasks are `done`. Subagents write their structured JSON output to `responsePath` themselves using the Write tool — the host doesn't proxy the response, which keeps raw findings out of the host context entirely.

**Example `SKILL.md` skeleton:**

```markdown
---
name: tokextract
description: Extract a design system (DTCG tokens + DESIGN.md + audit) from any SwiftUI codebase
trigger_phrases:
  - "extract design tokens from this repo"
  - "run tokextract"
  - "audit my SwiftUI design system"
---

# Tokextract

When invoked, run this pipeline. Each step is restartable; if any LLM task fails,
re-running picks up where it left off.

## 1. Parse + analyze (deterministic)
Run: `node ~/.claude/skills/tokextract/dist/extract.js parse --path <path> [--output <out>]`
This emits `.tokextract/findings.raw.json` and writes prompt files +
`.tokextract/llm-tasks.json` for the LLM passes.

## 2. Run pending LLM tasks
Read `<out>/.tokextract/llm-tasks.json`. For each task with `status: "pending"`,
spawn an Agent subagent with:
  - subagent_type: "general-purpose"
  - model: task.recommendedModel
  - description: task.id
  - prompt: contents of task.promptPath, with the instruction:
      "Write your structured JSON response to <task.responsePath> using the Write tool.
       Validate against <task.responseSchema> if provided. Reply with exactly 'done'."

Run independent tasks (different categories) in parallel — multiple Agent calls in one
message. Tasks within a single pass (all normalize tasks) are independent. Harmonize and
narrate depend on normalize completing.

## 3. Emit final artifacts (deterministic)
Run: `node ~/.claude/skills/tokextract/dist/extract.js emit --output <out>`
This consumes LLM responses, validates against DTCG 2025.10, and writes
`tokens.json`, `audit.md`. It also writes `narrate-context.md` if narrate hasn't run.

## 4. Run narrate (if needed)
If `<out>/.tokextract/llm-tasks.json` shows the narrate task still pending,
spawn one more subagent with task.recommendedModel against narrate-context.md,
with the instruction to Write `<out>/DESIGN.md` directly.

## 5. Finalize
Run: `node ~/.claude/skills/tokextract/dist/extract.js finalize --output <out>`
This runs the DESIGN.md lint pass and prints a summary.
```

This protocol is the load-bearing contract between the Node helpers and the host runtime. Both sides must agree on it; both are tested against fixture sessions.

Implications:
- **No separate API key.** All Claude calls reuse the host session's credentials and quota.
- **Not standalone.** Tokextract cannot run outside a Claude Code session for full extraction. CI use is supported only via `--no-llm` (deterministic-only output).
- **Restartable.** Each pipeline step is idempotent and writes to disk; if any LLM call fails or the session is interrupted, re-running picks up where it left off.
- **Inspectable.** Every prompt and every LLM response is persisted, making the run fully auditable.

### 8.2 Tech Stack (settled)

| Concern | Decision |
|---|---|
| Language | TypeScript, Node 20+ |
| Swift parser | `alex-pinkus/tree-sitter-swift` (NPM). SwiftSyntax is a v2 `--accurate` opt-in only. |
| Schema validation | Ajv against bundled `dtcg-2025.10.json` |
| LLM | Host Claude Code session (no Anthropic SDK dependency in v1; skill emits prompts, Claude executes). See §8.1, §9.0. |
| Model strategy | Tiered per pass: Haiku for normalize, Sonnet for harmonize, Sonnet for narrate. Override via `--model-normalize`, `--model-harmonize`, `--model-narrate`. The recommended model is written into `llm-tasks.json` for `SKILL.md` to honor when spawning subagents. |
| Test runner | Vitest |
| Linter | Biome |
| Distribution | Single Node helper bundle + `SKILL.md` + `schemas/dtcg-2025.10.json`, installed under `~/.claude/skills/tokextract/` for v1. |

The tree-sitter-swift tradeoff is accepted explicitly: roughly a 5% miss rate on unusual Swift syntax in exchange for zero installation friction. Source locations are always preserved so users can verify anything flagged.

### 8.3 Module Layout

```
tokextract/
├── SKILL.md                     # routing description + body instructions
├── package.json
├── extract.ts                   # CLI entry; orchestrates pipeline stages
├── parsers/
│   ├── swift-ast.ts             # tree-sitter-swift bootstrap; shared query helpers
│   ├── color.ts
│   ├── typography.ts
│   ├── spacing.ts
│   ├── shape.ts
│   ├── shadow.ts
│   ├── animation.ts
│   ├── component.ts
│   ├── glass.ts
│   ├── theme.ts
│   └── asset-catalog.ts         # .xcassets/*.colorset/Contents.json
├── analyzers/
│   ├── cluster-numeric.ts
│   ├── cluster-color.ts
│   ├── drift-detector.ts
│   ├── diff.ts                  # structural JSON diff between current and previous tokens.json
│   └── usage-scanner.ts         # regex pass for hex / numeric literals
├── emitters/
│   ├── dtcg.ts
│   ├── design-md.ts             # isolated; schema is alpha
│   └── audit-report.ts
├── llm/
│   ├── normalize.ts
│   ├── harmonize.ts
│   └── narrate.ts               # highest-leverage LLM use
├── schemas/
│   └── dtcg-2025.10.json
└── tests/
    └── fixtures/                # ≥2 distinct Swift apps required
```

### 8.4 Pipeline (Data Flow)

The pipeline alternates between Node helpers (deterministic) and host-Claude steps (LLM). `SKILL.md` is the conductor — it tells Claude to invoke the helper, then run any pending LLM tasks, then invoke the helper again. Each step writes durable state to `<output-dir>/.tokextract/`.

```
[Node]    1. DISCOVERY     walk --path for *.swift + .colorset/Contents.json
                            (respect .gitignore)
              ↓
[Node]    2. PARSE         tree-sitter-swift → category parsers → findings.raw.json
              ↓
[Node]    3. SIDE-CHANNEL  regex for hex + numeric literals → merged into findings
              ↓
[Node]    4. ANALYZE       cluster-numeric, cluster-color, drift-detector
              ↓
[Node]    5a. EMIT PROMPTS write per-category normalize prompts +
                            harmonize prompt + llm-tasks.json manifest
              ↓
[Claude]  5b. LLM NORMALIZE  read manifest → spawn Haiku subagent per category →
                              write tokens.<category>.candidate.json
              ↓
[Claude]  6.  LLM HARMONIZE  spawn Sonnet subagent → write
                              audit-recommendations.json
              ↓
[Node]    6b. DIFF          if .tokextract/previous/tokens.json exists, structural-diff
                              against the new candidate set; produce diff-summary.json
                              for inclusion at the top of audit.md as
                              "## Changes since last extraction"
              ↓
[Node]    7a. EMIT          merge candidates → tokens.json (Ajv-validated, fail-fast);
                              audit.md from deterministic findings + LLM recs + diff summary;
                              snapshot the new tokens.json to .tokextract/previous/
              ↓
[Node]    7b. EMIT NARRATE PROMPT  prepare narrate-context.md (final tokens +
                                    findings + audit summary)
              ↓
[Claude]  7c. LLM NARRATE   spawn Sonnet subagent → write DESIGN.md
              ↓
[Node]    8.  FINALIZE      DESIGN.md lint pass (broken-ref, contrast-ratio,
                              section-order, etc); print summary
```

Stages 1–4 and 7a, 7b, 8 run without LLM calls. Claude is invoked only in 5b, 6, and 7c. Token spend is proportional to normalization and prose work, not codebase size.

### 8.5 CLI / Skill Interface

```
tokextract --path <swift-repo>
            [--output <dir>]            default: <path>/.tokextract/
            [--vendor-namespace <s>]    default: derived from Info.plist bundle ID
            [--target-os <ver>]         default: implicit detect from Package.swift / .xcodeproj;
                                        fallback iOS 17. Gates Liquid Glass (iOS 26) and
                                        @Entry macro (iOS 18) extraction.
            [--force-color-space <s>]   default: preserve source space.
                                        Set to srgb | display-p3 | oklch to force-convert
                                        all emitted colors. Use when downstream tooling
                                        (e.g. Style Dictionary v4) needs single-space input.
            [--skip <category,...>]     none skipped by default. Skipped categories
                                        produce no prompt files, no manifest entries,
                                        no candidate JSON; the emitter treats them as absent.
            [--delta-e-threshold <n>]   default: 2.5. CIEDE2000 distance below which two
                                        colors cluster as near-duplicates.
            [--max-files <n>]           default: 2000. Hard limit on .swift files. If the
                                        repo has more, discovery aborts with a non-zero exit
                                        and a clear error. v1 does not support reconciliation
                                        across larger codebases (tracked under §12 for v2).
            [--no-llm]                  deterministic-only; skips normalize/harmonize/narrate.
                                        DESIGN.md emitted as a stub with deterministic content
                                        marked `generated: deterministic`.
            [--model-normalize <id>]    default: claude-haiku-4-5-20251001
            [--model-harmonize <id>]    default: claude-sonnet-4-6
            [--model-narrate <id>]      default: claude-sonnet-4-6
                                        Set any to claude-opus-4-7 for max-quality runs.
            [--self-critique]           run an extra LLM critique pass after narrate (§9.3)
            [--verbose]
            [--json]                    NDJSON progress on stdout
```

Every flag is repo-agnostic. No project-specific config keys.

**Color space handling.** Default is **preserve source space** — a wide-gamut Display-P3 colorset emits as `display-p3`; a hex literal emits as `srgb`; an explicit `Color(.sRGB,...)` call emits as `srgb`. Use `--force-color-space` only when a downstream consumer cannot handle mixed spaces (e.g. SD v4's partial DTCG support). Force-conversion is lossy for any wide-gamut value being collapsed to sRGB; the audit logs every conversion that exceeded a perceptual threshold.

**`--watch` mode is v2.** Not exposed in the v1 CLI (removed from this surface; tracked under §12).

**Skill auto-trigger phrases:** "extract design tokens from this repo"; "run tokextract"; "audit my SwiftUI design system"; "what design tokens does this app use"; "recover the design system from this codebase".

### 8.6 Repo-Agnosticism Guarantees

- **No hardcoded font names, color names, or vendor strings.**
- **Vendor namespace is derived, not assumed.** Defaults to `CFBundleIdentifier` from the target's `Info.plist`. If absent, falls back to `com.unknown.<dirname>` with a warning.
- **Test fixture coverage enforces the bar.** No extraction pattern is treated as canonical until golden-file tests pass against ≥2 distinct Swift apps.
- **System semantic colors preserved as aliases**, not concretized. `Color.accentColor`, `.primary`, `.secondary`, `Color(uiColor: UIColor.system*)` are emitted as alias tokens to the system token set.
- **Liquid Glass is marked Apple-proprietary and iOS-26-only** in `$extensions`. Not translated to web/Android.

---

## 9. Analyzers & LLM Pipeline

### 9.0 Invocation Model

Per §8.1, LLM passes are not direct API calls from the Node helpers. The helpers emit **prompt files** + an **`llm-tasks.json` manifest**; `SKILL.md` instructs the host Claude session to read the manifest and spawn the recommended subagent (model tier + prompt path + expected output path) per task. Claude writes responses back to `<output-dir>/.tokextract/llm-out/` and the next helper stage consumes them.

The manifest schema:
```ts
interface LlmTask {
  id: string;                       // e.g. "normalize-color"
  pass: "normalize" | "harmonize" | "narrate" | "self-critique";
  recommendedModel: string;         // e.g. "claude-haiku-4-5"
  promptPath: string;               // .tokextract/prompts/normalize-color.md
  responsePath: string;             // .tokextract/llm-out/normalize-color.json
  responseSchema: string | null;    // path to JSON Schema for validation, if any
  status: "pending" | "done" | "error";
}
```

This keeps every LLM call inspectable, restartable, and mockable for tests.

Extraction splits cleanly into deterministic analyzers (run on every invocation, fast and cheap) and targeted LLM passes (reserved for work that genuinely requires semantic reasoning). Burning tokens on work a clustering algorithm handles correctly is waste; skipping LLM where intent inference is the whole job produces brittle output.

### 9.1 Deterministic Analyzers (no LLM)

These run on every invocation, including `--no-llm` mode. They produce `findings.raw.json` — the shared input for all downstream work.

- **Numeric clustering.** Collect every spacing, radius, and sizing literal; map onto a canonical 4/8 scale (`xs=4, sm=8, md=16, lg=24, xl=32, 2xl=48`). Output: histogram + nearest-canonical mapping. Distance > 0 → drift candidate.
- **Color clustering (deltaE).** Pairwise CIEDE2000 distance below threshold (default `2.5`, override via `--delta-e-threshold`) groups colors as near-duplicates. Each cluster carries member sources + proposed canonical (median or most-used).
- **Hex/RGB normalization.** Runs before clustering. Every color form (hex, `Color(red:green:blue:)`, `UIColor`, named system colors) is converted to a canonical sRGB or Display-P3 component tuple.
- **Usage scan.** Counts call-site references for every declared token. Zero references → orphan candidate. Single reference → low-confidence flag.
- **Off-scale detection.** Numeric literals not matching any canonical scale value and not close enough to cluster.

### 9.2 LLM Passes

Three targeted passes, each with a single job. All three use schema-first prompts — the DTCG 2025.10 JSON Schema is included in the prompt context, output is validated against it before acceptance, and prompts disclose only one category of findings at a time (progressive disclosure per CodeAgents / CODESTRUCT / SkillReducer).

#### 9.2.1 Normalize Pass (`llm/normalize.ts`)

**Input:** `findings.raw.json`, one category per call.
**Job:** propose semantic names for unnamed values; classify each token as primitive, semantic, or component-level; catch category misclassification.
**Prompt pattern:** schema-first; extract first, then produce schema-valid JSON in a second pass. Schema validation failure triggers a single retry with the validation error appended; second failure falls back to a mechanical name and is flagged for manual review.
**Output:** `tokens.<category>.candidate.json`.

#### 9.2.2 Harmonize Pass (`llm/harmonize.ts`)

**Input:** clustering output from §9.1 + raw findings for context.
**Job:** propose canonical tokens for clusters; resolve "these three near-identical greys should collapse to `color.surface.dark`"; surface intent the distance metric cannot infer.
**Output:** ranked harmonization recommendations with confidence scores (cluster size + source coherence) and dissenting source references. Feeds `audit.md`.

#### 9.2.3 Narrate Pass (`llm/narrate.ts`)

**Input:** final `tokens.json` + raw findings + audit findings.
**Job:** generate `DESIGN.md` — Overview, brand rationale, per-category narrative, Do's and Don'ts. **Highest-leverage AI use in the pipeline.** DTCG carries values; DESIGN.md carries *why*. Acceptance: an LLM fed only DESIGN.md should produce brand-correct UI without further prompting.
**Output:** `DESIGN.md`.

### 9.3 Self-Critique Pass (opt-in)

Behind `--self-critique`. After narrate, prompts: "What is missing? What is misnamed? What conflicts with stated intent?" Response appended to `audit.md`. Catches naming drift. Costs an additional LLM call per run — disabled by default.

### 9.4 Token Budget & Progressive Disclosure

One category per LLM call. Categories accumulate independently — never the 30k-line monolith. v1 hard-limits at 2000 `.swift` files (see `--max-files` in §8.5); above that, discovery aborts with a clear error. Subagent-per-directory reconciliation for larger codebases is tracked in §12 as v2 scope. The hard limit is honest scope: silent degradation on large repos would produce duplicate token names with conflicting values, and that's a worse failure mode than an explicit abort.

### 9.5 `--no-llm` Mode

Skips all three LLM passes. **The only mode that runs end-to-end without a host Claude session** — i.e. usable in CI. `tokens.json` is emitted with mechanical names (e.g. `color-1A1C1E`, `spacing-12`); `DESIGN.md` is emitted as a deterministic stub with the front-matter token inventory, a generated-by header marked `generated: deterministic`, and section placeholders explaining that prose was skipped (so DESIGN.md lint rules like `missing-sections` still pass); `audit.md` contains only deterministic findings (no harmonization recommendations).

### 9.6 Confidence & Traceability

Every LLM-derived suggestion carries: source `file:line` references for every input value; a confidence label (`high | medium | low`); an `llm_derived: true` marker. **No suggestion is auto-applied to user source.**

---

## 10. Success Metrics & Acceptance Criteria

### 10.1 Quantitative Metrics

- **Schema conformance:** `tokens.json` validates against the DTCG 2025.10 JSON Schema on 100% of runs, across all supported categories.
- **Round-trip fidelity:** `Color` extension generated by piping `tokens.json` through Style Dictionary diffs ≤10% (by line count) against the source repo's existing `extension Color`.
- **Drift detector recall:** on a labelled fixture, the drift detector identifies ≥80% of human-annotated near-duplicates (colors within ΔE < 3, spacing values within 2px).
- **Extraction latency:** single-run extraction on ~200 `.swift` files completes in < 60s on M3 hardware, excluding LLM time.
- **LLM token budget:** total tokens across all LLM passes per run < 200k for the same ~200-file repo.

### 10.2 Qualitative Acceptance Bar

- **Brand fidelity test:** an LLM (Claude / Cursor / Windsurf) given only `DESIGN.md` plus a feature request produces a brand-correct SwiftUI view — correct colors, typeface, spacing scale — without further prompting.
- **Audit utility test:** `audit.md` surfaces 5–20 actionable harmonization recommendations on a vibe-coded fixture; majority accepted as valid by a human reviewer.
- **Portability test:** the skill runs end-to-end on ≥2 structurally distinct Swift apps with zero repo-specific configuration and no uncaught exceptions.

### 10.3 Definition of Done (v1)

- `SKILL.md` published with description, invocation, examples.
- AST parsers for all 9 categories: Color, Typography, Spacing, Corner Radius/Shape, Shadows/Elevation, Animation, Components, Liquid Glass, Theme injection.
- Three emitters: `dtcg.ts`, `design-md.ts`, `audit-report.ts`.
- JSON Schema validator wired up; runs automatically before output.
- Two-pass pipeline: deterministic AST + regex → `findings.raw.json`; LLM pipeline → final outputs.
- `--no-llm` flag operational.
- ≥2 fixture repos under `tests/`, each with golden-file snapshots.
- Golden-file tests pass in CI; parser/emitter changes that alter fixture output fail the build until snapshots are updated explicitly.
- README covers installation, invocation, output format, manual Figma import path.

---

## 11. Risks & Caveats

- **DESIGN.md is alpha.** Schema breaking changes expected before v1.0. Mitigation: emitter isolated to `emitters/design-md.ts`; swap = one-file change.
- **DTCG 2025.10 tooling lags.** Style Dictionary v4 supports the earlier draft; full 2025.10 support lands in v5 (still in progress late 2025). Mitigation: validate `tokens.json` directly against bundled JSON Schema rather than relying on SD; pin SD version for round-trip tests.
- **tree-sitter-swift accuracy ceiling.** Community-maintained, not Apple. Unusual / new Swift syntax (some result builders, macro expansions, iOS 26 constructs) may parse imperfectly. Mitigation: every token carries source line; v2 adds `--accurate` SwiftSyntax mode.
- **Figma native DTCG export omits `description` fields** (community-reported late 2025). Mitigation: don't treat `$description` as round-trip-stable.
- **Penpot DTCG export drift.** Has been observed producing Tokens Studio-shaped JSON. Mitigation: validate Penpot-sourced input against spec before use.
- **LLM hallucination in naming pass.** Mitigation: deterministic AST pass establishes ground truth; LLM acts as labeler and prose author, never as value generator. Every token retains source line — hallucinated values are immediately falsifiable.
- **Liquid Glass is iOS-26-only and Apple-proprietary.** Mitigation: namespaced under `$extensions.<vendor>.material`, documented as non-portable.
- **Audit recommendations carry implicit value judgments.** Mitigation: every recommendation includes confidence level + source lines; the skill never modifies user source.
- **No prior art for Swift→tokens extraction.** Mitigation: validate against ≥2 structurally distinct repos before treating any pattern as canonical.

---

## 12. Out of Scope (v1)

- **Figma round-trip automation.** Documented manual path: emit `tokens.json` → user imports via TokensBrücke or Tokens Studio plugin. Direct REST API push is v2+ and Enterprise-only.
- **Component visual round-trip.** Figma REST API doesn't expose component creation. Components emitted as Markdown spec; designer creates manually.
- **SwiftSyntax-based parser.** v2 `--accurate` opt-in. Toolchain dependency cost outweighs marginal accuracy gain in v1.
- **Visual regression testing.** Use `pointfreeco/swift-snapshot-testing` separately.
- **UIKit-only codebases.** SwiftUI focus in v1; UIKit fallback v2+.
- **Multi-repo comparison mode.** v3.
- **Repos > 2000 `.swift` files.** v1 hard-aborts at the limit. Subagent-per-directory reconciliation lands in v2.
- **`--watch` mode.** Re-extract on file save. v2.
- **Bidirectional sync** (Figma → Swift PR). v3.
- **MCP server interface** for non-Claude-Code agents. v3.
- **Animation tokens as first-class DTCG primitives.** Motion module is draft; emitted under `$extensions` for now.

---

## 13. Resolved Decisions & Remaining Questions

### 13.1 Resolved (2026-05-08)

- **LLM invocation model** → Skill emits prompt files + `llm-tasks.json` manifest; host Claude executes via subagent spawning. No Anthropic SDK dependency. CI use is supported only via `--no-llm`. (See §8.1, §9.0.)
- **Default color space** → Preserve source space. Wide-gamut Display-P3 colorsets emit as `display-p3`; hex literals emit as `srgb`; explicit `Color(.sRGB,...)` calls emit as `srgb`. `--force-color-space` flag handles downstream tools that can't handle mixed spaces. (See §7.1, §8.5.)
- **Model strategy** → Tiered defaults per pass: Haiku for normalize, Sonnet for harmonize, Sonnet for narrate. Override via `--model-normalize`, `--model-harmonize`, `--model-narrate`. (See §8.2, §8.5.)
- **`--no-llm` DESIGN.md behavior** → Emit a deterministic stub with token inventory and `generated: deterministic` marker. Lint rules still pass. (See §9.5.)
- **SwiftUI version detection** → Hybrid: implicit detection from `Package.swift` `platforms` and/or `.xcodeproj` `IPHONEOS_DEPLOYMENT_TARGET`; `--target-os` flag overrides; conservative fallback iOS 17 (no Liquid Glass, no `@Entry`). (See §8.5.)
- **Distribution** → Personal-use under `~/.claude/skills/tokextract/` for v1. Marketplace promotion only after ≥2 fixtures pass. (See §8.2.)
- **`findings.raw.json` stability contract** → Internal artifact in v1. Path and purpose documented in README; no published JSON Schema, no stability guarantee. Promote to public contract only if v3 MCP server materializes.
- **Cross-module orphan detection** → Walk all `.swift` files under `--path` as a union (no SPM target awareness in v1). Every orphan finding is tagged with `crossModuleConfidence: low`. SPM target graph awareness lands in v2.

### 13.2 Resolved during reviewer pass (2026-05-08)

- **SKILL.md orchestration protocol** → Defined in §8.1 with concrete skeleton. Five-step pipeline: parse → run pending LLM tasks via Agent tool → emit → run narrate → finalize. Independent tasks run in parallel.
- **Subagent spawn mechanism** → Host Claude's `Agent` tool, one subagent per `LlmTask`. Subagent writes JSON output to `responsePath` directly using its Write tool; host doesn't proxy. (§9.0)
- **CandidateToken contract** → New §6.12 defines the LLM↔emitter handoff schema with `_provenance`, `_confidence`, `_llmDerived`, `_inferred` metadata stripped before final emit.
- **Diff module** → Added `analyzers/diff.ts` to §8.3 + a `[Node] DIFF` step (6b) to the pipeline. Snapshot stored at `.tokextract/previous/tokens.json`. Diff summary prepends `## Changes since last extraction` to audit.md.
- **deltaE threshold** → `2.5` canonical, `--delta-e-threshold` override. Audit example aligned.
- **`findings.raw.json` location** → Moved to `<output-dir>/.tokextract/findings.raw.json` for layout consistency. (§7.4)
- **Model IDs** → Defaults updated to current: Haiku 4.5 (`claude-haiku-4-5-20251001`), Sonnet 4.6 (`claude-sonnet-4-6`). Opus 4.7 (`claude-opus-4-7`) available as override. (§8.5)
- **Large repo policy** → Hard limit at 2000 `.swift` files via `--max-files`; abort with clear error above. v2 will add subagent-per-directory reconciliation. (§9.4, §12)
- **Font weight inference** → PostScript suffix mapping rules in §6.10. `lineHeight` defaults `1.5`, `letterSpacing` defaults `"0px"` when source-absent.
- **DESIGN.md lint rules** → Each of 8 rules defined inline in §7.2 with deterministic check spec.
- **Asset Catalog missing-file** → §6.1 emits `severity: "error"` finding with `assetMissing: true`; not promoted to tokens.json.
- **`--skip` × manifest** → Skipped categories produce no manifest entries; emitter treats as absent. (§8.5)

### 13.3 Remaining

_None at the time of this revision. New ambiguities encountered during implementation should be appended here with date and resolution._
