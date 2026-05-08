/**
 * parsers/spacing.ts
 *
 * Spacing extraction for Extractoken — Slice 2.
 * Mirrors the structure of parsers/color.ts (the reference implementation).
 *
 * === WHAT THIS PARSER HANDLES ===
 *
 * 1. `.padding(16)` — single integer/float literal
 * 2. `.padding(.horizontal, 24)` — labeled edge variant
 * 3. `.padding(.vertical, 12)`, `.padding(.top, 8)`, etc.
 * 4. `.padding(EdgeInsets(top: 8, leading: 12, bottom: 8, trailing: 12))` — four-sided literal
 * 5. `VStack(spacing: 12) { ... }` / `HStack(spacing: 8) { ... }` — stack spacing
 * 6. `Spacer().frame(minHeight: 32)` and other `.frame(width:height:)` numeric literals
 * 7. `enum Spacing { static let xs: CGFloat = 4 ... }` — token declarations
 * 8. `.padding(Spacing.md)` / `.padding(.md)` — named-ref call-site shorthands
 *
 * === EDGE CASES ===
 *
 * - `.padding(isCompact ? 8 : 16)` — emits two findings (one per branch) with
 *   `context: "conditional spacing"`
 * - Named constant references like `spacing: Constants.padding` emit a finding
 *   with `normalizedValue: null` and the identifier in `rawValue`
 *
 * === WHAT THIS PARSER DOES NOT HANDLE ===
 *
 * - LLM normalization — that's llm/normalize.ts
 * - Token name harmonization — that's llm/harmonize.ts
 * - Non-numeric spacing expressions beyond the patterns above
 */

import path from "node:path";
import type { Tree } from "./swift-ast.js";
import type { RawFinding } from "./types.js";

// === PUBLIC API ===

/**
 * Extract spacing findings from a single Swift source file.
 *
 * @param source   Raw Swift source text
 * @param filePath Absolute path to the source file — used for provenance in findings
 * @param _tree    Unused — spacing extraction is regex-only. Accepted for API symmetry
 *                 so callers can pass a shared tree without branching.
 * @returns        Array of RawFinding objects (may be empty)
 */
export function extractSpacing(source: string, filePath: string, _tree?: Tree): RawFinding[] {
  const relativePath = normalizeFilePath(filePath);
  const findings: RawFinding[] = [];

  // Pass 1: enum Spacing { static let xs: CGFloat = N } — token declarations
  const enumFindings = extractEnumSpacingDeclarations(source, relativePath);
  findings.push(...enumFindings);

  // Pass 2: .padding(N) — single literal
  const simplePaddingFindings = extractSimplePadding(source, relativePath);
  findings.push(...simplePaddingFindings);

  // Pass 3: .padding(.edge, N) — labeled edge variant
  const edgePaddingFindings = extractEdgePadding(source, relativePath);
  findings.push(...edgePaddingFindings);

  // Pass 4: .padding(EdgeInsets(top: N, leading: N, bottom: N, trailing: N))
  const edgeInsetsFindings = extractEdgeInsetsPadding(source, relativePath);
  findings.push(...edgeInsetsFindings);

  // Pass 5: VStack(spacing: N) / HStack(spacing: N) / LazyVStack(spacing: N) etc.
  const stackSpacingFindings = extractStackSpacing(source, relativePath);
  findings.push(...stackSpacingFindings);

  // Pass 6: .frame(width: N) / .frame(height: N) / .frame(minHeight: N) etc.
  const frameFindings = extractFrameDimensions(source, relativePath);
  findings.push(...frameFindings);

  // Pass 7: .padding(Spacing.md) / .padding(.md) — named-ref shorthands
  const namedRefFindings = extractNamedRefPadding(source, relativePath);
  findings.push(...namedRefFindings);

  return findings;
}

// === PRIVATE HELPERS ===

