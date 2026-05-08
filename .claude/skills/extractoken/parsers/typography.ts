/**
 * parsers/typography.ts
 *
 * Typography extraction for Slice 2. Reads all SwiftUI font usage patterns and
 * emits RawFinding[] with normalizedValue pre-populated where deterministic.
 *
 * === WHAT THIS PARSER HANDLES ===
 *
 * 1. `Font.custom("Name", size: N, relativeTo: .style)` — Dynamic Type aware call
 * 2. `Font.custom("Name", size: N)` — without Dynamic Type (hasDynamicType: false)
 * 3. `extension Font { static let bodyMd = Font.custom(...) }` — declaration form
 * 4. `extension Text { func textStyleX() -> some View { self.font(...) } }` — text style modifier
 * 5. Custom font enums: `enum JetBrainsMono: String { case regular = "..." }` — case → string
 * 6. `.font(.bodyMd)` shorthand call sites referencing extension Font statics
 * 7. `Font.system(size: N, weight: .medium, design: .rounded)` — system font usage
 *
 * === INFERENCE RULES (PRD §6.10) ===
 *
 * - fontWeight inferred from PostScript name suffix (Thin=100 … Black=900)
 * - lineHeight defaults to 1.5 when .lineSpacing() absent
 * - letterSpacing defaults to "0px" when .tracking()/.kerning() absent
 *
 * === NODE TYPE NOTES ===
 *
 * tree-sitter-swift parses `extension Foo { }` as `class_declaration`, NOT
 * `extension_declaration`. Extension type name appears at:
 *   `(class_declaration name: (user_type (type_identifier)))`
 */

import path from "node:path";
import { getCapture, nodeColumn, nodeLineNumber, parseSource, runQuery } from "./swift-ast.js";
import type { Tree } from "./swift-ast.js";
import type { RawFinding } from "./types.js";

// === PUBLIC API ===

/**
 * Extract typography findings from a single Swift source file.
 *
 * @param source   Raw Swift source text
 * @param filePath Absolute path to the source file — used for provenance in findings
 * @param tree     Optional pre-parsed tree-sitter Tree. When provided, avoids a redundant
 *                 parse call. Falls back to parsing `source` if omitted (backward-compat).
 * @returns        Array of RawFinding objects (may be empty)
 */
export function extractTypography(source: string, filePath: string, tree?: Tree): RawFinding[] {
  const sharedTree = tree ?? parseSource(source);
  const relativePath = normalizeFilePath(filePath);
  const findings: RawFinding[] = [];

  // Pass 1: Static let declarations inside `extension Font { }` blocks
  findings.push(...extractFontExtensionDeclarations(sharedTree, source, relativePath));

  // Pass 2: `extension Text { func textStyleX() }` — text style modifier extensions
  findings.push(...extractTextStyleExtensions(sharedTree, source, relativePath));

  // Pass 3: Custom font enums — `enum JetBrainsMono: String { case regular = "..." }`
  findings.push(...extractFontEnumCases(source, relativePath));

  // Pass 4: Font.system(size:weight:design:) — system font call sites
  findings.push(...extractSystemFontCallSites(source, relativePath));

  // Pass 5: `.font(.identifier)` shorthand call sites (analogous to color's pass 5)
  findings.push(...extractImplicitFontCallSites(source, relativePath));

  // Pass 6: `enum X { static let *Name = "FontName" }` — abstraction-layer font name registry.
  // Common in multi-target apps that wrap Font.custom in helper APIs (e.g. Ocras's WidgetFont).
  findings.push(...extractFontEnumStaticLets(source, relativePath));

  return findings;
}

// === PRIVATE PASSES ===

/**
 * Extract static let declarations from `extension Font { ... }` blocks.
 * Captures Font.custom(...) with and without `relativeTo:`.
 *
 * Note: tree-sitter-swift parses `extension` as `class_declaration`.
 */
