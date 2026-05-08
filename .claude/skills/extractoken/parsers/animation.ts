/**
 * parsers/animation.ts
 *
 * Animation token extractor for Extractoken.
 *
 * === WHAT THIS PARSER HANDLES ===
 *
 * 1. `.animation(.easeInOut(duration: 0.3), value: isVisible)` — view modifier, named curve + duration
 * 2. `.animation(.spring(response: 0.5, dampingFraction: 0.75), value: offset)` — spring with params
 * 3. `.animation(.easeIn)`, `.animation(.easeOut)`, `.animation(.linear)`, `.animation(.default)` — bare curves
 * 4. `withAnimation(.easeOut(duration: 0.2)) { ... }` — global function form
 * 5. `extension Animation { static let standard = Animation.spring(...) }` — declaration form
 * 6. `.animation(.standard, value: x)` — named-ref call sites (dot-shorthand to declared constant)
 *
 * === WHAT THIS PARSER DOES NOT HANDLE ===
 *
 * - LLM normalization — that's llm/normalize.ts
 * - DTCG emission — that's emitters/tokens-json.ts
 *
 * === NODE TYPE NOTES ===
 *
 * tree-sitter-swift parses `extension Animation { }` as `class_declaration`, NOT
 * `extension_declaration`. Extension names appear at:
 *   `(class_declaration name: (user_type (type_identifier)))`
 * Property declarations within the body:
 *   `(property_declaration name: (pattern (simple_identifier)) value: (call_expression ...))`
 */

import path from "node:path";
import { getCapture, nodeColumn, nodeLineNumber, parseSource, runQuery } from "./swift-ast.js";
import type { Tree } from "./swift-ast.js";
import type { RawFinding } from "./types.js";

// === PUBLIC API ===

/**
 * Extract animation findings from a single Swift source file.
 *
 * @param source   Raw Swift source text
 * @param filePath Absolute path to the source file — used for provenance in findings
 * @param tree     Optional pre-parsed tree-sitter Tree. When provided, avoids a redundant
 *                 parse call. Falls back to parsing `source` if omitted (backward-compat).
 * @returns        Array of RawFinding objects (may be empty)
 */
export function extractAnimation(source: string, filePath: string, tree?: Tree): RawFinding[] {
  const sharedTree = tree ?? parseSource(source);
  const relativePath = path.normalize(filePath);
  const findings: RawFinding[] = [];

  // Pass 1: static let declarations inside `extension Animation { }` blocks
  findings.push(...extractAnimationExtensionDeclarations(sharedTree, relativePath));

  // Pass 2: `.animation(...)` view modifier call sites
  findings.push(...extractAnimationModifierCallSites(source, relativePath));

  // Pass 3: `withAnimation(...)` global function call sites
  findings.push(...extractWithAnimationCallSites(source, relativePath));

  return findings;
}

// === NORMALIZED VALUE TYPE ===

/** Normalized animation value — flexible record for DTCG motion module (draft) */
interface NormalizedAnimation {
  readonly type:
    | "easeIn"
    | "easeOut"
    | "easeInOut"
    | "linear"
    | "spring"
    | "default"
    | "interpolatingSpring"
    | "timingCurve"
    | "named-ref";
  readonly duration?: number;
  readonly response?: number;
  readonly dampingFraction?: number;
  readonly blendDuration?: number;
  readonly namedRef?: string;
}

// === PRIVATE HELPERS ===

/**
 * Extract `static let x = Animation.spring(...)` declarations from `extension Animation { }` blocks.
 *
 * Uses AST query for structured extraction. Falls back gracefully on query error.
 * Each `static let` is emitted as a separate declaration finding.
 */