/**
 * Extract `enum Spacing { static let xs: CGFloat = 4 }` token declarations.
 * Each `static let` is one finding with `isDeclaration: true`.
 */
function extractEnumSpacingDeclarations(source: string, filePath: string): RawFinding[] {
  const findings: RawFinding[] = [];
  const lines = source.split("\n");

  // Match: enum SpacingName (any identifier) { ... }
  // Then inside, look for `static let identifier: CGFloat = N`
  // Strategy: find enum blocks named with "Spacing" or any name, scan for static lets
  // We parse with regex over lines rather than AST because enum bodies are flat.

  // Step 1: find enum blocks — record their line ranges
  const enumBlockRanges: Array<{ startLine: number; endLine: number }> = [];
  let braceDepth = 0;
  let inSpacingEnum = false;
  let enumStartLine = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";

    // Detect the opening of a Spacing-named enum
    if (
      /^\s*(?:public\s+|internal\s+|private\s+|fileprivate\s+)?enum\s+\w*[Ss]pacing\w*\s*\{/.test(
        line,
      )
    ) {
      inSpacingEnum = true;
      enumStartLine = i;
      braceDepth = 1;
      continue;
    }

    if (inSpacingEnum) {
      for (const char of line) {
        if (char === "{") braceDepth++;
        else if (char === "}") braceDepth--;
      }

      if (braceDepth <= 0) {
        enumBlockRanges.push({ startLine: enumStartLine, endLine: i });
        inSpacingEnum = false;
        braceDepth = 0;
      }
    }
  }

  // Step 2: within each enum block, extract static lets
  const staticLetPattern =
    /^\s*(?:static\s+)?(?:public\s+)?(?:static\s+)?let\s+(\w+)\s*(?::\s*CGFloat)?\s*=\s*([\d.]+)/;

  for (const range of enumBlockRanges) {
    for (let i = range.startLine + 1; i < range.endLine; i++) {
      const line = lines[i] ?? "";
      const match = staticLetPattern.exec(line);
      if (!match) continue;

      const declName = match[1];
      const rawNumeric = match[2];
      if (!declName || !rawNumeric) continue;

      const numericValue = Number.parseFloat(rawNumeric);
      if (Number.isNaN(numericValue)) continue;

      findings.push({
        category: "spacing",
        sourcePath: filePath,
        line: i + 1,
        col: line.indexOf("let"),
        declName,
        rawValue: line.trim(),
        normalizedValue: numericValue,
        context: "enum Spacing static let",
        isDeclaration: true,
      });
    }
  }

  return findings;
}

/**
 * Extract `.padding(N)` — single numeric literal.
 * Also handles conditional form `.padding(isCompact ? 8 : 16)` — emits two findings.
 */
function extractSimplePadding(source: string, filePath: string): RawFinding[] {
  const findings: RawFinding[] = [];
  const lines = source.split("\n");

  // Conditional form: .padding(expr ? N : N)
  const conditionalPattern = /\.padding\(\s*\w[\w.]*\s*\?\s*([\d.]+)\s*:\s*([\d.]+)\s*\)/g;
  for (const match of [...source.matchAll(conditionalPattern)]) {
    const trueBranch = match[1];
    const falseBranch = match[2];
    if (!trueBranch || !falseBranch || match.index === undefined) continue;

    const { line, col } = offsetToLineCol(source, lines, match.index);

    findings.push(
      {
        category: "spacing",
        sourcePath: filePath,
        line,
        col,
        declName: null,
        rawValue: match[0],
        normalizedValue: Number.parseFloat(trueBranch),
        context: "conditional spacing",
        isDeclaration: false,
      },
      {
        category: "spacing",
        sourcePath: filePath,
        line,
        col,
        declName: null,
        rawValue: match[0],
        normalizedValue: Number.parseFloat(falseBranch),
        context: "conditional spacing",
        isDeclaration: false,
      },
    );
  }

  // Simple form: .padding(N) — must not be preceded by a conditional already captured
  // Exclude: .padding(.edge, N) — handled in Pass 3
  // Exclude: .padding(EdgeInsets...) — handled in Pass 4
  // Exclude: .padding(Spacing.x) — handled in Pass 7
  // Exclude: .padding(.x) — handled in Pass 7
  // Exclude: conditional form — already handled above
  const simplePattern = /\.padding\(\s*([\d.]+)\s*\)/g;
  for (const match of [...source.matchAll(simplePattern)]) {
    const rawNum = match[1];
    if (!rawNum || match.index === undefined) continue;

    const value = Number.parseFloat(rawNum);
    if (Number.isNaN(value)) continue;

    const { line, col } = offsetToLineCol(source, lines, match.index);

    findings.push({
      category: "spacing",
      sourcePath: filePath,
      line,
      col,
      declName: null,
      rawValue: match[0],
      normalizedValue: value,
      context: "padding(N)",
      isDeclaration: false,
    });
  }

  return findings;
}

