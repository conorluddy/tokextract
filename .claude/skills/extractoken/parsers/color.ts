/**
 * parsers/color.ts
 *
 * Reference implementation for Slice 1 color extraction.
 * Slice 2 parser-agents should read this file before writing their own parsers —
 * the structure, error handling, and RawFinding shape are the template.
 *
 * === WHAT THIS PARSER HANDLES ===
 *
 * 1. `extension Color` static lets — semantic token declarations
 *    - Color(.sRGB, red:green:blue:opacity:)
 *    - Color(red:green:blue:) / Color(red:green:blue:opacity:)
 *    - Color(hex: "...") — custom hex initializer pattern
 *    - Color("AssetName") — Asset Catalog string reference
 *    - Color(uiColor: UIColor.systemXxx) — UIKit semantic bridge
 *    - System alias constants (Color.primary, .accentColor, etc.)
 *
 * 2. `init(light:dark:)` adaptive color pattern
 *
 * 3. @Environment conditional color picks (light/dark inline)
 *
 * 4. Hex literal side-channel via regex (call-site drift candidates)
 *    Hex detection is done in analyzers/usage-scanner.ts; this parser handles
 *    only declaration-site extractions from the AST.
 *
 * === WHAT THIS PARSER DOES NOT HANDLE ===
 *
 * - Asset Catalog JSON parsing — that's parsers/asset-catalog.ts
 * - Hex literal call-sites — that's analyzers/usage-scanner.ts
 * - LLM normalization — that's llm/normalize.ts
 *
 * === NODE TYPE NOTES ===
 *
 * tree-sitter-swift parses `extension Foo { }` as `class_declaration`, NOT
 * `extension_declaration`. Extension names appear at:
 *   `(class_declaration name: (user_type (type_identifier)))`
 * Property declarations within the body:
 *   `(property_declaration name: (pattern (simple_identifier)) value: (call_expression ...))`
 *
 * Run `parseSource(src).rootNode.toString()` on any snippet to see the full
 * S-expression and verify node type names before writing a query.
 */

import path from "node:path";
import { getCapture, nodeColumn, nodeLineNumber, parseSource, runQuery } from "./swift-ast.js";
import type { Tree } from "./swift-ast.js";
import type { RawFinding } from "./types.js";

// === PUBLIC API ===

/**
 * Extract color findings from a single Swift source file.
 *
 * @param source   Raw Swift source text
 * @param filePath Absolute path to the source file — used for provenance in findings
 * @param tree     Optional pre-parsed tree-sitter Tree. When provided, avoids a redundant
 *                 parse call. Falls back to parsing `source` if omitted (backward-compat).
 * @returns        Array of RawFinding objects (may be empty)
 */
export function extractColors(source: string, filePath: string, tree?: Tree): RawFinding[] {
  const sharedTree = tree ?? parseSource(source);
  const relativePath = normalizeFilePath(filePath);
  const findings: RawFinding[] = [];

  // Pass 1: Static let declarations inside `extension Color { }` blocks
  const extensionFindings = extractExtensionColorDeclarations(sharedTree, source, relativePath);
  findings.push(...extensionFindings);

  // Pass 2: `init(light:dark:)` adaptive color static lets
  const adaptiveFindings = extractAdaptiveColorDeclarations(sharedTree, relativePath);
  findings.push(...adaptiveFindings);

  // Pass 3: Inline @Environment conditional color picks (call sites, not declarations)
  const envFindings = extractEnvironmentConditionalColors(source, sharedTree, relativePath);
  findings.push(...envFindings);

  // Pass 4: Color(.identifier) — iOS 17+ ColorResource shorthand for Asset Catalog colors
  // and system semantic colors. Modern Apple-recommended syntax; supersedes Color("Name").
  const resourceFindings = extractColorResourceCallSites(source, relativePath);
  findings.push(...resourceFindings);

  // Pass 5: Implicit ShapeStyle modifiers — .foregroundColor(.foo), .foregroundStyle(.foo),
  // .background(.foo), .tint(.foo), .fill(.foo), .stroke(.foo), .accentColor(.foo)
  // These are the dominant call-site pattern in SwiftUI: missed ~95% of Grapla's color usage.
  const shapeStyleFindings = extractImplicitShapeStyleColorRefs(source, relativePath);
  findings.push(...shapeStyleFindings);

  return findings;
}

// === PRIVATE HELPERS ===