function extractAnimationExtensionDeclarations(tree: Tree, filePath: string): RawFinding[] {
  const findings: RawFinding[] = [];

  // Query: class_declaration named "Animation" with property declarations
  // Note: tree-sitter-swift parses `extension` keyword as `class_declaration`
  const query = `
    (class_declaration
      name: (user_type (type_identifier) @ext_name)
      body: (class_body
        (property_declaration
          name: (pattern (simple_identifier) @decl_name)
          value: (_) @value_expr)))
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
    const valueNode = getCapture(match, "value_expr");

    if (!extNameNode || extNameNode.text !== "Animation") continue;
    if (!declNameNode || !valueNode) continue;

    const declName = declNameNode.text;
    const rawValue = valueNode.text;
    const line = nodeLineNumber(declNameNode);
    const col = nodeColumn(declNameNode);

    const normalizedValue = classifyAnimationExpression(rawValue);

    findings.push({
      category: "animation",
      sourcePath: filePath,
      line,
      col,
      declName,
      rawValue,
      normalizedValue,
      context: "extension Animation static let",
      isDeclaration: true,
    });
  }

  return findings;
}

/**
 * Extract `.animation(curve, value: ...)` view modifier call sites.
 *
 * Covers three sub-patterns:
 * - `.animation(.spring(response: 0.5, dampingFraction: 0.75), value: offset)` — spring with params
 * - `.animation(.easeInOut(duration: 0.3), value: isVisible)` — named curve with duration
 * - `.animation(.easeIn)`, `.animation(.default)` — bare named curves
 * - `.animation(.standard, value: x)` — named-ref call site
 */
function extractAnimationModifierCallSites(source: string, filePath: string): RawFinding[] {
  return extractCallsByPrefix(source, filePath, /\.animation\(/g, ".animation()");
}

/**
 * Extract `withAnimation(<curve_expr>) { ... }` global function call sites.
 */
function extractWithAnimationCallSites(source: string, filePath: string): RawFinding[] {
  return extractCallsByPrefix(source, filePath, /\bwithAnimation\(/g, "withAnimation()");
}

/**
 * Shared scanner for `.animation(` and `withAnimation(` call sites.
 *
 * Uses a balanced-paren walk instead of a pure regex to correctly handle
 * nested argument lists like `.animation(.easeInOut(duration: 0.3), value: x)`.
 * A simple `[^)]*` regex would stop at the inner `)` of `easeInOut(...)`.
 */
function extractCallsByPrefix(
  source: string,
  filePath: string,
  prefixPattern: RegExp,
  context: string,
): RawFinding[] {
  const findings: RawFinding[] = [];
  const lines = source.split("\n");

  // Find all positions where the call starts (at the opening `(`)
  const prefixMatches = [...source.matchAll(prefixPattern)];

  for (const prefixMatch of prefixMatches) {
    if (prefixMatch.index === undefined) continue;

    // The open-paren is the last char of the matched prefix
    const openParenOffset = prefixMatch.index + prefixMatch[0].length - 1;
    const innerText = extractBalancedParens(source, openParenOffset);
    if (!innerText) continue;

    // fullText spans from the start of the prefix to the closing paren (inclusive)
    const fullText = source.slice(prefixMatch.index, openParenOffset + innerText.length + 2);

    // For .animation() only: strip the leading `.` from curveRaw for withAnimation calls
    const isModifier = context === ".animation()";
    const curveRaw = isModifier ? extractCurveFromAnimationArgs(innerText) : innerText.trim();

    if (!curveRaw) continue;

    const { line, col } = offsetToLineCol(source, lines, prefixMatch.index);
    const normalizedValue = classifyCurveExpression(curveRaw);

    findings.push({
      category: "animation",
      sourcePath: filePath,
      line,
      col,
      declName: null,
      rawValue: fullText,
      normalizedValue,
      context,
      isDeclaration: false,
    });
  }

  return findings;
}

/**
 * Given the offset of an opening `(` in source, return the text inside the balanced parens.
 * Returns null if the parens are unbalanced (e.g. truncated source).
 *
 * Example: source = "fn(a(b), c)" at offset 2 → returns "a(b), c"
 */
function extractBalancedParens(source: string, openParenOffset: number): string | null {
  if (source[openParenOffset] !== "(") return null;

  let depth = 0;
  for (let i = openParenOffset; i < source.length; i++) {
    if (source[i] === "(") depth++;
    else if (source[i] === ")") {
      depth--;
      if (depth === 0) {
        return source.slice(openParenOffset + 1, i);
      }
    }
  }
  return null; // Unbalanced
}

// === CURVE CLASSIFIERS ===

/**
 * Extract the curve portion from `.animation(...)` inner args.
 * Strips the trailing `, value: <anything>` portion if present.
 *
 * Examples:
 *   ".easeInOut(duration: 0.3), value: isVisible" → ".easeInOut(duration: 0.3)"
 *   ".spring(response: 0.5, dampingFraction: 0.75), value: offset" → ".spring(response: 0.5, dampingFraction: 0.75)"
 *   ".easeIn" → ".easeIn"
 *   ".standard, value: x" → ".standard"
 */
function extractCurveFromAnimationArgs(innerText: string): string | null {
  const trimmed = innerText.trim();

  // Find `, value:` separator that's at paren depth 0
  let depth = 0;
  let valueSepIndex = -1;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0 && trimmed.slice(i).startsWith(", value:")) {
      valueSepIndex = i;
      break;
    }
  }

  const curveRaw = valueSepIndex >= 0 ? trimmed.slice(0, valueSepIndex).trim() : trimmed;
  return curveRaw || null;
}

/**
 * Classify an animation curve expression and emit a NormalizedAnimation record.
 *
 * Handles:
 * - `.spring(response:dampingFraction:blendDuration?)` — any labeled numeric args captured
 * - `.interpolatingSpring(...)` — captured as interpolatingSpring
 * - `.easeIn(duration:)` / `.easeOut(duration:)` / `.easeInOut(duration:)` / `.linear(duration:)` — with optional duration
 * - `.easeIn` / `.easeOut` / `.easeInOut` / `.linear` / `.default` — bare
 * - `.timingCurve(...)` — captured as timingCurve
 * - `.standard` (or any other dot-identifier) — named-ref
 * - `Animation.spring(...)` / `Animation.easeInOut(...)` — qualified form (in extension bodies)
 */
function classifyCurveExpression(curveRaw: string): NormalizedAnimation | null {
  const trimmed = curveRaw.trim();

  // Strip leading `.` or `Animation.` prefix for matching
  const withoutPrefix = trimmed.replace(/^(?:Animation\.|\.)?/, "");

  // Spring variants
  if (/^spring\b/.test(withoutPrefix)) {
    const args = extractLabeledNumericArgs(withoutPrefix);
    return {
      type: "spring",
      ...(args.response !== undefined && { response: args.response }),
      ...(args.dampingFraction !== undefined && { dampingFraction: args.dampingFraction }),
      ...(args.blendDuration !== undefined && { blendDuration: args.blendDuration }),
      ...(args.duration !== undefined && { duration: args.duration }),
    };
  }

  // interpolatingSpring
  if (/^interpolatingSpring\b/.test(withoutPrefix)) {
    const args = extractLabeledNumericArgs(withoutPrefix);
    return {
      type: "interpolatingSpring",
      ...(args.response !== undefined && { response: args.response }),
      ...(args.dampingFraction !== undefined && { dampingFraction: args.dampingFraction }),
      ...(args.duration !== undefined && { duration: args.duration }),
    };
  }

  // timingCurve
  if (/^timingCurve\b/.test(withoutPrefix)) {
    return { type: "timingCurve" };
  }

  // Named curves with optional duration arg: easeIn(duration:), easeOut(duration:), etc.
  const namedCurveMatch = /^(easeIn|easeOut|easeInOut|linear)(?:\(duration:\s*([\d.]+)\))?$/.exec(
    withoutPrefix,
  );
  if (namedCurveMatch) {
    const curveType = namedCurveMatch[1] as "easeIn" | "easeOut" | "easeInOut" | "linear";
    const durationStr = namedCurveMatch[2];
    return {
      type: curveType,
      ...(durationStr !== undefined && { duration: Number.parseFloat(durationStr) }),
    };
  }

  // Bare `.default`
  if (withoutPrefix === "default") {
    return { type: "default" };
  }

  // Named-ref: a dot-shorthand identifier that doesn't match any built-in curve
  // e.g. `.standard`, `.bouncy`, `.interactive`
  const identifierMatch = /^([A-Za-z_][A-Za-z0-9_]*)$/.exec(withoutPrefix);
  const namedRefId = identifierMatch?.[1];
  if (namedRefId) {
    return { type: "named-ref", namedRef: namedRefId };
  }

  // Unknown form — let LLM normalize pass handle it
  return null;
}

/**
 * Classify a full animation expression — used for extension body values.
 * Delegates to classifyCurveExpression after stripping prefix.
 */
function classifyAnimationExpression(rawValue: string): NormalizedAnimation | null {
  return classifyCurveExpression(rawValue);
}

// === UTILITY ===

/** Labeled numeric arg names we capture from spring/interpolatingSpring calls */
const NUMERIC_ARG_LABELS = ["response", "dampingFraction", "blendDuration", "duration"] as const;
type NumericArgLabel = (typeof NUMERIC_ARG_LABELS)[number];
type ExtractedArgs = Partial<Record<NumericArgLabel, number>>;

/**
 * Extract labeled numeric arguments from a function call string.
 *
 * e.g. `spring(response: 0.5, dampingFraction: 0.75)` → { response: 0.5, dampingFraction: 0.75 }
 *
 * Non-numeric values (computed expressions) are skipped — the LLM normalize pass handles them.
 */
function extractLabeledNumericArgs(callText: string): ExtractedArgs {
  const result: ExtractedArgs = {};

  for (const label of NUMERIC_ARG_LABELS) {
    const pattern = new RegExp(`\\b${label}:\\s*([\\d.]+)`);
    const match = pattern.exec(callText);
    if (match?.[1]) {
      result[label] = Number.parseFloat(match[1]);
    }
  }

  return result;
}

/**
 * Convert a byte offset in `source` to 1-based line + 0-based column.
 * Reuses the `lines` array to avoid re-splitting on every call.
 */
function offsetToLineCol(
  source: string,
  lines: string[],
  offset: number,
): { line: number; col: number } {
  void source;
  let runningOffset = 0;
  for (let i = 0; i < lines.length; i++) {
    const lineLen = (lines[i]?.length ?? 0) + 1; // +1 for newline
    if (runningOffset + lineLen > offset) {
      return { line: i + 1, col: offset - runningOffset };
    }
    runningOffset += lineLen;
  }
  return { line: lines.length, col: 0 };
}
