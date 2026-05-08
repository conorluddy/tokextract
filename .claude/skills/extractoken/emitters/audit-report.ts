/**
 * emitters/audit-report.ts
 *
 * Generates audit.md from deterministic findings. Color-relevant sections only in Slice 1.
 *
 * Sections per PRD §7.3:
 *   1. Magic Numbers (hex literals at call sites with no matching declaration)
 *   2. Near-Duplicate Values (color clusters from analyzers/cluster-color.ts)
 *   3. Orphaned Tokens (declared tokens with no call-site usage)
 *   4. Harmonization Recommendations (derived from clusters)
 *
 * Slice 3 will add: Off-Scale Literals, Contrast Warnings, Liquid Glass Violations.
 * Those sections are stubbed here if data is absent.
 *
 * Tone: suggestions only. Never auto-apply. Every finding includes file:line.
 */

import fs from "node:fs";
import path from "node:path";
import type { ColorCluster } from "../analyzers/cluster-color.js";
import type { RawFinding } from "../parsers/types.js";

// === PUBLIC API ===

export interface AuditReportOptions {
  readonly outputDir: string;
  readonly repoPath: string;
  readonly extractedAt: string;
}

export interface AuditData {
  readonly declarationFindings: readonly RawFinding[];
  readonly callSiteFindings: readonly RawFinding[];
  readonly colorClusters: readonly ColorCluster[];
  readonly unresolvedTokens: readonly {
    readonly rawValue: string;
    readonly sourcePath: string;
    readonly line: number;
    readonly reason: string;
  }[];
}

/**
 * Generate audit.md from deterministic findings.
 */
export function emitAuditReport(data: AuditData, options: AuditReportOptions): string {
  const sections: string[] = [];

  sections.push(buildHeader(options));
  sections.push(buildMagicNumbersSection(data.callSiteFindings, data.declarationFindings));
  sections.push(buildNearDuplicatesSection(data.colorClusters));
  sections.push(buildOrphanedTokensSection(data.declarationFindings, data.callSiteFindings));
  sections.push(buildHarmonizationSection(data.colorClusters));

  const content = sections.join("\n\n");
  const auditPath = path.join(options.outputDir, "audit.md");
  fs.mkdirSync(options.outputDir, { recursive: true });
  fs.writeFileSync(auditPath, `${content}\n`, "utf-8");

  return auditPath;
}

// === SECTION BUILDERS ===

function buildHeader(options: AuditReportOptions): string {
  const date = options.extractedAt.slice(0, 10);
  return `# Design System Audit\nGenerated: ${date} | Source: ${options.repoPath}`;
}

function buildMagicNumbersSection(
  callSiteFindings: readonly RawFinding[],
  declarationFindings: readonly RawFinding[],
): string {
  // Magic numbers = hex literals at call sites that don't correspond to any declaration
  const declaredValues = new Set<string>(
    declarationFindings
      .filter((f) => f.normalizedValue !== null)
      .map((f) => normalizedColorKey(f.normalizedValue as NormalizedColorLike)),
  );

  const magicNumbers = callSiteFindings.filter((f) => {
    if (!f.normalizedValue) return false;
    const key = normalizedColorKey(f.normalizedValue as NormalizedColorLike);
    return !declaredValues.has(key);
  });

  if (magicNumbers.length === 0) {
    return "## 1. Magic Numbers\n\n_No magic number hex literals detected._";
  }

  // Group by hex value
  const grouped = new Map<string, RawFinding[]>();
  for (const finding of magicNumbers) {
    const key = finding.rawValue;
    const existing = grouped.get(key) ?? [];
    existing.push(finding);
    grouped.set(key, existing);
  }

  const rows: string[] = [
    "## 1. Magic Numbers",
    "### Colors",
    "| Value | Occurrences | Example location |",
    "|---|---|---|",
  ];

  for (const [value, findings] of grouped) {
    const example = findings[0];
    if (!example) continue;
    rows.push(`| \`${value}\` | ${findings.length} | \`${example.sourcePath}:${example.line}\` |`);
  }

  if (grouped.size > 0) {
    rows.push(
      "\n> Hex literals found at call sites without a matching declared token. " +
        "Consider defining these as named tokens in a Color extension.",
    );
  }

  return rows.join("\n");
}