function extractFontExtensionDeclarations(
  tree: Tree,
  source: string,
  filePath: string,
): RawFinding[] {
  const findings: RawFinding[] = [];

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
    return [];
  }

  for (const match of matches) {
    const extNameNode = getCapture(match, "ext_name");
    const declNameNode = getCapture(match, "decl_name");
    const callNode = getCapture(match, "call_expr");

    if (!extNameNode || extNameNode.text !== "Font") continue;
    if (!declNameNode || !callNode) continue;

    const rawValue = callNode.text;

    // Only handle Font.custom(...) and Font.system(...) in declarations
    if (!rawValue.startsWith("Font.custom(") && !rawValue.startsWith("Font.system(")) continue;

    const hasDynamicType = /\brelativeTo\s*:/.test(rawValue);
    const normalized = normalizeCustomFontCall(rawValue);

    findings.push({
      category: "typography",
      sourcePath: filePath,
      line: nodeLineNumber(declNameNode),
      col: nodeColumn(declNameNode),
      declName: declNameNode.text,
      rawValue,
      normalizedValue: normalized,
      context: "extension Font static let",
      isDeclaration: true,
      hasDynamicType,
    });
  }

  return findings;
}

/**
 * Extract `extension Text { func textStyleX() -> some View { self.font(...) } }` patterns.
 * Emits one finding per function declaration, with rawValue = the Font.custom call inside.
 *
 * Note: tree-sitter-swift parses `extension` as `class_declaration`.
 */
function extractTextStyleExtensions(tree: Tree, source: string, filePath: string): RawFinding[] {
  const findings: RawFinding[] = [];

  // Match function declarations inside extension Text
  const query = `
    (class_declaration
      name: (user_type (type_identifier) @ext_name)
      body: (class_body
        (function_declaration
          name: (simple_identifier) @func_name)))
  `;

  let matches: ReturnType<typeof runQuery>;
  try {
    matches = runQuery(tree, query);
  } catch {
    return [];
  }

  for (const match of matches) {
    const extNameNode = getCapture(match, "ext_name");
    const funcNameNode = getCapture(match, "func_name");

    if (!extNameNode || extNameNode.text !== "Text") continue;
    if (!funcNameNode) continue;

    // Extract the Font.custom call from inside the function body via regex
    // We look for Font.custom (or .font(Font.custom...)) in the surrounding lines
    const funcName = funcNameNode.text;
    const funcLine = nodeLineNumber(funcNameNode);

    // Scan up to 10 lines after the function declaration for the font call
    const lines = source.split("\n");
    const startIdx = funcLine - 1; // 0-based
    let rawValue = "";
    let hasDynamicType = false;

    for (let i = startIdx; i < Math.min(startIdx + 10, lines.length); i++) {
      const fontMatch = /Font\.custom\([^)]*(?:\([^)]*\))?[^)]*\)/.exec(lines[i] ?? "");
      if (fontMatch) {
        rawValue = fontMatch[0];
        hasDynamicType = /\brelativeTo\s*:/.test(rawValue);
        break;
      }
    }

    const normalized = rawValue ? normalizeCustomFontCall(rawValue) : null;

    findings.push({
      category: "typography",
      sourcePath: filePath,
      line: funcLine,
      col: nodeColumn(funcNameNode),
      declName: funcName,
      rawValue: rawValue || `${funcName}() [text style modifier]`,
      normalizedValue: normalized,
      context: "extension Text style modifier",
      isDeclaration: true,
      hasDynamicType,
    });
  }

  return findings;
}

/**
 * Extract custom font enum case → string mappings.
 *
 * Pattern:
 *   enum JetBrainsMono: String {
 *     case regular = "JetBrainsMono-Regular"
 *     case bold    = "JetBrainsMono-Bold"
 *   }
 *
 * Uses regex for simplicity — enum_declaration parsing with tree-sitter requires
 * navigating many node variants; the regex is unambiguous for this narrow pattern.
 */