/**
 * Extract `.padding(.edge, N)` — labeled SwiftUI edge variants.
 * Covers .horizontal, .vertical, .top, .bottom, .leading, .trailing, .all.
 */
function extractEdgePadding(source: string, filePath: string): RawFinding[] {
  const findings: RawFinding[] = [];
  const lines = source.split("\n");

  // Matches .padding(.horizontal, 24), .padding(.top, 8), etc.
  const edgePattern =
    /\.padding\(\s*(\.(?:horizontal|vertical|top|bottom|leading|trailing|all))\s*,\s*([\d.]+)\s*\)/g;

  for (const match of [...source.matchAll(edgePattern)]) {
    const edgeLabel = match[1];
    const rawNum = match[2];
    if (!edgeLabel || !rawNum || match.index === undefined) continue;

    const value = Number.parseFloat(rawNum);
    if (Number.isNaN(value)) continue;

    const { line, col } = offsetToLineCol(source, lines, match.index);

    findings.push({
      category: "spacing",
      sourcePath: filePath,
      line,
      col,
      declName: null,
      rawValue: match[0],
      normalizedValue: value,
      context: `padding(${edgeLabel}, N)`,
      isDeclaration: false,
    });
  }

  return findings;
}

/**
 * Extract `.padding(EdgeInsets(top: N, leading: N, bottom: N, trailing: N))`.
 * Emits four findings, one per edge, each with a descriptive context.
 */
function extractEdgeInsetsPadding(source: string, filePath: string): RawFinding[] {
  const findings: RawFinding[] = [];
  const lines = source.split("\n");

  // Full EdgeInsets literal — all four labels required
  const edgeInsetsPattern =
    /\.padding\(\s*EdgeInsets\(\s*top:\s*([\d.]+)\s*,\s*leading:\s*([\d.]+)\s*,\s*bottom:\s*([\d.]+)\s*,\s*trailing:\s*([\d.]+)\s*\)\s*\)/g;

  for (const match of [...source.matchAll(edgeInsetsPattern)]) {
    const [top, leading, bottom, trailing] = [match[1], match[2], match[3], match[4]];
    if (!top || !leading || !bottom || !trailing || match.index === undefined) continue;

    const { line, col } = offsetToLineCol(source, lines, match.index);
    const rawValue = match[0];

    const edges: Array<{ label: string; raw: string }> = [
      { label: "top", raw: top },
      { label: "leading", raw: leading },
      { label: "bottom", raw: bottom },
      { label: "trailing", raw: trailing },
    ];

    for (const { label, raw } of edges) {
      const numericValue = Number.parseFloat(raw);
      if (Number.isNaN(numericValue)) continue;

      findings.push({
        category: "spacing",
        sourcePath: filePath,
        line,
        col,
        declName: null,
        rawValue,
        normalizedValue: numericValue,
        context: `EdgeInsets ${label}`,
        isDeclaration: false,
      });
    }
  }

  return findings;
}