function buildNearDuplicatesSection(clusters: readonly ColorCluster[]): string {
  if (clusters.length === 0) {
    return "## 2. Near-Duplicate Values\n\n_No near-duplicate colors detected (all values unique within ΔE threshold)._";
  }

  const lines: string[] = [
    "## 2. Near-Duplicate Values",
    `### Colors (ΔE < ${clusters[0]?.deltaEThreshold ?? 2.5})`,
  ];

  for (let i = 0; i < clusters.length; i++) {
    const cluster = clusters[i];
    if (!cluster) continue;

    const canonical = cluster.proposedCanonical;
    const canonicalName = canonical.declName ?? canonical.rawValue;
    const canonicalHex = toHexString(canonical.normalizedValue as NormalizedColorLike | null);

    lines.push(
      `\n**Cluster ${String.fromCharCode(65 + i)}** — near-duplicate group ` +
        `(proposed canonical: \`${canonicalName}\`${canonicalHex ? ` = \`${canonicalHex}\`` : ""})`,
    );

    for (const member of cluster.members) {
      const hex = toHexString(member.normalizedValue as NormalizedColorLike | null);
      const name = member.declName
        ? `\`${member.declName}\``
        : hex
          ? `\`${hex}\``
          : member.rawValue;
      lines.push(`- ${name} — \`${member.sourcePath}:${member.line}\``);
    }

    lines.push(`  _Max ΔE within cluster: ${cluster.deltaEMax.toFixed(2)}_`);
  }

  return lines.join("\n");
}

function buildOrphanedTokensSection(
  declarationFindings: readonly RawFinding[],
  callSiteFindings: readonly RawFinding[],
): string {
  // Build set of referenced token names from call sites
  // Simple heuristic: look for `.declName` references in call site raw values
  const referencedNames = new Set<string>();

  for (const finding of callSiteFindings) {
    // Raw values like `Color.brandPrimary` or `.accent` reference token names
    const colorRefMatch = /Color\.(\w+)|\.(\w+)/.exec(finding.rawValue);
    if (colorRefMatch) {
      const name = colorRefMatch[1] ?? colorRefMatch[2];
      if (name) referencedNames.add(name);
    }
  }

  // Also check declaration finding raw values for cross-references
  for (const finding of declarationFindings) {
    const colorRefMatches = [...finding.rawValue.matchAll(/Color\.(\w+)|\.(\w+)/g)];
    for (const m of colorRefMatches) {
      const name = m[1] ?? m[2];
      if (name) referencedNames.add(name);
    }
  }

  const orphaned = declarationFindings.filter(
    (f) => f.declName !== null && !referencedNames.has(f.declName),
  );

  if (orphaned.length === 0) {
    return "## 3. Orphaned Tokens\n\n_No orphaned tokens detected (all declared tokens are referenced)._";
  }

  const rows: string[] = [
    "## 3. Orphaned Tokens",
    "| Token | Definition | Note |",
    "|---|---|---|",
  ];

  for (const finding of orphaned) {
    rows.push(
      `| \`${finding.declName ?? "unknown"}\` | \`${finding.sourcePath}:${finding.line}\` | No call-site references found in scanned files |`,
    );
  }

  return rows.join("\n");
}

function buildHarmonizationSection(clusters: readonly ColorCluster[]): string {
  if (clusters.length === 0) {
    return (
      "## 4. Harmonization Recommendations\n\n" +
      "_No harmonization recommendations — all color values appear distinct (ΔE ≥ threshold)._"
    );
  }

  const rows: string[] = [
    "## 4. Harmonization Recommendations",
    "| # | Confidence | Recommendation | Locations |",
    "|---|---|---|---|",
  ];

  for (let i = 0; i < clusters.length; i++) {
    const cluster = clusters[i];
    if (!cluster) continue;

    const canonical = cluster.proposedCanonical;
    const canonicalName = canonical.declName ?? canonical.rawValue;
    const memberCount = cluster.members.length;
    const confidence = memberCount >= 3 ? "High" : memberCount === 2 ? "Medium" : "Low";

    const locations = cluster.members
      .slice(0, 3)
      .map((m) => `\`${m.sourcePath}:${m.line}\``)
      .join(", ");
    const moreLocations = cluster.members.length > 3 ? ` +${cluster.members.length - 3} more` : "";

    rows.push(
      `| ${i + 1} | ${confidence} | ` +
        `Merge ${memberCount} near-identical colors into \`${canonicalName}\` | ` +
        `${locations}${moreLocations} |`,
    );
  }

  return rows.join("\n");
}

// === UTILITIES ===

interface NormalizedColorLike {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

function normalizedColorKey(color: NormalizedColorLike | null | undefined): string {
  if (!color) return "null";
  const r = Math.round(color.r * 255);
  const g = Math.round(color.g * 255);
  const b = Math.round(color.b * 255);
  const a = Math.round(color.a * 255);
  return `${r},${g},${b},${a}`;
}

function toHexString(color: NormalizedColorLike | null | undefined): string | null {
  if (!color) return null;
  const r = Math.round(color.r * 255)
    .toString(16)
    .padStart(2, "0");
  const g = Math.round(color.g * 255)
    .toString(16)
    .padStart(2, "0");
  const b = Math.round(color.b * 255)
    .toString(16)
    .padStart(2, "0");
  return `#${r}${g}${b}`.toUpperCase();
}