function extractFontEnumCases(source: string, filePath: string): RawFinding[] {
  const findings: RawFinding[] = [];
  const lines = source.split("\n");

  // Find `enum Xxx: String {` blocks and collect their case declarations
  let inFontEnum = false;
  let enumName = "";
  let braceDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";

    // Detect start of a String-backed enum that looks like a font enum
    const enumStart = /^\s*enum\s+(\w+)\s*:\s*String\b/.exec(line);
    if (enumStart && !inFontEnum) {
      // Heuristic: peek ahead to see if any case values look like PostScript font names
      // (contain a hyphen between word-parts, e.g. "JetBrainsMono-Regular")
      const lookaheadBlock = lines.slice(i, i + 20).join("\n");
      if (/case\s+\w+\s*=\s*"[A-Za-z]+-[A-Za-z]/.test(lookaheadBlock)) {
        inFontEnum = true;
        enumName = enumStart[1] ?? "";
        braceDepth = 0;
      }
    }

    if (inFontEnum) {
      braceDepth += (line.match(/{/g) ?? []).length;
      braceDepth -= (line.match(/}/g) ?? []).length;

      const caseMatch = /^\s*case\s+(\w+)\s*=\s*"([^"]+)"/.exec(line);
      if (caseMatch) {
        const caseName = caseMatch[1] ?? "";
        const fontPostScriptName = caseMatch[2] ?? "";
        const fontWeight = inferFontWeight(fontPostScriptName);

        findings.push({
          category: "typography",
          sourcePath: filePath,
          line: i + 1,
          col: line.indexOf("case"),
          declName: `${enumName}.${caseName}`,
          rawValue: `case ${caseName} = "${fontPostScriptName}"`,
          normalizedValue: {
            fontFamily: fontPostScriptName,
            fontSize: 0, // Unknown at enum-case level; resolved by call sites
            fontWeight,
            lineHeight: DEFAULT_LINE_HEIGHT,
            letterSpacing: DEFAULT_LETTER_SPACING,
          },
          context: `font enum ${enumName}`,
          isDeclaration: true,
          hasDynamicType: false,
        });
      }

      if (braceDepth <= 0 && line.includes("}")) {
        inFontEnum = false;
        enumName = "";
      }
    }
  }

  return findings;
}

/**
 * Extract `enum X { static let *Name = "FontPostScriptName" }` patterns.
 *
 * Used by abstraction-layer typography systems that don't expose `Font.custom`
 * directly to consumers. Example (from Ocras's FastingKit):
 *
 *   public enum WidgetFont {
 *     public static let heroDisplayName = "SpaceGrotesk-Bold"
 *     public static let bodyName        = "SpaceGrotesk-Medium"
 *   }
 *
 * Heuristic: only trigger inside enums whose body contains at least one static let
 * whose string value matches a PostScript-style font name (Word-Suffix pattern).
 * Avoids false positives on unrelated string-typed static lets.
 */
function extractFontEnumStaticLets(source: string, filePath: string): RawFinding[] {
  const findings: RawFinding[] = [];
  const lines = source.split("\n");

  let inFontEnum = false;
  let enumName = "";
  let braceDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";

    if (!inFontEnum) {
      // Match `enum X {` or `public enum X {` (no String inheritance — those are Pass 3)
      const enumStart = /^\s*(?:public\s+|internal\s+|fileprivate\s+|private\s+)?enum\s+(\w+)\s*(?:\{|$)/.exec(
        line,
      );
      if (enumStart && !line.includes(":")) {
        // Lookahead: any static let inside whose value has PostScript-name shape (Word-Suffix)?
        const lookaheadBlock = lines.slice(i, i + 30).join("\n");
        if (/static\s+let\s+\w+\s*=\s*"[A-Za-z]+-[A-Za-z]/.test(lookaheadBlock)) {
          inFontEnum = true;
          enumName = enumStart[1] ?? "";
          braceDepth = (line.match(/{/g) ?? []).length;
        }
      }
      continue;
    }

    braceDepth += (line.match(/{/g) ?? []).length;
    braceDepth -= (line.match(/}/g) ?? []).length;

    const letMatch =
      /^\s*(?:public\s+|internal\s+|fileprivate\s+|private\s+)?static\s+let\s+(\w+)\s*(?::\s*String\s*)?=\s*"([^"]+)"/.exec(
        line,
      );
    if (letMatch) {
      const letName = letMatch[1] ?? "";
      const fontPostScriptName = letMatch[2] ?? "";
      // Only emit if the value really looks like a font name (Word-Suffix)
      if (/^[A-Za-z]+-[A-Za-z]/.test(fontPostScriptName)) {
        const fontWeight = inferFontWeight(fontPostScriptName);
        findings.push({
          category: "typography",
          sourcePath: filePath,
          line: i + 1,
          col: line.indexOf("static"),
          declName: `${enumName}.${letName}`,
          rawValue: `static let ${letName} = "${fontPostScriptName}"`,
          normalizedValue: {
            fontFamily: fontPostScriptName,
            fontSize: null,
            fontWeight,
            lineHeight: 1.5,
            letterSpacing: "0px",
          },
          context: `font enum ${enumName} (static let)`,
          isDeclaration: true,
          hasDynamicType: false,
        });
      }
    }

    if (braceDepth <= 0) {
      inFontEnum = false;
      enumName = "";
    }
  }

  return findings;
}

