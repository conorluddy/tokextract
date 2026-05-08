/**
 * parsers/shape.ts
 *
 * Shape / corner radius parser for Extractoken — Slice 2.
 * Mirrors the structure of parsers/color.ts (header doc, public API, private passes, classifier).
 *
 * === WHAT THIS PARSER HANDLES ===
 *
 * 1. `.cornerRadius(12)` — view-modifier literal
 * 2. `RoundedRectangle(cornerRadius: 16)` — basic initializer
 * 3. `RoundedRectangle(cornerRadius: 16, style: .continuous)` — with style
 * 4. `.clipShape(RoundedRectangle(cornerRadius: 8))` — clipShape wrapping rounded rect
 * 5. `.clipShape(Circle())`, `.clipShape(Capsule())`, `.clipShape(Ellipse())` — full-radius shapes
 * 6. `extension View { func cardShape() -> some View { ... } }` — named View extension wrapper
 * 7. `UnevenRoundedRectangle(cornerRadii: .init(topLeading:bottomLeading:bottomTrailing:topTrailing:))` — iOS 16+
 * 8. `.clipShape(ContainerRelativeShape())` — adaptive shape
 *
 * === WHAT THIS PARSER DOES NOT HANDLE ===
 *
 * - LLM normalization — that's llm/normalize.ts
 * - Semantic token naming — that's the harmonize pass
 * - Dynamic/conditional radii (e.g. `cornerRadius: isCompact ? 8 : 16`) — emits raw snippet only
 *
 * === NODE TYPE NOTES ===
 *
 * tree-sitter-swift parses `extension Foo { }` as `class_declaration`, NOT
 * `extension_declaration`. All queries must use `class_declaration`.
 *
 * Style encoding: `style: .continuous` and `style: .circular` are encoded into
 * the `context` field (e.g. `"RoundedRectangle(cornerRadius:style:.continuous)")`)
 * rather than a new RawFinding field, since no new fields may be added to RawFinding.
 */

import path from "node:path";
import type { Tree } from "./swift-ast.js";
import type { RawFinding } from "./types.js";

// === PUBLIC API ===

/**
 * Extract corner radius / shape findings from a single Swift source file.
 *
 * @param source   Raw Swift source text
 * @param filePath Absolute path to the source file — used for provenance in findings
 * @param _tree    Unused — shape extraction is regex-only. Accepted for API symmetry
 *                 so callers can pass a shared tree without branching.
 * @returns        Array of RawFinding objects (may be empty)
 */
export function extractShape(source: string, filePath: string, _tree?: Tree): RawFinding[] {
  const relativePath = normalizeFilePath(filePath);
  const findings: RawFinding[] = [];

  // Pass 1: `.cornerRadius(n)` — view-modifier literal
  findings.push(...extractCornerRadiusModifiers(source, relativePath));

  // Pass 2: `RoundedRectangle(cornerRadius: n)` and `RoundedRectangle(cornerRadius: n, style: .x)`
  findings.push(...extractRoundedRectangleInits(source, relativePath));

  // Pass 3: `.clipShape(...)` — covers RoundedRectangle, Circle, Capsule, Ellipse, ContainerRelativeShape
  findings.push(...extractClipShapes(source, relativePath));

  // Pass 4: `UnevenRoundedRectangle(cornerRadii:)` — iOS 16+, all four per-corner radii
  findings.push(...extractUnevenRoundedRectangle(source, relativePath));

  // Pass 5: `extension View { func <name>() -> some View { ... } }` — named declaration forms
  // Note: only captures View-extension wrappers that contain a shape call; other passes cover
  // standalone call-sites. We run this last so declarations don't produce duplicate call-site hits.
  findings.push(...extractViewExtensionDeclarations(source, relativePath));

  return deduplicateFindings(findings);
}

// === PRIVATE HELPERS ===

/**
 * Pass 1: `.cornerRadius(n)` view-modifier — most common call-site form.
 *
 * Matches both integer and decimal literals. Named constants (e.g. `.cornerRadius(Tokens.radius)`)
 * are not captured by this pass — the LLM resolves those in the narrate pass.
 */
