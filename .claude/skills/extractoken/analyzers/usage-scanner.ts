/**
 * analyzers/usage-scanner.ts
 *
 * Regex side-channel pass: finds hex color literals at call sites across all
 * .swift files. These are drift candidates — inline hex values that don't
 * correspond to a declared token.
 *
 * Merges results into the findings array as non-declaration findings so the
 * audit report can flag them as magic numbers.
 *
 * === PATTERNS ===
 *
 * Primary: /#([0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})\b/g
 *
 * This deliberately does NOT catch hex values inside string literals that are
 * being parsed by Color(hex:) — those are handled by the AST parser. The regex
 * targets bare hex literals that appear in other contexts (e.g. UIColor, custom
 * Color(hex:) init calls at call sites, or left-over UIKit hex helpers).
 */

import fs from "node:fs";
import type { RawFinding } from "../parsers/types.js";

// === PUBLIC API ===

export interface UsageScanResult {
  readonly hexFindings: readonly RawFinding[];
  readonly totalFilesScanned: number;
}

/**
 * Scan a list of Swift source files for hex color literals.
 *
 * @param filePaths  Absolute paths to .swift files to scan
 * @param repoRoot   Repository root — used to relativize source paths in findings
 */
export function scanHexLiterals(filePaths: readonly string[], repoRoot: string): UsageScanResult {
  const hexFindings: RawFinding[] = [];
  let totalFilesScanned = 0;

  for (const filePath of filePaths) {
    let source: string;
    try {
      source = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue; // Skip unreadable files
    }

    totalFilesScanned++;
    const fileFindings = scanFileForHexLiterals(source, filePath, repoRoot);
    hexFindings.push(...fileFindings);
  }

  return { hexFindings, totalFilesScanned };
}

// === PRIVATE HELPERS ===

/** Regex for 6-digit or 8-digit hex color literals */
const HEX_COLOR_REGEX = /#([0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})\b/g;

function scanFileForHexLiterals(source: string, filePath: string, repoRoot: string): RawFinding[] {
  const findings: RawFinding[] = [];
  const lines = source.split("\n");
  const relativePath = toRelativePath(filePath, repoRoot);

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx] ?? "";

    // Skip comment lines (single-line comments)
    if (line.trimStart().startsWith("//")) continue;

    // Find all hex literals on this line
    const hexMatches = [...line.matchAll(HEX_COLOR_REGEX)];
    for (const match of hexMatches) {
      const fullHex = match[0]; // e.g. "#1A88FF"
      const hexDigits = match[1]; // e.g. "1A88FF"
      if (!hexDigits || match.index === undefined) continue;

      // Check if this is inside a string literal (declaration-site hex handled by AST parser)
      // Simple heuristic: if preceded by `hex: "` or `"#`, skip — the color parser already found it
      const precedingText = line.slice(0, match.index);
      if (/hex:\s*"$/.test(precedingText) || /"$/.test(precedingText)) {
        continue;
      }

      const normalizedValue = parseHexToNormalized(hexDigits);

      findings.push({
        category: "color",
        sourcePath: relativePath,
        line: lineIdx + 1,
        col: match.index,
        declName: null, // Not a declaration
        rawValue: fullHex,
        normalizedValue,
        context: "hex literal call site",
        isDeclaration: false,
        severity: "info",
      });
    }
  }

  return findings;
}

/** Convert hex digits to normalized [0,1] components */
function parseHexToNormalized(hex: string): import("../parsers/types.js").NormalizedColor | null {
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

function toRelativePath(absolutePath: string, repoRoot: string): string {
  if (absolutePath.startsWith(repoRoot)) {
    return absolutePath.slice(repoRoot.length).replace(/^\//, "");
  }
  return absolutePath;
}