/**
 * Extract `Font.system(size: N, weight: .xxx, design: .xxx)` call sites.
 * Detected via regex — these appear both as declarations and bare call sites.
 */
function extractSystemFontCallSites(source: string, filePath: string): RawFinding[] {
  const findings: RawFinding[] = [];
  const lines = source.split("\n");

  // Match Font.system(size: N, ...) — may span a single line
  const pattern = /Font\.system\s*\(([^)]*)\)/g;
  const matches = [...source.matchAll(pattern)];

  for (const match of matches) {
    if (match.index === undefined) continue;

    const fullText = match[0];
    const argsText = match[1] ?? "";

    const sizeMatch = /size\s*:\s*([\d.]+)/.exec(argsText);
    const weightMatch = /weight\s*:\s*\.([A-Za-z]+)/.exec(argsText);
    const designMatch = /design\s*:\s*\.([A-Za-z]+)/.exec(argsText);

    const fontSize = sizeMatch ? Number.parseFloat(sizeMatch[1] ?? "0") : 0;
    const weightName = weightMatch?.[1] ?? "";
    const design = designMatch?.[1] ?? "";

    const fontWeight = swiftWeightToNumeric(weightName);

    const { lineIdx, col } = offsetToLineCol(source, lines, match.index);

    findings.push({
      category: "typography",
      sourcePath: filePath,
      line: lineIdx + 1,
      col,
      declName: null,
      rawValue: fullText,
      normalizedValue: {
        fontFamily: `system${design ? `-${design}` : ""}`,
        fontSize,
        fontWeight,
        lineHeight: DEFAULT_LINE_HEIGHT,
        letterSpacing: DEFAULT_LETTER_SPACING,
      },
      context: "Font.system call site",
      isDeclaration: false,
      hasDynamicType: false,
    });
  }

  return findings;
}

/**
 * Extract `.font(.identifier)` shorthand call sites — analogous to color's pass 5.
 * These reference extension Font static let declarations by dot-shorthand.
 *
 * Matches: .font(.bodyMd), .font(.labelSm) — single identifier only.
 * Excludes: .font(.system(...)), .font(.custom(...)), .font(.headline) (system styles)
 *   by requiring the identifier to be followed immediately by `)` with no `(` inside.
 */
function extractImplicitFontCallSites(source: string, filePath: string): RawFinding[] {
  const findings: RawFinding[] = [];

  // .font(.<identifier>) — identifier must be followed by `)` with no nested parens
  const pattern = /\.font\(\.([A-Za-z_][A-Za-z0-9_]*)\)/g;
  const matches = [...source.matchAll(pattern)];
  const lines = source.split("\n");

  // System Dynamic Type text styles to exclude (not custom tokens)
  const SYSTEM_TEXT_STYLES = new Set([
    "largeTitle",
    "title",
    "title2",
    "title3",
    "headline",
    "subheadline",
    "body",
    "callout",
    "footnote",
    "caption",
    "caption2",
    "extraLargeTitle",
    "extraLargeTitle2",
  ]);

  for (const match of matches) {
    const identifier = match[1];
    const fullText = match[0];
    if (!identifier || match.index === undefined) continue;

    // Skip system text styles — they're not custom token references
    if (SYSTEM_TEXT_STYLES.has(identifier)) continue;

    const { lineIdx, col } = offsetToLineCol(source, lines, match.index);

    findings.push({
      category: "typography",
      sourcePath: filePath,
      line: lineIdx + 1,
      col,
      declName: null,
      rawValue: fullText,
      normalizedValue: null, // Resolved by joining with extension Font declaration findings
      context: `.font(.${identifier}) implicit reference`,
      isDeclaration: false,
      hasDynamicType: false,
    });
  }

  return findings;
}

// === INFERENCE HELPERS ===

const DEFAULT_LINE_HEIGHT = 1.5;
const DEFAULT_LETTER_SPACING = "0px";

