/**
 * parsers/shadow.ts
 *
 * Shadow / elevation extractor for Extractoken (Slice 2).
 *
 * === WHAT THIS PARSER HANDLES ===
 *
 * 1. Full form:    `.shadow(color: .black.opacity(0.12), radius: 8, x: 0, y: 4)`
 * 2. Minimal form: `.shadow(radius: 4)` — default color/x/y
 * 3. No-opacity:   `.shadow(color: .black, radius: 6, x: 0, y: 2)`
 * 4. Wrapper decl: `extension View { func cardShadow() -> some View { shadow(...) } }`
 *    Captured as `isDeclaration: true` with `declName` set to the func name.
 * 5. Chained:      `.shadow(...).shadow(...)` — one finding per call.
 *
 * === WHAT THIS PARSER DOES NOT HANDLE ===
 *
 * - Color resolution — downstream shadow analyzer (Slice 3) resolves color references.
 * - DTCG normalization — that's llm/normalize.ts.
 *
 * === IMPLEMENTATION NOTES ===
 *
 * Regex-only. The `.shadow(...)` modifier's argument list is compact and well-structured;
 * a regex over source text is simpler and more robust than navigating the full AST here.
 * The AST is used only for detecting `extension View` wrapper declarations (to extract
 * the function name), falling back to regex on query error.
 *
 * Biome rule: use `[...source.matchAll(re)]` (not `.exec()` in a while loop).
 */

import path from "node:path";
import { getCapture, nodeColumn, nodeLineNumber, parseSource, runQuery } from "./swift-ast.js";
import type { RawFinding } from "./types.js";

// === PUBLIC API ===

/**
 * Normalized shadow value extracted from a `.shadow(...)` modifier call.
 *
 * `color` is the raw expression text (e.g. `.black`, `Color.shadow`).
 * If `.opacity(N)` was chained on the color expression, it is stripped and stored in `opacity`.
 * `x` / `y` default to 0 when omitted from the call.
 */
export interface NormalizedShadow {
  readonly color: string;
  readonly radius: number;
  readonly x: number;
  readonly y: number;
  readonly opacity: number | null; // extracted from .opacity(N), null if absent
}

/**
 * Extract shadow findings from a single Swift source file.
 *
 * @param source   Raw Swift source text
 * @param filePath Absolute path — used for provenance in findings
 * @returns        Array of RawFinding objects (may be empty)
 */
export function extractShadow(source: string, filePath: string): RawFinding[] {
  const relativePath = normalizeFilePath(filePath);
  const findings: RawFinding[] = [];

  // Pass 1: call-site `.shadow(...)` modifier invocations
  const callSiteFindings = extractCallSites(source, relativePath);
  findings.push(...callSiteFindings);

  // Pass 2: `extension View { func X() -> some View { shadow(...) } }` wrappers
  const declarationFindings = extractViewExtensionWrappers(source, relativePath);
  findings.push(...declarationFindings);

  return findings;
}

// === PRIVATE HELPERS ===

/**
 * Capture a balanced parenthesised argument block starting just after `offset`.
 * The source text at `offset` must be `(`. Returns the full `(...)` text including
 * the outer parens, or null if parsing fails.
 *
 * This handles nested parens so `.shadow(color: .black.opacity(0.12), radius: 8)`
 * is captured as one unit even though the color arg itself contains `(0.12)`.
 */
function captureParens(source: string, openIndex: number): string | null {
  if (source[openIndex] !== "(") return null;
  let depth = 0;
  let i = openIndex;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return source.slice(openIndex, i + 1);
    }
    i++;
  }
  return null; // unbalanced
}

/**
 * Extract all `.shadow(...)` call-site invocations.
 *
 * Handles:
 *  - Full form:    `.shadow(color:radius:x:y:)`
 *  - Minimal form: `.shadow(radius:)`
 *  - Chained:      `.shadow(...).shadow(...)` — one finding per call
 *
 * Strategy: find every occurrence of `.shadow(` in source, capture the balanced
 * argument block, then parse the args.
 */