/**
 * Extract static let color declarations from `extension Color { ... }` blocks.
 *
 * Uses the AST query for structured extraction. Falls back to regex on query error
 * so a grammar update doesn't silently drop all color findings.
 */
function extractExtensionColorDeclarations(
  tree: Tree,
  source: string,
  filePath: string,
): RawFinding[] {
  const findings: RawFinding[] = [];

  // Query: class_declaration named "Color" with property declarations
  // Note: tree-sitter-swift parses `extension` keyword as `class_declaration`
  const query = `
    (class_declaration
      name: (user_type (type_identifier) @ext_name)
      body: (class_body
        (property_declaration
          name: (pattern (simple_identifier) @decl_name)
          value: (call_expression) @call_expr)))
  `;

  let matches: ReturnType<typeof runQuery>;
  try {
    matches = runQuery(tree, query);
  } catch {
    // Query error — degrade gracefully, emit nothing for this pass
    return [];
  }

  for (const match of matches) {
    const extNameNode = getCapture(match, "ext_name");
    const declNameNode = getCapture(match, "decl_name");
    const callNode = getCapture(match, "call_expr");

    // Only process Color extension (not Font, View, etc.)
    if (!extNameNode || extNameNode.text !== "Color") continue;
    if (!declNameNode || !callNode) continue;

    const declName = declNameNode.text;
    const rawValue = callNode.text;
    const line = nodeLineNumber(declNameNode);
    const col = nodeColumn(declNameNode);

    // Classify the color initializer form
    const colorForm = classifyColorCall(rawValue);

    const finding: RawFinding = {
      category: "color",
      sourcePath: filePath,
      line,
      col,
      declName,
      rawValue,
      normalizedValue: colorForm.normalizedValue,
      context: "extension Color static let",
      isDeclaration: true,
      ...(colorForm.isSystemAlias !== undefined && { isSystemAlias: colorForm.isSystemAlias }),
      ...(colorForm.assetName !== undefined && { assetName: colorForm.assetName }),
      hasDarkVariant: false,
      ...(colorForm.severity !== undefined && { severity: colorForm.severity }),
      ...(colorForm.requiresSemanticResolution !== undefined && {
        requiresSemanticResolution: colorForm.requiresSemanticResolution,
      }),
    };

    findings.push(finding);
  }

  return findings;
}

/**
 * Extract `static let x = Color(light: ..., dark: ...)` adaptive color declarations.
 * These appear as static lets in a Color extension with the custom init(light:dark:).
 */
function extractAdaptiveColorDeclarations(tree: Tree, filePath: string): RawFinding[] {
  const findings: RawFinding[] = [];

  // Look for Color(light:dark:) call expressions in Color extension declarations
  const query = `
    (class_declaration
      name: (user_type (type_identifier) @ext_name)
      body: (class_body
        (property_declaration
          name: (pattern (simple_identifier) @decl_name)
          value: (call_expression
            (simple_identifier) @call_fn
            (call_suffix (value_arguments
              (value_argument name: (value_argument_label (simple_identifier) @arg1_label))
              (value_argument name: (value_argument_label (simple_identifier) @arg2_label))))
            @call_expr))))
  `;

  let matches: ReturnType<typeof runQuery>;
  try {
    matches = runQuery(tree, query);
  } catch {
    return [];
  }

  for (const match of matches) {
    const extNameNode = getCapture(match, "ext_name");
    const declNameNode = getCapture(match, "decl_name");
    const callFnNode = getCapture(match, "call_fn");
    const arg1LabelNode = getCapture(match, "arg1_label");
    const arg2LabelNode = getCapture(match, "arg2_label");
    const callExprNode = getCapture(match, "call_expr");

    if (!extNameNode || extNameNode.text !== "Color") continue;
    if (!declNameNode || !callFnNode || !callExprNode) continue;
    if (callFnNode.text !== "Color") continue;

    // Only match Color(light:dark:)
    const arg1 = arg1LabelNode?.text ?? "";
    const arg2 = arg2LabelNode?.text ?? "";
    if (arg1 !== "light" || arg2 !== "dark") continue;

    const finding: RawFinding = {
      category: "color",
      sourcePath: filePath,
      line: nodeLineNumber(declNameNode),
      col: nodeColumn(declNameNode),
      declName: declNameNode.text,
      rawValue: callExprNode.text,
      normalizedValue: null, // Needs LLM to resolve both variants
      context: "extension Color static let (adaptive light/dark)",
      isDeclaration: true,
      hasDarkVariant: true,
      severity: "info",
    };

    findings.push(finding);
  }

  return findings;
}