function extractCornerRadiusModifiers(source: string, filePath: string): RawFinding[] {
  const findings: RawFinding[] = [];
  // Match .cornerRadius(<number>) — integer or decimal, optional whitespace
  const pattern = /\.cornerRadius\(\s*([\d]+(?:\.[\d]+)?)\s*\)/g;
  const matches = [...source.matchAll(pattern)];
  const lines = source.split("\n");

  for (const match of matches) {
    const rawRadius = match[1];
    if (!rawRadius || match.index === undefined) continue;

    const radius = Number.parseFloat(rawRadius);
    const { line, col } = offsetToLineCol(match.index, lines);

    findings.push({
      category: "cornerRadius",
      sourcePath: filePath,
      line,
      col,
      declName: null,
      rawValue: match[0],
      normalizedValue: radius,
      context: ".cornerRadius()",
      isDeclaration: false,
      shapeType: "rounded",
    });
  }

  return findings;
}

/**
 * Pass 2: `RoundedRectangle(cornerRadius: n)` and `RoundedRectangle(cornerRadius: n, style: .x)`
 *
 * Captures the optional `style:` label. Style is encoded into `context` to avoid adding new
 * fields to RawFinding (see header doc).
 */
function extractRoundedRectangleInits(source: string, filePath: string): RawFinding[] {
  const findings: RawFinding[] = [];
  const lines = source.split("\n");

  // With optional style: .continuous | .circular
  // Handles both forms: `RoundedRectangle(cornerRadius: 16)` and `RoundedRectangle(cornerRadius: 16, style: .continuous)`
  const withStylePattern =
    /\bRoundedRectangle\(\s*cornerRadius:\s*([\d]+(?:\.[\d]+)?)\s*,\s*style:\s*\.(continuous|circular)\s*\)/g;
  const withoutStylePattern = /\bRoundedRectangle\(\s*cornerRadius:\s*([\d]+(?:\.[\d]+)?)\s*\)/g;

  const withStyleMatches = [...source.matchAll(withStylePattern)];
  const withoutStyleMatches = [...source.matchAll(withoutStylePattern)];

  // Track positions already emitted by the with-style pass to avoid double-emitting
  const emittedPositions = new Set<number>();

  for (const match of withStyleMatches) {
    const rawRadius = match[1];
    const style = match[2] as "continuous" | "circular";
    if (!rawRadius || match.index === undefined) continue;

    const radius = Number.parseFloat(rawRadius);
    const { line, col } = offsetToLineCol(match.index, lines);
    emittedPositions.add(match.index);

    findings.push({
      category: "cornerRadius",
      sourcePath: filePath,
      line,
      col,
      declName: null,
      rawValue: match[0],
      normalizedValue: radius,
      context: `RoundedRectangle(cornerRadius:style:.${style})`,
      isDeclaration: false,
      shapeType: "rounded",
    });
  }

  for (const match of withoutStyleMatches) {
    const rawRadius = match[1];
    if (!rawRadius || match.index === undefined) continue;
    // Skip if this position was already emitted by the with-style pass
    if (emittedPositions.has(match.index)) continue;

    const radius = Number.parseFloat(rawRadius);
    const { line, col } = offsetToLineCol(match.index, lines);

    findings.push({
      category: "cornerRadius",
      sourcePath: filePath,
      line,
      col,
      declName: null,
      rawValue: match[0],
      normalizedValue: radius,
      context: "RoundedRectangle(cornerRadius:)",
      isDeclaration: false,
      shapeType: "rounded",
    });
  }

  return findings;
}

/**
 * Pass 3: `.clipShape(...)` — four sub-variants:
 *   a. `.clipShape(RoundedRectangle(cornerRadius: n))` — without style
 *   b. `.clipShape(RoundedRectangle(cornerRadius: n, style: .x))` — with style
 *   c. `.clipShape(Circle())`, `.clipShape(Capsule())`, `.clipShape(Ellipse())` — full-radius shapes
 *   d. `.clipShape(ContainerRelativeShape())` — adaptive shape
 *
 * Full-radius shapes emit: normalizedValue: null, shapeType as appropriate.
 * Adaptive shapes emit: normalizedValue: null, shapeType: "adaptive".
 */