function extractCallSites(source: string, filePath: string): RawFinding[] {
  const findings: RawFinding[] = [];
  const lines = source.split("\n");

  // Match `.shadow(` — the dot prefix prevents matching bare `shadow(` calls
  // which are the wrapper-body form handled by extractViewExtensionWrappers.
  const callPattern = /\.shadow\(/g;
  const matches = [...source.matchAll(callPattern)];

  for (const match of matches) {
    if (match.index === undefined) continue;

    // The open paren is the last char of the match (`.shadow(`)
    const openParenIndex = match.index + match[0].length - 1;
    const argsBlock = captureParens(source, openParenIndex);
    if (!argsBlock) continue;

    // Full source text for this call including the leading dot
    const rawValue = `.shadow${argsBlock}`;

    const normalizedShadow = parseShadowArgs(argsBlock);
    const { lineIdx, col } = offsetToLineCol(source, lines, match.index);

    findings.push({
      category: "shadow",
      sourcePath: filePath,
      line: lineIdx + 1,
      col,
      declName: null,
      rawValue,
      normalizedValue: normalizedShadow,
      context: ".shadow() call",
      isDeclaration: false,
    });
  }

  return findings;
}

/**
 * Extract `extension View` wrapper functions that contain a bare `shadow(...)` call.
 *
 * Pattern:
 * ```swift
 * extension View {
 *     func cardShadow() -> some View {
 *         shadow(color: .black.opacity(0.08), radius: 4, x: 0, y: 2)
 *     }
 * }
 * ```
 *
 * Uses the AST to find `class_declaration` nodes named "View", then regex to extract
 * the inner `shadow(...)` call and the wrapper function name.
 * Falls back to pure regex on query error for resilience.
 */
function extractViewExtensionWrappers(source: string, filePath: string): RawFinding[] {
  // Try AST-assisted extraction first
  try {
    return extractViewExtensionWrappersViaAst(source, filePath);
  } catch {
    // AST query failed — fall back to full-source regex
    return extractViewExtensionWrappersViaRegex(source, filePath);
  }
}

function extractViewExtensionWrappersViaAst(source: string, filePath: string): RawFinding[] {
  const tree = parseSource(source);
  const findings: RawFinding[] = [];
  const lines = source.split("\n");

  // Query for `extension View { func X() -> some View { ... } }` shape.
  // tree-sitter-swift represents extensions as class_declaration.
  // We grab the function name via function_declaration → simple_identifier.
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

    if (!extNameNode || extNameNode.text !== "View") continue;
    if (!funcNameNode) continue;

    // Extract the source text of the function body by finding it from the funcNameNode's parent.
    // Rather than walking the AST deeply, we use the function name position to locate the
    // relevant source slice and then apply regex to find the inner `shadow(...)` call.
    const funcName = funcNameNode.text;
    const funcLine = nodeLineNumber(funcNameNode);
    const funcCol = nodeColumn(funcNameNode);

    // Find the opening brace of the func body by scanning forward from the func declaration.
    // We locate the func keyword line in source, then search for `shadow(` within the body.
    const funcStartOffset = lineColToOffset(source, lines, funcLine - 1, funcCol);
    if (funcStartOffset === null) continue;

    // Find the function's braced body: scan forward for `{`, then capture to matching `}`
    const braceStart = source.indexOf("{", funcStartOffset);
    if (braceStart === -1) continue;

    const funcBodyText = captureBraces(source, braceStart);
    if (!funcBodyText) continue;

    // Find bare `shadow(` (no leading dot) inside the function body
    const innerPattern = /\bshadow\(/g;
    const innerMatches = [...funcBodyText.matchAll(innerPattern)];

    for (const innerMatch of innerMatches) {
      if (innerMatch.index === undefined) continue;

      const openParenIndex = innerMatch.index + innerMatch[0].length - 1;
      const argsBlock = captureParens(funcBodyText, openParenIndex);
      if (!argsBlock) continue;

      const rawValue = `shadow${argsBlock}`;
      const normalizedShadow = parseShadowArgs(argsBlock);

      findings.push({
        category: "shadow",
        sourcePath: filePath,
        line: funcLine,
        col: funcCol,
        declName: funcName,
        rawValue,
        normalizedValue: normalizedShadow,
        context: "extension View func wrapper",
        isDeclaration: true,
      });
    }
  }

  return findings;
}

/**
 * Regex fallback for extension View wrapper detection.
 * Matches the pattern:
 *   extension View {
 *       func <name>() -> some View {
 *           shadow(...)
 *       }
 *   }
 */
function extractViewExtensionWrappersViaRegex(source: string, filePath: string): RawFinding[] {
  const findings: RawFinding[] = [];
  const lines = source.split("\n");

  // Locate `extension View {` blocks
  const extPattern = /\bextension\s+View\s*\{/g;
  const extMatches = [...source.matchAll(extPattern)];

  for (const extMatch of extMatches) {
    if (extMatch.index === undefined) continue;

    const braceStart = source.indexOf("{", extMatch.index);
    if (braceStart === -1) continue;
    const extBody = captureBraces(source, braceStart);
    if (!extBody) continue;

    // Find func declarations within the extension body
    const funcPattern = /\bfunc\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
    const funcMatches = [...extBody.matchAll(funcPattern)];

    for (const funcMatch of funcMatches) {
      if (funcMatch.index === undefined) continue;
      const funcName = funcMatch[1];
      if (!funcName) continue;

      // Find the function's body brace
      const funcBraceStart = extBody.indexOf("{", funcMatch.index + funcMatch[0].length);
      if (funcBraceStart === -1) continue;
      const funcBodyText = captureBraces(extBody, funcBraceStart);
      if (!funcBodyText) continue;

      // Find bare `shadow(` inside function body
      const innerPattern = /\bshadow\(/g;
      const innerMatches = [...funcBodyText.matchAll(innerPattern)];

      for (const innerMatch of innerMatches) {
        if (innerMatch.index === undefined) continue;

        const openParenIndex = innerMatch.index + innerMatch[0].length - 1;
        const argsBlock = captureParens(funcBodyText, openParenIndex);
        if (!argsBlock) continue;

        const rawValue = `shadow${argsBlock}`;
        const normalizedShadow = parseShadowArgs(argsBlock);

        // Calculate absolute position in source
        const absOffset = extMatch.index + funcMatch.index;
        const { lineIdx, col } = offsetToLineCol(source, lines, absOffset);

        findings.push({
          category: "shadow",
          sourcePath: filePath,
          line: lineIdx + 1,
          col,
          declName: funcName,
          rawValue,
          normalizedValue: normalizedShadow,
          context: "extension View func wrapper",
          isDeclaration: true,
        });
      }
    }
  }

  return findings;
}

// === ARGUMENT PARSING ===

/**
 * Parse a balanced `(...)` argument block into a NormalizedShadow.
 *
 * Handles:
 *   (color: .black.opacity(0.12), radius: 8, x: 0, y: 4)
 *   (radius: 4)
 *   (color: .black, radius: 6, x: 0, y: 2)
 *   (color: Color.black, radius: 8, x: 0, y: 4)
 *
 * Returns null if `radius:` is absent (invalid/unrecognised form).
 */
function parseShadowArgs(argsBlock: string): NormalizedShadow | null {
  // Strip outer parens
  const inner = argsBlock.slice(1, -1).trim();

  const radius = extractLabeledNumber(inner, "radius");
  if (radius === null) return null;

  const x = extractLabeledNumber(inner, "x") ?? 0;
  const y = extractLabeledNumber(inner, "y") ?? 0;

  const colorRaw = extractColorArg(inner);
  const { color, opacity } = parseColorExpression(colorRaw);

  return { color, radius, x, y, opacity };
}

/**
 * Extract a labeled numeric argument, e.g. `radius: 8` → 8.
 * Returns null if the label is not present.
 */
function extractLabeledNumber(args: string, label: string): number | null {
  // Match `label: <number>` — negative numbers supported for x/y offsets
  const pattern = new RegExp(`\\b${label}\\s*:\\s*(-?[\\d.]+)`);
  const match = pattern.exec(args);
  if (!match?.[1]) return null;
  const value = Number.parseFloat(match[1]);
  return Number.isNaN(value) ? null : value;
}

/**
 * Extract the raw text of the `color:` argument from the args block.
 * Returns `".black"` as the default when the argument is absent.
 *
 * The color arg can itself contain nested parens (e.g. `.black.opacity(0.12)`)
 * so we cannot simply split on commas. Instead we locate the `color:` label
 * and capture forward until we hit a top-level comma or end of string.
 */
function extractColorArg(args: string): string {
  const labelMatch = /\bcolor\s*:\s*/.exec(args);
  if (!labelMatch) return ".black"; // default per SwiftUI

  const valueStart = labelMatch.index + labelMatch[0].length;
  let depth = 0;
  let i = valueStart;

  while (i < args.length) {
    const ch = args[i];
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (ch === "," && depth === 0) break;
    i++;
  }

  return args.slice(valueStart, i).trim();
}

/**
 * Split a color expression like `.black.opacity(0.12)` into:
 *   { color: ".black", opacity: 0.12 }
 *
 * If no `.opacity(N)` is present, opacity is null and color is the full expression.
 */
function parseColorExpression(rawColor: string): { color: string; opacity: number | null } {
  const opacityMatch = /^(.*?)\.opacity\(\s*([\d.]+)\s*\)\s*$/.exec(rawColor);
  if (!opacityMatch) {
    return { color: rawColor, opacity: null };
  }

  const baseColor = opacityMatch[1]?.trim() ?? rawColor;
  const opacityValue = Number.parseFloat(opacityMatch[2] ?? "1");
  const opacity = Number.isNaN(opacityValue) ? null : opacityValue;

  return { color: baseColor, opacity };
}

// === UTILITY ===

/**
 * Capture a balanced brace block starting at `openIndex` in source.
 * `source[openIndex]` must be `{`. Returns the full `{...}` text, or null.
 */
function captureBraces(source: string, openIndex: number): string | null {
  if (source[openIndex] !== "{") return null;
  let depth = 0;
  let i = openIndex;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return source.slice(openIndex, i + 1);
    }
    i++;
  }
  return null; // unbalanced
}

/**
 * Convert a byte offset in source to a `{ lineIdx, col }` pair.
 * `lines` must be `source.split("\n")`.
 */
function offsetToLineCol(
  _source: string,
  lines: string[],
  offset: number,
): { lineIdx: number; col: number } {
  let runningOffset = 0;
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const lineLen = (lines[lineIdx]?.length ?? 0) + 1; // +1 for newline
    if (runningOffset + lineLen > offset) {
      return { lineIdx, col: offset - runningOffset };
    }
    runningOffset += lineLen;
  }
  return { lineIdx: lines.length - 1, col: 0 };
}

/**
 * Convert a 0-based `(row, col)` position back to a byte offset in source.
 * Returns null if the row is out of range.
 */
function lineColToOffset(
  _source: string,
  lines: string[],
  row: number,
  col: number,
): number | null {
  if (row < 0 || row >= lines.length) return null;
  let offset = 0;
  for (let i = 0; i < row; i++) {
    offset += (lines[i]?.length ?? 0) + 1;
  }
  return offset + col;
}

function normalizeFilePath(filePath: string): string {
  return path.normalize(filePath);
}