/**
 * Extract `@Environment(\.colorScheme)` conditional color picks.
 * These are call-site drift candidates, not token declarations.
 *
 * Pattern: `colorScheme == .dark ? Color.X : Color.Y`
 */
function extractEnvironmentConditionalColors(
  source: string,
  tree: ReturnType<typeof parseSource>,
  filePath: string,
): RawFinding[] {
  const findings: RawFinding[] = [];

  // Use regex for this pattern — the ternary AST is complex and not worth a
  // full query for Slice 1 (these are drift candidates, not token definitions).
  const envColorPattern =
    /let\s+(\w+)\s*=\s*colorScheme\s*==\s*\.dark\s*\?\s*(.+?)\s*:\s*(.+?)(?:\n|$)/g;
  const lines = source.split("\n");

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx] ?? "";
    const match = /let\s+(\w+)\s*=\s*colorScheme\s*==\s*\.dark\s*\?\s*(.+?)\s*:\s*(.+)/.exec(line);
    if (!match) continue;

    const [, varName, darkExpr, lightExpr] = match;
    if (!varName || !darkExpr || !lightExpr) continue;

    findings.push({
      category: "color",
      sourcePath: filePath,
      line: lineIdx + 1,
      col: line.indexOf("let"),
      declName: varName,
      rawValue: `colorScheme == .dark ? ${darkExpr.trim()} : ${lightExpr.trim()}`,
      normalizedValue: null,
      context: "@Environment colorScheme conditional",
      isDeclaration: false,
      hasDarkVariant: true,
      severity: "info",
    });
  }

  // Suppress linter warning — `tree` and `envColorPattern` used above
  void tree;
  void envColorPattern;

  return findings;
}

/**
 * Extract `Color(.identifier)` call-site references — the iOS 17+ ColorResource
 * shorthand. The identifier resolves to either an Asset Catalog colorset (user-defined)
 * or a system semantic color (e.g. .label, .systemBackground, .tint).
 *
 * extract.ts Stage 2b post-processes these findings: if `assetName` matches a
 * loaded colorset key, the finding is enriched with `normalizedValue`/`hasDarkVariant`;
 * if it matches a known system semantic name, `isSystemAlias` is set.
 *
 * Examples matched:
 *   Color(.graplaAccentPrimary)   → assetName: "graplaAccentPrimary"
 *   Color(.label)                 → assetName: "label"   (extract.ts will mark isSystemAlias)
 */
function extractColorResourceCallSites(source: string, filePath: string): RawFinding[] {
  const findings: RawFinding[] = [];
  const pattern = /\bColor\(\s*\.([A-Za-z_][A-Za-z0-9_]*)\s*\)/g;
  const matches = [...source.matchAll(pattern)];
  const lines = source.split("\n");

  for (const match of matches) {
    const identifier = match[1];
    const fullText = match[0];
    if (!identifier || match.index === undefined) continue;

    // Compute line/col from the byte offset
    let runningOffset = 0;
    let lineIdx = 0;
    for (; lineIdx < lines.length; lineIdx++) {
      const lineLen = (lines[lineIdx]?.length ?? 0) + 1; // +1 for newline
      if (runningOffset + lineLen > match.index) break;
      runningOffset += lineLen;
    }
    const col = match.index - runningOffset;

    findings.push({
      category: "color",
      sourcePath: filePath,
      line: lineIdx + 1,
      col,
      declName: null,
      rawValue: fullText,
      normalizedValue: null,
      context: "Color(.foo) call site (ColorResource)",
      isDeclaration: false,
      assetName: identifier,
      hasDarkVariant: false,
      severity: "info",
    });
  }

  return findings;
}

/**
 * Extract implicit ShapeStyle modifier color references — the dominant SwiftUI call-site
 * pattern that was missing from the Slice 1 parser.
 *
 * Matches single-identifier dot-shorthand only:
 *   .foregroundColor(.foo)    ✓
 *   .foregroundStyle(.foo)    ✓
 *   .background(.foo)         ✓
 *   .tint(.foo)               ✓
 *   .fill(.foo)               ✓
 *   .stroke(.foo)             ✓
 *   .accentColor(.foo)        ✓
 *   .foregroundStyle(.linearGradient(...))  ✗  (multi-argument — excluded by regex)
 *
 * The regex requires `)` immediately after the identifier, preventing false positives
 * from multi-argument calls like `.linearGradient(colors: [...])`.
 */