/**
 * Extract `VStack(spacing: N)`, `HStack(spacing: N)`, `LazyVStack(spacing: N)`, etc.
 * Covers any *Stack or Grid container with a `spacing:` argument.
 * Also handles conditional form: `VStack(spacing: isCompact ? 8 : 16)`.
 */
function extractStackSpacing(source: string, filePath: string): RawFinding[] {
  const findings: RawFinding[] = [];
  const lines = source.split("\n");

  const STACK_TYPES = [
    "VStack",
    "HStack",
    "ZStack",
    "LazyVStack",
    "LazyHStack",
    "LazyVGrid",
    "LazyHGrid",
    "Grid",
    "ScrollView",
    "GlassEffectContainer",
  ].join("|");

  // Conditional form: StackType(spacing: expr ? N : N)
  const conditionalPattern = new RegExp(
    `(${STACK_TYPES})\\([^)]*spacing:\\s*\\w[\\w.]*\\s*\\?\\s*([\\d.]+)\\s*:\\s*([\\d.]+)`,
    "g",
  );
  for (const match of [...source.matchAll(conditionalPattern)]) {
    const stackType = match[1];
    const trueBranch = match[2];
    const falseBranch = match[3];
    if (!stackType || !trueBranch || !falseBranch || match.index === undefined) continue;

    const { line, col } = offsetToLineCol(source, lines, match.index);

    findings.push(
      {
        category: "spacing",
        sourcePath: filePath,
        line,
        col,
        declName: null,
        rawValue: match[0],
        normalizedValue: Number.parseFloat(trueBranch),
        context: "conditional spacing",
        isDeclaration: false,
      },
      {
        category: "spacing",
        sourcePath: filePath,
        line,
        col,
        declName: null,
        rawValue: match[0],
        normalizedValue: Number.parseFloat(falseBranch),
        context: "conditional spacing",
        isDeclaration: false,
      },
    );
  }

  // Simple numeric form: StackType(spacing: N)
  const simplePattern = new RegExp(`(${STACK_TYPES})\\([^)]*spacing:\\s*([\\d.]+)`, "g");
  for (const match of [...source.matchAll(simplePattern)]) {
    const stackType = match[1];
    const rawNum = match[2];
    if (!stackType || !rawNum || match.index === undefined) continue;

    const value = Number.parseFloat(rawNum);
    if (Number.isNaN(value)) continue;

    const { line, col } = offsetToLineCol(source, lines, match.index);

    findings.push({
      category: "spacing",
      sourcePath: filePath,
      line,
      col,
      declName: null,
      rawValue: match[0],
      normalizedValue: value,
      context: `${stackType}(spacing:)`,
      isDeclaration: false,
    });
  }

  return findings;
}

/**
 * Extract `.frame(width: N)`, `.frame(height: N)`, `.frame(minHeight: N)`,
 * `.frame(maxWidth: N)`, etc. — numeric frame dimension literals.
 *
 * Strategy: first capture each `.frame(...)` call as a unit, then scan its
 * argument list for label:N pairs. This correctly handles multi-argument calls
 * like `.frame(width: 48, height: 2)` where a single regex pass would only
 * match the first label.
 */