function extractClipShapes(source: string, filePath: string): RawFinding[] {
  const findings: RawFinding[] = [];
  const lines = source.split("\n");

  // clipShape(RoundedRectangle(cornerRadius: n, style: .x))
  const clipRoundedWithStylePattern =
    /\.clipShape\(\s*RoundedRectangle\(\s*cornerRadius:\s*([\d]+(?:\.[\d]+)?)\s*,\s*style:\s*\.(continuous|circular)\s*\)\s*\)/g;

  // clipShape(RoundedRectangle(cornerRadius: n)) — no style
  const clipRoundedPattern =
    /\.clipShape\(\s*RoundedRectangle\(\s*cornerRadius:\s*([\d]+(?:\.[\d]+)?)\s*\)\s*\)/g;

  // clipShape(Circle()), clipShape(Capsule()), clipShape(Ellipse())
  const clipFullRadiusPattern = /\.clipShape\(\s*(Circle|Capsule|Ellipse)\(\s*\)\s*\)/g;

  // clipShape(ContainerRelativeShape())
  const clipAdaptivePattern = /\.clipShape\(\s*ContainerRelativeShape\(\s*\)\s*\)/g;

  const withStyleMatches = [...source.matchAll(clipRoundedWithStylePattern)];
  const emittedPositions = new Set<number>();

  for (const match of withStyleMatches) {
    const rawRadius = match[1];
    const style = match[2] as "continuous" | "circular";
    if (!rawRadius || match.index === undefined) continue;

    const radius = Number.parseFloat(rawRadius);
    const { line, col } = offsetToLineCol(match.index, lines);
    emittedPositions.add(match.index);

    findings.push({
      category: "cornerRadius",
      sourcePath: filePath,
      line,
      col,
      declName: null,
      rawValue: match[0],
      normalizedValue: radius,
      context: `.clipShape(RoundedRectangle(cornerRadius:style:.${style}))`,
      isDeclaration: false,
      shapeType: "rounded",
    });
  }

  for (const match of [...source.matchAll(clipRoundedPattern)]) {
    if (!match[1] || match.index === undefined) continue;
    if (emittedPositions.has(match.index)) continue;

    const radius = Number.parseFloat(match[1]);
    const { line, col } = offsetToLineCol(match.index, lines);

    findings.push({
      category: "cornerRadius",
      sourcePath: filePath,
      line,
      col,
      declName: null,
      rawValue: match[0],
      normalizedValue: radius,
      context: ".clipShape(RoundedRectangle(cornerRadius:))",
      isDeclaration: false,
      shapeType: "rounded",
    });
  }

  for (const match of [...source.matchAll(clipFullRadiusPattern)]) {
    const shapeName = match[1]?.toLowerCase() as "circle" | "capsule" | "ellipse";
    if (!shapeName || match.index === undefined) continue;

    const { line, col } = offsetToLineCol(match.index, lines);

    findings.push({
      category: "cornerRadius",
      sourcePath: filePath,
      line,
      col,
      declName: null,
      rawValue: match[0],
      normalizedValue: null,
      context: `.clipShape(${match[1]}())`,
      isDeclaration: false,
      shapeType: shapeName,
    });
  }

  for (const match of [...source.matchAll(clipAdaptivePattern)]) {
    if (match.index === undefined) continue;
    const { line, col } = offsetToLineCol(match.index, lines);

    findings.push({
      category: "cornerRadius",
      sourcePath: filePath,
      line,
      col,
      declName: null,
      rawValue: match[0],
      normalizedValue: null,
      context: ".clipShape(ContainerRelativeShape())",
      isDeclaration: false,
      shapeType: "adaptive",
    });
  }

  return findings;
}

/**
 * Pass 4: `UnevenRoundedRectangle(cornerRadii: .init(topLeading:bottomLeading:bottomTrailing:topTrailing:))`
 *
 * iOS 16+ API. Captures all four per-corner radii as a normalized object.
 * Values must all be numeric literals to be captured inline; non-literal args produce
 * `normalizedValue: null` and the raw snippet is recorded for LLM resolution.
 */
function extractUnevenRoundedRectangle(source: string, filePath: string): RawFinding[] {
  const findings: RawFinding[] = [];
  const lines = source.split("\n");

  // Match UnevenRoundedRectangle(cornerRadii: .init(...)) — flexible whitespace
  // The four labels may appear in any order; we capture the whole inner block.
  const outerPattern = /\bUnevenRoundedRectangle\(\s*cornerRadii:\s*\.init\(([^)]+)\)\s*\)/g;

  for (const match of [...source.matchAll(outerPattern)]) {
    const innerArgs = match[1];
    if (!innerArgs || match.index === undefined) continue;

    const { line, col } = offsetToLineCol(match.index, lines);

    const topLeading = extractNamedArg(innerArgs, "topLeading");
    const topTrailing = extractNamedArg(innerArgs, "topTrailing");
    const bottomLeading = extractNamedArg(innerArgs, "bottomLeading");
    const bottomTrailing = extractNamedArg(innerArgs, "bottomTrailing");

    // If all four corners are numeric literals, emit a structured normalizedValue.
    // If any is missing or non-numeric, emit null and let LLM resolve.
    const allNumeric =
      topLeading !== null &&
      topTrailing !== null &&
      bottomLeading !== null &&
      bottomTrailing !== null;

    const normalizedValue = allNumeric
      ? {
          topLeading: topLeading as number,
          topTrailing: topTrailing as number,
          bottomLeading: bottomLeading as number,
          bottomTrailing: bottomTrailing as number,
        }
      : null;

    findings.push({
      category: "cornerRadius",
      sourcePath: filePath,
      line,
      col,
      declName: null,
      rawValue: match[0],
      normalizedValue,
      context: "UnevenRoundedRectangle",
      isDeclaration: false,
      shapeType: "rounded",
    });
  }

  return findings;
}