function extractImplicitShapeStyleColorRefs(source: string, filePath: string): RawFinding[] {
  const findings: RawFinding[] = [];

  // Modifiers that accept a ShapeStyle / Color as their first (and for our purposes, sole) arg.
  const MODIFIER_NAMES = [
    "foregroundColor",
    "foregroundStyle",
    "background",
    "tint",
    "fill",
    "stroke",
    "accentColor",
  ].join("|");

  // Matches .modifier(.identifier) — identifier must be followed by `)` with no other content.
  // This excludes multi-argument forms like .foregroundStyle(.linearGradient(colors:[.red,.blue]))
  // because the inner call would contain `(` before the closing `)`.
  const pattern = new RegExp(`\\.(${MODIFIER_NAMES})\\(\\.([A-Za-z_][A-Za-z0-9_]*)\\)`, "g");

  const matches = [...source.matchAll(pattern)];
  const lines = source.split("\n");

  for (const match of matches) {
    const modifier = match[1];
    const identifier = match[2];
    const fullText = match[0];
    if (!modifier || !identifier || match.index === undefined) continue;

    // Compute line/col from byte offset (same strategy as extractColorResourceCallSites)
    let runningOffset = 0;
    let lineIdx = 0;
    for (; lineIdx < lines.length; lineIdx++) {
      const lineLen = (lines[lineIdx]?.length ?? 0) + 1; // +1 for newline
      if (runningOffset + lineLen > match.index) break;
      runningOffset += lineLen;
    }
    const col = match.index - runningOffset;

    findings.push({
      category: "color",
      sourcePath: filePath,
      line: lineIdx + 1,
      col,
      declName: null,
      rawValue: fullText,
      normalizedValue: null,
      context: `.${modifier}(.${identifier}) implicit ShapeStyle`,
      isDeclaration: false,
      assetName: identifier,
      hasDarkVariant: false,
      severity: "info",
    });
  }

  return findings;
}

// === COLOR CALL CLASSIFIER ===

interface ColorCallClassification {
  readonly normalizedValue: import("./types.js").NormalizedColor | null;
  readonly isSystemAlias: boolean;
  readonly assetName: string | undefined;
  readonly severity: "info" | "warning" | "error" | undefined;
  readonly requiresSemanticResolution: boolean | undefined;
}

/**
 * Classify a Color initializer call and extract a normalized value where possible.
 *
 * Returns `normalizedValue: null` for forms that require LLM resolution
 * (e.g. `Color(uiColor:)`, `Color(hex:)` with non-standard formats, complex expressions).
 */
