/**
 * parsers/glass.ts
 *
 * iOS 26 Liquid Glass parser — extracts all glassEffect usage patterns from
 * SwiftUI source files.
 *
 * === WHAT THIS PARSER HANDLES ===
 *
 * 1. `.glassEffect()` — bare call, variant defaults to "regular"
 * 2. `.glassEffect(.regular)` / `.glassEffect(.clear)` / `.glassEffect(.identity)`
 * 3. `.glassEffect(.regular.tint(Color.brandPrimary).interactive())` — chained modifiers
 * 4. `GlassEffectContainer { ... }` and `GlassEffectContainer(spacing: 8) { ... }`
 * 5. `.glassEffectID("card", in: glassNamespace)` — animation grouping
 * 6. `.buttonStyle(.glass)` / `.buttonStyle(.glassProminent)`
 *
 * === AUDIT FLAG: GLASS ON CONTENT LAYER ===
 *
 * Apple guidance: glass is for navigation layer only (TabBar, NavigationBar, toolbars).
 * Using it on content containers or primitive shapes is an anti-pattern.
 *
 * This parser applies a heuristic: when `.glassEffect()` appears on a line where the
 * call receiver is one of the known content-layer types (List, ScrollView, LazyVStack,
 * LazyHStack, RoundedRectangle, Circle, Rectangle), severity is set to "warning".
 * Otherwise severity is "info".
 *
 * **Known false-positive cases:** multi-line chained modifier expressions where the
 * parent view type is on a different line; expressions inside closures where the type
 * is determined by the enclosing context. This is acceptable for v1 — the audit is
 * advisory, not automated remediation.
 *
 * === WHAT THIS PARSER DOES NOT HANDLE ===
 *
 * - Custom GlassEffectStyle declarations (out of scope for v1)
 * - DTCG emitter shape — that is emitters/glass.ts responsibility
 * - Token namespacing under $extensions.<vendor>.material — that is the emitter's job
 *
 * === iOS AVAILABILITY ===
 *
 * All patterns are iOS 26+ / Apple-proprietary. The extract CLI gates this parser
 * on IPHONEOS_DEPLOYMENT_TARGET >= 26.0 (§8.5). This parser does no gating itself —
 * it records what it finds; callers decide whether to include findings.
 */

import path from "node:path";
import type { Tree } from "./swift-ast.js";
import type { RawFinding } from "./types.js";

// === PUBLIC API ===

/**
 * Normalized value shape for liquidGlass findings.
 * Emitter reads this to build the $extensions.<vendor>.material token.
 */
export interface GlassNormalizedValue {
  readonly variant?: "regular" | "clear" | "identity";
  readonly tint?: string;
  readonly interactive?: boolean;
  readonly spacing?: number;
  readonly id?: string;
  readonly namespace?: string;
  readonly buttonStyle?: "glass" | "glassProminent";
}

/**
 * Extract Liquid Glass usage findings from a single Swift source file.
 *
 * @param source   Raw Swift source text
 * @param filePath Absolute path to the source file — used for provenance in findings
 * @param _tree    Unused — glass extraction is regex-only. Accepted for API symmetry
 *                 so callers can pass a shared tree without branching.
 * @returns        Array of RawFinding objects (may be empty)
 */
export function extractGlass(source: string, filePath: string, _tree?: Tree): RawFinding[] {
  const relativePath = path.normalize(filePath);
  const findings: RawFinding[] = [];

  // Pass 1: .glassEffect(...) modifier calls
  const glassEffectFindings = extractGlassEffectCalls(source, relativePath);
  findings.push(...glassEffectFindings);

  // Pass 2: GlassEffectContainer usage
  const containerFindings = extractGlassEffectContainers(source, relativePath);
  findings.push(...containerFindings);

  // Pass 3: .glassEffectID(...) animation grouping
  const idFindings = extractGlassEffectIDs(source, relativePath);
  findings.push(...idFindings);

  // Pass 4: .buttonStyle(.glass) / .buttonStyle(.glassProminent)
  const buttonStyleFindings = extractGlassButtonStyles(source, relativePath);
  findings.push(...buttonStyleFindings);

  return findings;
}

// === PRIVATE HELPERS ===

/** Content-layer view types that should not receive .glassEffect() — Apple guidance. */
const CONTENT_LAYER_TYPES = [
  "List",
  "ScrollView",
  "LazyVStack",
  "LazyHStack",
  "RoundedRectangle",
  "Circle",
  "Rectangle",
];