/**
 * Pass 5: `extension View { func <name>() -> some View { <shape call> } }` — declaration forms.
 *
 * Finds named shape convenience methods inside `extension View` blocks. These are design
 * system declarations, not call-sites, so `isDeclaration: true` and `declName` is set.
 *
 * Strategy: find `extension View { ... }` blocks by regex (the AST maps extension→class_declaration
 * which is tricky to distinguish from real classes), then scan for shape calls inside each block.
 *
 * Only emits a finding for each function definition — does NOT re-emit the inner call-site
 * (the other passes already captured it as a call-site if it matches standalone patterns).
 */
function extractViewExtensionDeclarations(source: string, filePath: string): RawFinding[] {
  const findings: RawFinding[] = [];
  const lines = source.split("\n");

  // Find extension View { ... } blocks
  // We use a brace-counting approach to handle nested braces correctly.
  const extPattern = /\bextension\s+View\s*\{/g;

  for (const extMatch of [...source.matchAll(extPattern)]) {
    if (extMatch.index === undefined) continue;

    // Walk forward from the opening brace to find the balanced closing brace
    const blockStart = extMatch.index + extMatch[0].length - 1; // position of `{`
    const blockContent = extractBalancedBlock(source, blockStart);
    if (!blockContent) continue;

    // Within this block, find all `func <name>(...) -> some View { ... }` declarations
    const funcPattern = /\bfunc\s+(\w+)\s*\([^)]*\)\s*->\s*some\s+View\s*\{/g;

    for (const funcMatch of [...blockContent.matchAll(funcPattern)]) {
      const funcName = funcMatch[1];
      if (!funcName || funcMatch.index === undefined) continue;

      // The absolute offset of this func in the full source
      const funcOffset = blockStart + 1 + funcMatch.index;
      const funcBodyStart = funcOffset + funcMatch[0].length - 1; // position of `{`
      const funcBody = extractBalancedBlock(source, funcBodyStart);
      if (!funcBody) continue;

      // Classify which shape call (if any) the function body contains
      const shapeCall = classifyViewExtensionBody(funcBody);
      if (!shapeCall) continue;

      const { line, col } = offsetToLineCol(funcOffset, lines);

      findings.push({
        category: "cornerRadius",
        sourcePath: filePath,
        line,
        col,
        declName: funcName,
        rawValue: shapeCall.rawValue,
        normalizedValue: shapeCall.normalizedValue,
        context: shapeCall.context,
        isDeclaration: true,
        shapeType: shapeCall.shapeType,
      });
    }
  }

  return findings;
}

// === CLASSIFIERS & UTILITIES ===

interface ShapeCallClassification {
  readonly rawValue: string;
  readonly normalizedValue:
    | number
    | { topLeading: number; topTrailing: number; bottomLeading: number; bottomTrailing: number }
    | null;
  readonly context: string;
  readonly shapeType: "rounded" | "circle" | "capsule" | "ellipse" | "adaptive";
}

/**
 * Inspect a View-extension function body for the first recognizable shape call.
 * Returns null if no shape pattern is found (the function doesn't wrap a shape).
 */
function classifyViewExtensionBody(body: string): ShapeCallClassification | null {
  // clipShape(RoundedRectangle(cornerRadius: n, style: .x))
  const clipRRWithStyle =
    /clipShape\(\s*RoundedRectangle\(\s*cornerRadius:\s*([\d]+(?:\.[\d]+)?)\s*,\s*style:\s*\.(continuous|circular)\s*\)\s*\)/.exec(
      body,
    );
  if (clipRRWithStyle?.[1] && clipRRWithStyle[2]) {
    const style = clipRRWithStyle[2] as "continuous" | "circular";
    return {
      rawValue: clipRRWithStyle[0],
      normalizedValue: Number.parseFloat(clipRRWithStyle[1]),
      context: "extension View func",
      shapeType: "rounded",
    };
  }

  // clipShape(RoundedRectangle(cornerRadius: n))
  const clipRR =
    /clipShape\(\s*RoundedRectangle\(\s*cornerRadius:\s*([\d]+(?:\.[\d]+)?)\s*\)\s*\)/.exec(body);
  if (clipRR?.[1]) {
    return {
      rawValue: clipRR[0],
      normalizedValue: Number.parseFloat(clipRR[1]),
      context: "extension View func",
      shapeType: "rounded",
    };
  }

  // RoundedRectangle(cornerRadius: n, style: .x) standalone in body
  const rrWithStyle =
    /RoundedRectangle\(\s*cornerRadius:\s*([\d]+(?:\.[\d]+)?)\s*,\s*style:\s*\.(continuous|circular)\s*\)/.exec(
      body,
    );
  if (rrWithStyle?.[1] && rrWithStyle[2]) {
    return {
      rawValue: rrWithStyle[0],
      normalizedValue: Number.parseFloat(rrWithStyle[1]),
      context: "extension View func",
      shapeType: "rounded",
    };
  }

  // .cornerRadius(n) in body
  const cr = /\.cornerRadius\(\s*([\d]+(?:\.[\d]+)?)\s*\)/.exec(body);
  if (cr?.[1]) {
    return {
      rawValue: cr[0],
      normalizedValue: Number.parseFloat(cr[1]),
      context: "extension View func",
      shapeType: "rounded",
    };
  }

  // clipShape(Circle()) / Capsule() / Ellipse()
  const fullRadius = /clipShape\(\s*(Circle|Capsule|Ellipse)\(\s*\)\s*\)/.exec(body);
  if (fullRadius?.[1]) {
    const shapeName = fullRadius[1].toLowerCase() as "circle" | "capsule" | "ellipse";
    return {
      rawValue: fullRadius[0],
      normalizedValue: null,
      context: "extension View func",
      shapeType: shapeName,
    };
  }

  // clipShape(ContainerRelativeShape())
  if (/clipShape\(\s*ContainerRelativeShape\(\s*\)\s*\)/.test(body)) {
    return {
      rawValue: "clipShape(ContainerRelativeShape())",
      normalizedValue: null,
      context: "extension View func",
      shapeType: "adaptive",
    };
  }

  return null;
}

/**
 * Extract a named argument value (as a number) from a `.init(label: value, ...)` argument string.
 * Returns null if the label is absent or the value is not a plain numeric literal.
 */
function extractNamedArg(args: string, label: string): number | null {
  const pattern = new RegExp(`\\b${label}:\\s*(\\d+(?:\\.\\d+)?)`, "g");
  const match = pattern.exec(args);
  if (!match?.[1]) return null;
  return Number.parseFloat(match[1]);
}

/**
 * Extract the content of a `{ ... }` block at the given position (position must be the `{`).
 * Returns the inner content (excluding the braces) or null if balance is not found.
 */
function extractBalancedBlock(source: string, openBracePos: number): string | null {
  if (source[openBracePos] !== "{") return null;

  let depth = 0;
  let i = openBracePos;
  while (i < source.length) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) {
        return source.slice(openBracePos + 1, i);
      }
    }
    i++;
  }
  return null; // unbalanced
}

/**
 * Convert a byte-offset in source to a 1-based line number and 0-based column.
 */
function offsetToLineCol(offset: number, lines: string[]): { line: number; col: number } {
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

/**
 * Deduplicate findings that originated from the same source position and same pattern.
 *
 * The View-extension pass and the general call-site passes may both emit for the same
 * `.clipShape(RoundedRectangle(...))` call inside an `extension View` body.
 * We keep the `isDeclaration: true` finding (from Pass 5) and drop the call-site duplicate.
 */
function deduplicateFindings(findings: RawFinding[]): RawFinding[] {
  const seen = new Map<string, RawFinding>();

  for (const finding of findings) {
    const key = `${finding.sourcePath}:${finding.line}:${finding.col}`;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, finding);
    } else if (finding.isDeclaration && !existing.isDeclaration) {
      // Prefer the declaration finding when both land on the same position
      seen.set(key, finding);
    }
  }

  return [...seen.values()];
}

/**
 * Normalize a file path for storage in findings.
 * Stores as-is; the CLI normalizes relative to --path at extraction time.
 */
function normalizeFilePath(filePath: string): string {
  return path.normalize(filePath);
}