function classifyColorCall(rawValue: string): ColorCallClassification {
  // System alias constants — preserve as-is, never concretize
  if (isSystemAliasCall(rawValue)) {
    return {
      normalizedValue: null,
      isSystemAlias: true,
      assetName: undefined,
      severity: "info",
      requiresSemanticResolution: false,
    };
  }

  // Color("AssetName") — Asset Catalog reference
  const assetMatch = /^Color\(\s*"([^"]+)"\s*\)$/.exec(rawValue);
  if (assetMatch?.[1]) {
    return {
      normalizedValue: null, // Resolved by asset-catalog.ts
      isSystemAlias: false,
      assetName: assetMatch[1],
      severity: "info",
      requiresSemanticResolution: false,
    };
  }

  // Color(.sRGB, red: R, green: G, blue: B, opacity: A)
  const srgbMatch =
    /^Color\(\s*\.sRGB\s*,\s*red:\s*([\d.]+)\s*,\s*green:\s*([\d.]+)\s*,\s*blue:\s*([\d.]+)(?:\s*,\s*opacity:\s*([\d.]+))?\s*\)$/.exec(
      rawValue,
    );
  if (srgbMatch) {
    return {
      normalizedValue: {
        r: Number.parseFloat(srgbMatch[1] ?? "0"),
        g: Number.parseFloat(srgbMatch[2] ?? "0"),
        b: Number.parseFloat(srgbMatch[3] ?? "0"),
        a: srgbMatch[4] !== undefined ? Number.parseFloat(srgbMatch[4]) : 1.0,
        colorSpace: "srgb",
      },
      isSystemAlias: false,
      assetName: undefined,
      severity: "info",
      requiresSemanticResolution: false,
    };
  }

  // Color(red: R, green: G, blue: B) / Color(red: R, green: G, blue: B, opacity: A)
  const rgbMatch =
    /^Color\(\s*red:\s*([\d.]+)\s*,\s*green:\s*([\d.]+)\s*,\s*blue:\s*([\d.]+)(?:\s*,\s*opacity:\s*([\d.]+))?\s*\)$/.exec(
      rawValue,
    );
  if (rgbMatch) {
    return {
      normalizedValue: {
        r: Number.parseFloat(rgbMatch[1] ?? "0"),
        g: Number.parseFloat(rgbMatch[2] ?? "0"),
        b: Number.parseFloat(rgbMatch[3] ?? "0"),
        a: rgbMatch[4] !== undefined ? Number.parseFloat(rgbMatch[4]) : 1.0,
        colorSpace: "srgb",
      },
      isSystemAlias: false,
      assetName: undefined,
      severity: "info",
      requiresSemanticResolution: false,
    };
  }

  // Color(hex: "#RRGGBB") or Color(hex: "#RRGGBBAA")
  const hexMatch = /^Color\(\s*hex:\s*"#([0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})"\s*\)$/.exec(rawValue);
  if (hexMatch?.[1]) {
    const normalized = parseHexColor(hexMatch[1]);
    if (normalized) {
      return {
        normalizedValue: normalized,
        isSystemAlias: false,
        assetName: undefined,
        severity: "info",
        requiresSemanticResolution: false,
      };
    }
  }

  // Color(uiColor: UIColor.xxx) — needs semantic resolution
  if (/^Color\(\s*uiColor:/.test(rawValue)) {
    return {
      normalizedValue: null,
      isSystemAlias: false,
      assetName: undefined,
      severity: "info",
      requiresSemanticResolution: true,
    };
  }

  // Unknown form — let LLM handle it
  return {
    normalizedValue: null,
    isSystemAlias: false,
    assetName: undefined,
    severity: "info",
    requiresSemanticResolution: false,
  };
}

/**
 * System alias color constants that should never be concretized.
 * Note: Color(uiColor: UIColor.systemXxx) is NOT here — those are handled
 * separately with requiresSemanticResolution: true. These are bare name aliases only.
 */
const SYSTEM_ALIAS_PATTERNS = [
  /^Color\.accentColor$/,
  /^Color\.primary$/,
  /^Color\.secondary$/,
  /^Color\.red$/,
  /^Color\.blue$/,
  /^Color\.green$/,
  /^Color\.orange$/,
  /^Color\.yellow$/,
  /^Color\.pink$/,
  /^Color\.purple$/,
  /^Color\.gray$/,
  /^Color\.white$/,
  /^Color\.black$/,
  /^Color\.clear$/,
  /^\.accentColor$/,
  /^\.primary$/,
  /^\.secondary$/,
];

function isSystemAliasCall(rawValue: string): boolean {
  return SYSTEM_ALIAS_PATTERNS.some((pattern) => pattern.test(rawValue));
}

/**
 * Parse a 6-digit or 8-digit hex string into a NormalizedColor.
 * Returns null if the hex string is malformed.
 */
function parseHexColor(hex: string): import("./types.js").NormalizedColor | null {
  if (hex.length === 6) {
    const r = Number.parseInt(hex.slice(0, 2), 16);
    const g = Number.parseInt(hex.slice(2, 4), 16);
    const b = Number.parseInt(hex.slice(4, 6), 16);
    if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null;
    return { r: r / 255, g: g / 255, b: b / 255, a: 1.0, colorSpace: "srgb" };
  }
  if (hex.length === 8) {
    const r = Number.parseInt(hex.slice(0, 2), 16);
    const g = Number.parseInt(hex.slice(2, 4), 16);
    const b = Number.parseInt(hex.slice(4, 6), 16);
    const a = Number.parseInt(hex.slice(6, 8), 16);
    if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b) || Number.isNaN(a)) return null;
    return { r: r / 255, g: g / 255, b: b / 255, a: a / 255, colorSpace: "srgb" };
  }
  return null;
}

/**
 * Normalize a file path for storage in findings.
 * We store relative paths from the repo root where possible to keep findings
 * portable. If the path has no common prefix, store the absolute path.
 */
function normalizeFilePath(filePath: string): string {
  // Return as-is for now; the CLI normalizes relative to --path at extraction time
  return path.normalize(filePath);
}

// Re-export hex parser for use in usage-scanner.ts
export { parseHexColor };