/**
 * Map a PostScript font name suffix to a numeric font weight (100–900).
 * Falls back to 400 for unrecognised suffixes.
 *
 * PRD §6.10 reference:
 *   -Thin → 100, -ExtraLight/-UltraLight → 200, -Light → 300,
 *   -Regular/-Book → 400, -Medium → 500, -SemiBold/-DemiBold → 600,
 *   -Bold → 700, -ExtraBold/-Heavy → 800, -Black → 900
 */
export function inferFontWeight(postScriptName: string): number {
  if (/-Black$/i.test(postScriptName)) return 900;
  if (/-ExtraBold$/i.test(postScriptName) || /-Heavy$/i.test(postScriptName)) return 800;
  if (/-Bold$/i.test(postScriptName)) return 700;
  if (/-SemiBold$/i.test(postScriptName) || /-DemiBold$/i.test(postScriptName)) return 600;
  if (/-Medium$/i.test(postScriptName)) return 500;
  if (/-Regular$/i.test(postScriptName) || /-Book$/i.test(postScriptName)) return 400;
  if (/-Light$/i.test(postScriptName)) return 300;
  if (/-ExtraLight$/i.test(postScriptName) || /-UltraLight$/i.test(postScriptName)) return 200;
  if (/-Thin$/i.test(postScriptName)) return 100;
  return 400; // fallback
}

/**
 * Map a SwiftUI Font.Weight member name to a numeric font weight.
 * Used for Font.system(weight: .xxx) extraction.
 */
function swiftWeightToNumeric(weightName: string): number {
  const map: Record<string, number> = {
    ultraLight: 100,
    thin: 100,
    light: 300,
    regular: 400,
    medium: 500,
    semibold: 600,
    bold: 700,
    heavy: 800,
    black: 900,
  };
  return map[weightName.toLowerCase()] ?? 400;
}

// === FONT CALL NORMALIZER ===

/**
 * Normalized typography value shape — populated for Font.custom and Font.system calls
 * where the font name, size, and weight are all statically determinable.
 */
interface NormalizedTypography {
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly fontWeight: number;
  readonly lineHeight: number;
  readonly letterSpacing: string;
  readonly textStyle?: string;
}

/**
 * Parse a `Font.custom(...)` call expression into a NormalizedTypography object.
 *
 * Handles:
 *   Font.custom("Name", size: 16)
 *   Font.custom("Name", size: 16, relativeTo: .body)
 *
 * Returns null for forms that cannot be statically resolved.
 */
function normalizeCustomFontCall(rawValue: string): NormalizedTypography | null {
  // Font.custom("PostScriptName", size: N) — with optional relativeTo
  const customMatch =
    /Font\.custom\(\s*"([^"]+)"\s*,\s*size\s*:\s*([\d.]+)(?:\s*,\s*relativeTo\s*:\s*\.([A-Za-z0-9]+))?\s*\)/.exec(
      rawValue,
    );

  if (customMatch) {
    const fontFamily = customMatch[1] ?? "";
    const fontSize = Number.parseFloat(customMatch[2] ?? "0");
    const textStyle = customMatch[3]; // undefined if no relativeTo

    return {
      fontFamily,
      fontSize,
      fontWeight: inferFontWeight(fontFamily),
      lineHeight: DEFAULT_LINE_HEIGHT,
      letterSpacing: DEFAULT_LETTER_SPACING,
      ...(textStyle !== undefined && { textStyle }),
    };
  }

  return null;
}

// === UTILITY ===

/**
 * Convert a byte offset into (lineIdx, col), reusing the pre-split lines array.
 * lineIdx is 0-based; col is 0-based.
 */
function offsetToLineCol(
  _source: string,
  lines: string[],
  offset: number,
): { lineIdx: number; col: number } {
  let runningOffset = 0;
  for (let i = 0; i < lines.length; i++) {
    const lineLen = (lines[i]?.length ?? 0) + 1; // +1 for newline
    if (runningOffset + lineLen > offset) {
      return { lineIdx: i, col: offset - runningOffset };
    }
    runningOffset += lineLen;
  }
  return { lineIdx: lines.length - 1, col: 0 };
}

/**
 * Normalize a file path for storage in findings.
 * Stored as-is; CLI normalizes relative to --path at extraction time.
 */
function normalizeFilePath(filePath: string): string {
  return path.normalize(filePath);
}