function extractFrameDimensions(source: string, filePath: string): RawFinding[] {
  const findings: RawFinding[] = [];
  const lines = source.split("\n");

  const FRAME_LABELS = new Set([
    "width",
    "height",
    "minWidth",
    "maxWidth",
    "minHeight",
    "maxHeight",
    "idealWidth",
    "idealHeight",
  ]);

  // Capture the full .frame(...) call — simple paren matching for one nesting level
  const frameCallPattern = /\.frame\(([^()]*)\)/g;

  for (const frameMatch of [...source.matchAll(frameCallPattern)]) {
    const argsText = frameMatch[1];
    if (!argsText || frameMatch.index === undefined) continue;

    // Scan inside the argument list for label: numericLiteral pairs
    const argPattern = /\b(\w+):\s*([\d.]+)/g;
    for (const argMatch of [...argsText.matchAll(argPattern)]) {
      const label = argMatch[1];
      const rawNum = argMatch[2];
      if (!label || !rawNum) continue;
      if (!FRAME_LABELS.has(label)) continue;

      const value = Number.parseFloat(rawNum);
      if (Number.isNaN(value)) continue;

      const { line, col } = offsetToLineCol(source, lines, frameMatch.index);

      findings.push({
        category: "spacing",
        sourcePath: filePath,
        line,
        col,
        declName: null,
        rawValue: frameMatch[0],
        normalizedValue: value,
        context: `frame(${label}:)`,
        isDeclaration: false,
      });
    }
  }

  return findings;
}

/**
 * Extract `.padding(Spacing.md)` and `.padding(.md)` — named constant references.
 * Emits call-site findings with `normalizedValue: null` (LLM resolves the reference).
 * `rawValue` contains the identifier so the LLM pass can cross-reference declarations.
 */
function extractNamedRefPadding(source: string, filePath: string): RawFinding[] {
  const findings: RawFinding[] = [];
  const lines = source.split("\n");

  // .padding(Spacing.identifier) or .padding(SomeType.identifier)
  const qualifiedPattern = /\.padding\(\s*([A-Z][A-Za-z0-9_]*\.[a-z][A-Za-z0-9_]*)\s*\)/g;
  for (const match of [...source.matchAll(qualifiedPattern)]) {
    const ref = match[1];
    if (!ref || match.index === undefined) continue;

    const { line, col } = offsetToLineCol(source, lines, match.index);

    findings.push({
      category: "spacing",
      sourcePath: filePath,
      line,
      col,
      declName: null,
      rawValue: match[0],
      normalizedValue: null,
      context: "padding(NamedRef)",
      isDeclaration: false,
    });
  }

  // .padding(.identifier) — shorthand (e.g. when extension on EdgeInsets or Spacing exists)
  // Exclude known edge labels (.horizontal, .vertical, .top, .bottom, .leading, .trailing, .all)
  const EDGE_LABELS = new Set([
    "horizontal",
    "vertical",
    "top",
    "bottom",
    "leading",
    "trailing",
    "all",
  ]);
  const implicitPattern = /\.padding\(\s*\.([a-z][A-Za-z0-9_]*)\s*\)/g;
  for (const match of [...source.matchAll(implicitPattern)]) {
    const identifier = match[1];
    if (!identifier || match.index === undefined) continue;
    if (EDGE_LABELS.has(identifier)) continue; // edge-only shorthand, skip

    const { line, col } = offsetToLineCol(source, lines, match.index);

    findings.push({
      category: "spacing",
      sourcePath: filePath,
      line,
      col,
      declName: null,
      rawValue: match[0],
      normalizedValue: null,
      context: "padding(.namedRef)",
      isDeclaration: false,
    });
  }

  return findings;
}

// === UTILITIES ===

/**
 * Convert a byte offset in `source` to a 1-based line number and 0-based column.
 * Same strategy as color.ts to keep provenance consistent across parsers.
 */
function offsetToLineCol(
  source: string,
  lines: string[],
  offset: number,
): { line: number; col: number } {
  let runningOffset = 0;
  let lineIdx = 0;
  for (; lineIdx < lines.length; lineIdx++) {
    const lineLen = (lines[lineIdx]?.length ?? 0) + 1; // +1 for newline
    if (runningOffset + lineLen > offset) break;
    runningOffset += lineLen;
  }
  return { line: lineIdx + 1, col: offset - runningOffset };
}

/**
 * Normalize a file path for storage in findings.
 * Stored as-is; CLI normalizes relative paths at extraction time.
 */
function normalizeFilePath(filePath: string): string {
  return path.normalize(filePath);
}