/** Navigation-layer types — glass is appropriate here. */
const NAVIGATION_LAYER_TYPES = ["NavigationBar", "TabView", "toolbar", "ToolbarItem"];

/**
 * Determine severity for a .glassEffect() call.
 *
 * Heuristic: scan the preceding source context (up to 8 lines back) for a known
 * content-layer type. SwiftUI chains often span multiple lines — the view type
 * may be several lines above the `.glassEffect()` modifier.
 *
 * Returns "warning" if a content-layer type is found, "info" otherwise.
 *
 * False-positive risk: if source happens to mention a content-layer type name
 * in a comment or unrelated expression within the 8-line window, this will
 * over-warn. Acceptable for v1 — the audit is advisory only.
 */
function classifyGlassEffectSeverity(source: string, matchIndex: number): "info" | "warning" {
  // Collect the preceding context: up to 8 lines before the .glassEffect call.
  // This covers the common SwiftUI pattern where the view is the chain root
  // several lines above the modifier.
  const beforeMatch = source.slice(0, matchIndex);
  const precedingLines = beforeMatch.split("\n");
  const windowLines = precedingLines.slice(Math.max(0, precedingLines.length - 8));
  const context = windowLines.join("\n");

  // Navigation layer — explicit safe context trumps content-layer detection
  if (NAVIGATION_LAYER_TYPES.some((t) => context.includes(t))) {
    return "info";
  }

  // Content layer — flag as warning
  if (CONTENT_LAYER_TYPES.some((t) => new RegExp(`\\b${t}\\b`).test(context))) {
    return "warning";
  }

  return "info";
}

/**
 * Extract all `.glassEffect(...)` modifier calls.
 *
 * Handles:
 * - `.glassEffect()` — bare
 * - `.glassEffect(.regular)` / `.glassEffect(.clear)` / `.glassEffect(.identity)`
 * - `.glassEffect(.regular.tint(Color.foo).interactive())` — chained style modifiers
 */
function extractGlassEffectCalls(source: string, filePath: string): RawFinding[] {
  const findings: RawFinding[] = [];

  // Matches .glassEffect( ... ) — the inner content is captured lazily.
  // We allow the argument to span balanced parentheses by first capturing everything
  // up to the next unbalanced ')' via a depth-tracking pass after the initial regex.
  const pattern = /\.glassEffect\s*\(/g;
  const lines = source.split("\n");

  for (const match of [...source.matchAll(pattern)]) {
    if (match.index === undefined) continue;

    const callStart = match.index;
    const argStart = callStart + match[0].length;

    // Walk forward to find the matching closing paren, tracking depth.
    let depth = 1;
    let pos = argStart;
    while (pos < source.length && depth > 0) {
      if (source[pos] === "(") depth++;
      else if (source[pos] === ")") depth--;
      pos++;
    }
    // pos now points one past the closing ')'
    const argContent = source.slice(argStart, pos - 1).trim();
    const rawValue = source.slice(callStart, pos);

    const { line, col } = offsetToLineCol(source, callStart, lines);
    const severity = classifyGlassEffectSeverity(source, callStart);
    const normalizedValue = parseGlassEffectArgs(argContent);

    const finding: RawFinding = {
      category: "liquidGlass",
      sourcePath: filePath,
      line,
      col,
      declName: null,
      rawValue,
      normalizedValue,
      context: ".glassEffect()",
      isDeclaration: false,
      severity,
    };

    findings.push(finding);

    // If this is a content-layer violation, emit a second finding as the audit record.
    if (severity === "warning") {
      findings.push({
        ...finding,
        context: "glass on content layer",
        severity: "warning",
      });
    }
  }

  return findings;
}

/**
 * Parse the argument content of a `.glassEffect(...)` call.
 *
 * Handles:
 * - empty → variant: undefined (defaults to "regular" per Apple docs)
 * - `.regular` / `.clear` / `.identity` → variant
 * - `.regular.tint(Color.foo).interactive()` → variant + tint + interactive
 */
function parseGlassEffectArgs(argContent: string): GlassNormalizedValue | null {
  if (!argContent) {
    // Bare .glassEffect() — variant is "regular" per Apple default
    return { variant: "regular" };
  }

  const result: {
    variant?: "regular" | "clear" | "identity";
    tint?: string;
    interactive?: boolean;
  } = {};

  // Extract base variant — the first .identifier before any chained calls
  const variantMatch = /^\.?(regular|clear|identity)\b/.exec(argContent);
  if (variantMatch?.[1]) {
    result.variant = variantMatch[1] as "regular" | "clear" | "identity";
  }

  // Extract .tint(Color.foo) — capture the full argument expression
  const tintMatch = /\.tint\(([^)]+)\)/.exec(argContent);
  if (tintMatch?.[1]) {
    result.tint = tintMatch[1].trim();
  }

  // Extract .interactive() flag
  if (/\.interactive\(\)/.test(argContent)) {
    result.interactive = true;
  }

  return Object.keys(result).length > 0 ? result : null;
}

/**
 * Extract `GlassEffectContainer { ... }` and `GlassEffectContainer(spacing: N) { ... }`.
 */
function extractGlassEffectContainers(source: string, filePath: string): RawFinding[] {
  const findings: RawFinding[] = [];

  // Matches GlassEffectContainer optionally followed by (spacing: <number>)
  const pattern = /\bGlassEffectContainer\s*(?:\(\s*spacing:\s*(\d+(?:\.\d+)?)\s*\))?\s*\{/g;
  const lines = source.split("\n");

  for (const match of [...source.matchAll(pattern)]) {
    if (match.index === undefined) continue;

    const spacingRaw = match[1];
    const spacing = spacingRaw !== undefined ? Number.parseFloat(spacingRaw) : undefined;
    const rawValue = match[0];
    const { line, col } = offsetToLineCol(source, match.index, lines);

    const normalizedValue: GlassNormalizedValue = spacing !== undefined ? { spacing } : {};

    findings.push({
      category: "liquidGlass",
      sourcePath: filePath,
      line,
      col,
      declName: null,
      rawValue,
      normalizedValue,
      context: "GlassEffectContainer",
      isDeclaration: false,
      severity: "info",
    });
  }

  return findings;
}

/**
 * Extract `.glassEffectID("id", in: namespace)` animation grouping calls.
 */
function extractGlassEffectIDs(source: string, filePath: string): RawFinding[] {
  const findings: RawFinding[] = [];

  // Matches .glassEffectID("someId", in: someNamespace)
  const pattern = /\.glassEffectID\s*\(\s*"([^"]+)"\s*,\s*in:\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/g;
  const lines = source.split("\n");

  for (const match of [...source.matchAll(pattern)]) {
    if (match.index === undefined) continue;

    const id = match[1];
    const namespace = match[2];
    if (!id || !namespace) continue;

    const { line, col } = offsetToLineCol(source, match.index, lines);

    findings.push({
      category: "liquidGlass",
      sourcePath: filePath,
      line,
      col,
      declName: null,
      rawValue: match[0],
      normalizedValue: { id, namespace },
      context: ".glassEffectID",
      isDeclaration: false,
      severity: "info",
    });
  }

  return findings;
}

/**
 * Extract `.buttonStyle(.glass)` and `.buttonStyle(.glassProminent)`.
 */
function extractGlassButtonStyles(source: string, filePath: string): RawFinding[] {
  const findings: RawFinding[] = [];

  // Matches .buttonStyle(.glass) or .buttonStyle(.glassProminent)
  const pattern = /\.buttonStyle\s*\(\s*\.(glassProminent|glass)\s*\)/g;
  const lines = source.split("\n");

  for (const match of [...source.matchAll(pattern)]) {
    if (match.index === undefined) continue;

    const style = match[1] as "glass" | "glassProminent";
    const { line, col } = offsetToLineCol(source, match.index, lines);

    findings.push({
      category: "liquidGlass",
      sourcePath: filePath,
      line,
      col,
      declName: null,
      rawValue: match[0],
      normalizedValue: { buttonStyle: style },
      context: `.buttonStyle(.${style})`,
      isDeclaration: false,
      severity: "info",
    });
  }

  return findings;
}

// === UTILITIES ===

/**
 * Convert a character offset in `source` to a 1-based line number and 0-based column.
 * Accepts a pre-split lines array to avoid re-splitting on every call.
 */
function offsetToLineCol(
  source: string,
  offset: number,
  lines: readonly string[],
): { line: number; col: number } {
  let runningOffset = 0;
  for (let i = 0; i < lines.length; i++) {
    const lineLen = (lines[i]?.length ?? 0) + 1; // +1 for newline
    if (runningOffset + lineLen > offset) {
      return { line: i + 1, col: offset - runningOffset };
    }
    runningOffset += lineLen;
  }
  // Fallback: last line
  return {
    line: lines.length,
    col: offset - (source.length - (lines[lines.length - 1]?.length ?? 0)),
  };
}
