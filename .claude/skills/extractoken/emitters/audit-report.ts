/**
 * emitters/audit-report.ts
 *
 * Generates audit.md from deterministic findings. Slice 3: all categories.
 *
 * Sections per PRD §7.3:
 *   1. Magic Numbers (hex literals at call sites with no matching declaration)
 *   2. Near-Duplicate Values (color clusters; numeric clusters for spacing/radius)
 *   3. Orphaned Tokens (declared tokens with no call-site usage)
 *   4. Off-Scale Values (spacing/cornerRadius drift from 4/8 scale)
 *   5. Liquid Glass Violations (glass on content-layer components)
 *   6. Harmonization Recommendations (from LLM harmonize pass + color clusters)
 *   7. Changes since last extraction (diff section, if previous tokens.json exists)
 *
 * Tone: suggestions only. Never auto-apply. Every finding includes file:line.
 */

import fs from "node:fs";
import path from "node:path";
import type { ColorCluster } from "../analyzers/cluster-color.js";
import type { NumericCluster } from "../analyzers/cluster-numeric.js";
import type { DriftFinding } from "../analyzers/drift-detector.js";
import type { HarmonizeRecommendation } from "../llm/merge.js";
import type { RawFinding } from "../parsers/types.js";

// === PUBLIC API ===

export interface AuditReportOptions {
  readonly outputDir: string;
  readonly repoPath: string;
  readonly extractedAt: string;
}

export interface AuditData {
  /** All findings across all categories */
  readonly allFindings: readonly RawFinding[];
  readonly colorClusters: readonly ColorCluster[];
  readonly numericClusters: readonly NumericCluster[];
  readonly driftFindings: readonly DriftFinding[];
  readonly driftByCategory: Readonly<Record<string, readonly DriftFinding[]>>;
  readonly unresolvedTokens: readonly {
    readonly rawValue: string;
    readonly sourcePath: string;
    readonly line: number;
    readonly reason: string;
  }[];
  /** LLM harmonize recommendations (may be empty if harmonize pass not run) */
  readonly harmonizeRecommendations: readonly HarmonizeRecommendation[];
  /** Pre-formatted diff markdown block (or null if no previous run) */
  readonly diffMarkdown: string | null;
}

/**
 * Generate audit.md from deterministic findings.
 */
export function emitAuditReport(data: AuditData, options: AuditReportOptions): string {
  const declarationFindings = data.allFindings.filter((f) => f.isDeclaration);
  const callSiteFindings = data.allFindings.filter((f) => !f.isDeclaration);
  const colorDeclarations = declarationFindings.filter((f) => f.category === "color");
  const colorCallSites = callSiteFindings.filter((f) => f.category === "color");

  const sections: string[] = [];

  sections.push(buildHeader(options));
  sections.push(buildMagicNumbersSection(colorCallSites, colorDeclarations, data.allFindings));
  sections.push(buildNearDuplicatesSection(data.colorClusters, data.numericClusters));
  sections.push(buildOrphanedTokensSection(declarationFindings, callSiteFindings));
  sections.push(buildOffScaleSection(data.driftByCategory));
  sections.push(buildLiquidGlassSection(data.allFindings));
  sections.push(buildHarmonizationSection(data.colorClusters, data.harmonizeRecommendations));
  sections.push(buildComponentsSection(data.allFindings));

  if (data.diffMarkdown) {
    sections.push(data.diffMarkdown);
  }

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
  colorCallSites: readonly RawFinding[],
  colorDeclarations: readonly RawFinding[],
  allFindings: readonly RawFinding[],
): string {
  // Colors: hex literals at call sites without a matching declaration
  const declaredValues = new Set<string>(
    colorDeclarations
      .filter((f) => f.normalizedValue !== null)
      .map((f) => normalizedColorKey(f.normalizedValue as NormalizedColorLike)),
  );

  const magicColors = colorCallSites.filter((f) => {
    if (!f.normalizedValue) return false;
    const key = normalizedColorKey(f.normalizedValue as NormalizedColorLike);
    return !declaredValues.has(key);
  });

  const lines: string[] = ["## 1. Magic Numbers"];

  // Colors subsection
  if (magicColors.length === 0) {
    lines.push("\n### Colors\n\n_No magic number hex literals detected._");
  } else {
    const grouped = new Map<string, RawFinding[]>();
    for (const finding of magicColors) {
      const key = finding.rawValue;
      const existing = grouped.get(key) ?? [];
      existing.push(finding);
      grouped.set(key, existing);
    }

    lines.push("\n### Colors");
    lines.push("| Value | Occurrences | Example location |");
    lines.push("|---|---|---|");

    for (const [value, findings] of grouped) {
      const example = findings[0];
      if (!example) continue;
      lines.push(
        `| \`${value}\` | ${findings.length} | \`${example.sourcePath}:${example.line}\` |`,
      );
    }

    lines.push(
      "\n> Hex literals at call sites without a matching declared token. " +
        "Consider defining these as named tokens in a Color extension.",
    );
  }

  // Spacing subsection: numeric literals in spacing modifiers without a matching declaration
  const spacingDecls = allFindings.filter((f) => f.category === "spacing" && f.isDeclaration);
  const spacingCallSites = allFindings.filter((f) => f.category === "spacing" && !f.isDeclaration);

  const declaredSpacing = new Set<number>(
    spacingDecls
      .filter((f) => typeof f.normalizedValue === "number")
      .map((f) => f.normalizedValue as number),
  );

  const magicSpacing = spacingCallSites.filter(
    (f) =>
      typeof f.normalizedValue === "number" && !declaredSpacing.has(f.normalizedValue as number),
  );

  if (magicSpacing.length > 0) {
    lines.push("\n### Spacing");
    lines.push("| Value | Occurrences | Example location |");
    lines.push("|---|---|---|");

    const grouped = new Map<number, RawFinding[]>();
    for (const f of magicSpacing) {
      const v = f.normalizedValue as number;
      const existing = grouped.get(v) ?? [];
      existing.push(f);
      grouped.set(v, existing);
    }

    for (const [value, findings] of grouped) {
      const example = findings[0];
      if (!example) continue;
      lines.push(
        `| \`${value}px\` | ${findings.length} | \`${example.sourcePath}:${example.line}\` |`,
      );
    }

    lines.push(
      "\n> Numeric spacing literals used directly without a matching spacing token declaration.",
    );
  }

  return lines.join("\n");
}

function buildNearDuplicatesSection(
  colorClusters: readonly ColorCluster[],
  numericClusters: readonly NumericCluster[],
): string {
  const lines: string[] = ["## 2. Near-Duplicate Values"];
  let hasContent = false;

  // Colors
  if (colorClusters.length === 0) {
    lines.push(
      "\n### Colors\n\n_No near-duplicate colors detected (all values unique within ΔE threshold)._",
    );
  } else {
    lines.push(`\n### Colors (ΔE < ${colorClusters[0]?.deltaEThreshold ?? 2.5})`);
    hasContent = true;

    for (let i = 0; i < colorClusters.length; i++) {
      const cluster = colorClusters[i];
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
  }

  // Numeric clusters (spacing + cornerRadius + shadow radius)
  const numericWithMultiple = numericClusters.filter((c) => c.members.length >= 2);
  if (numericWithMultiple.length > 0) {
    lines.push("\n### Numeric (Spacing / Corner Radius / Shadow)");
    lines.push("| Scale slot | Count | Values |");
    lines.push("|---|---|---|");

    for (const cluster of numericWithMultiple) {
      const uniqueValues = [...new Set(cluster.members.map((m) => m.value))].sort((a, b) => a - b);
      const valueStr = uniqueValues.slice(0, 5).join(", ") + (uniqueValues.length > 5 ? "…" : "");
      lines.push(
        `| \`${cluster.scaleName}\` (${cluster.scaleValue}px) | ${cluster.members.length} | ${valueStr} |`,
      );
    }

    hasContent = true;
  } else if (numericClusters.length === 0 && colorClusters.length === 0) {
    lines.push("\n_No numeric clusters detected._");
  }

  void hasContent;
  return lines.join("\n");
}

function buildOrphanedTokensSection(
  declarationFindings: readonly RawFinding[],
  callSiteFindings: readonly RawFinding[],
): string {
  // Build set of referenced names from call sites
  const referencedNames = new Set<string>();

  for (const finding of callSiteFindings) {
    const colorRefMatch = /Color\.(\w+)|\.(\w+)/.exec(finding.rawValue);
    if (colorRefMatch) {
      const name = colorRefMatch[1] ?? colorRefMatch[2];
      if (name) referencedNames.add(name);
    }
    // Also capture simple identifier references (typography, spacing enum refs)
    const identMatch = /\b([A-Za-z_]\w+)\b/.exec(finding.rawValue);
    if (identMatch?.[1]) referencedNames.add(identMatch[1]);
  }

  // Cross-references within declarations
  for (const finding of declarationFindings) {
    const refs = [...finding.rawValue.matchAll(/Color\.(\w+)|\.(\w+)/g)];
    for (const m of refs) {
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
    "| Token | Category | Definition | Note |",
    "|---|---|---|---|",
  ];

  for (const finding of orphaned) {
    rows.push(
      `| \`${finding.declName ?? "unknown"}\` | ${finding.category} | \`${finding.sourcePath}:${finding.line}\` | No call-site references found in scanned files |`,
    );
  }

  return rows.join("\n");
}

function buildOffScaleSection(
  driftByCategory: Readonly<Record<string, readonly DriftFinding[]>>,
): string {
  const categories = Object.keys(driftByCategory);
  if (categories.length === 0) {
    return "## 4. Off-Scale Values\n\n_No off-scale numeric literals detected._";
  }

  const lines: string[] = ["## 4. Off-Scale Values"];
  lines.push(
    "\nValues that don't align to the canonical 4/8 scale (xs=4, sm=8, md=16, lg=24, xl=32, 2xl=48).\n",
  );

  for (const category of categories) {
    const driftFindings = driftByCategory[category];
    if (!driftFindings || driftFindings.length === 0) continue;

    lines.push(`\n### ${category}`);
    lines.push("| Value | Nearest scale | Delta | Location |");
    lines.push("|---|---|---|---|");

    for (const drift of driftFindings.slice(0, 20)) {
      lines.push(
        `| ${drift.value}px | ${drift.nearestScaleName} (${drift.nearestScaleValue}px) | ${drift.delta}px | \`${drift.finding.sourcePath}:${drift.finding.line}\` |`,
      );
    }

    if (driftFindings.length > 20) {
      lines.push(`\n_...and ${driftFindings.length - 20} more off-scale values in this category._`);
    }
  }

  return lines.join("\n");
}

function buildLiquidGlassSection(allFindings: readonly RawFinding[]): string {
  const glassFindings = allFindings.filter((f) => f.category === "liquidGlass");

  if (glassFindings.length === 0) {
    return "## 5. Liquid Glass Usage\n\n_No Liquid Glass (.glassEffect) usage detected._";
  }

  const violations = glassFindings.filter((f) => f.severity === "warning");
  const okUsage = glassFindings.filter((f) => f.severity !== "warning");

  const lines: string[] = ["## 5. Liquid Glass Usage"];

  if (violations.length > 0) {
    lines.push("\n### Content-layer violations (Apple HIG — navigation layer only)");
    lines.push("| Location | Usage | Guidance |");
    lines.push("|---|---|---|");

    for (const finding of violations) {
      lines.push(
        `| \`${finding.sourcePath}:${finding.line}\` | \`${finding.rawValue.slice(0, 60)}\` | Move glass to navigation layer only (TabBar, NavigationBar, toolbars) |`,
      );
    }

    lines.push(
      "\n> Apple's design guidance reserves `.glassEffect()` for the navigation layer. " +
        "Applying it to content containers (cards, lists, media) is an anti-pattern.",
    );
  }

  if (okUsage.length > 0) {
    lines.push(
      `\n### Acceptable usage (${okUsage.length} instance${okUsage.length === 1 ? "" : "s"})`,
    );
    for (const finding of okUsage.slice(0, 10)) {
      lines.push(
        `- \`${finding.sourcePath}:${finding.line}\` — ${finding.context ?? "glass usage"}`,
      );
    }
    if (okUsage.length > 10) {
      lines.push(`_...and ${okUsage.length - 10} more._`);
    }
  }

  return lines.join("\n");
}

function buildHarmonizationSection(
  colorClusters: readonly ColorCluster[],
  harmonizeRecommendations: readonly HarmonizeRecommendation[],
): string {
  const hasLlmRecommendations = harmonizeRecommendations.length > 0;
  const hasClusters = colorClusters.length > 0;

  if (!hasLlmRecommendations && !hasClusters) {
    return (
      "## 6. Harmonization Recommendations\n\n" +
      "_No harmonization recommendations — all color values appear distinct (ΔE ≥ threshold)._"
    );
  }

  const rows: string[] = ["## 6. Harmonization Recommendations"];

  // LLM harmonize recommendations take precedence
  if (hasLlmRecommendations) {
    rows.push("\n### LLM-Generated Recommendations");
    rows.push("| # | Confidence | Recommendation | Canonical Token | Source refs |");
    rows.push("|---|---|---|---|---|");

    for (let i = 0; i < harmonizeRecommendations.length; i++) {
      const rec = harmonizeRecommendations[i];
      if (!rec) continue;
      const refs = rec.sourceRefs.slice(0, 2).join(", ");
      const moreRefs = rec.sourceRefs.length > 2 ? ` +${rec.sourceRefs.length - 2} more` : "";
      rows.push(
        `| ${i + 1} | ${rec.confidence} | ${rec.recommendation} | \`${rec.canonicalToken.name}\` | ${refs}${moreRefs} |`,
      );
    }
  }

  // Deterministic cluster recommendations as a supplement
  if (hasClusters) {
    rows.push(hasLlmRecommendations ? "\n### Deterministic Cluster Analysis" : "");
    if (!hasLlmRecommendations) {
      rows.push("| # | Confidence | Recommendation | Locations |");
      rows.push("|---|---|---|---|");
    } else {
      rows.push("| Cluster | Members | Proposed canonical | Locations |");
      rows.push("|---|---|---|---|");
    }

    for (let i = 0; i < colorClusters.length; i++) {
      const cluster = colorClusters[i];
      if (!cluster) continue;

      const canonical = cluster.proposedCanonical;
      const canonicalName = canonical.declName ?? canonical.rawValue;
      const memberCount = cluster.members.length;

      if (!hasLlmRecommendations) {
        const confidence = memberCount >= 3 ? "High" : memberCount === 2 ? "Medium" : "Low";
        const locations = cluster.members
          .slice(0, 3)
          .map((m) => `\`${m.sourcePath}:${m.line}\``)
          .join(", ");
        const moreLocations =
          cluster.members.length > 3 ? ` +${cluster.members.length - 3} more` : "";
        rows.push(
          `| ${i + 1} | ${confidence} | ` +
            `Merge ${memberCount} near-identical colors into \`${canonicalName}\` | ` +
            `${locations}${moreLocations} |`,
        );
      } else {
        const locations = cluster.members
          .slice(0, 2)
          .map((m) => `\`${m.sourcePath}:${m.line}\``)
          .join(", ");
        rows.push(
          `| Cluster ${String.fromCharCode(65 + i)} | ${memberCount} | \`${canonicalName}\` | ${locations} |`,
        );
      }
    }
  }

  return rows.join("\n");
}

function buildComponentsSection(allFindings: readonly RawFinding[]): string {
  const componentFindings = allFindings.filter(
    (f) => f.category === "component" && f.isDeclaration,
  );

  if (componentFindings.length === 0) {
    return "## 8. Components\n\n_No component declarations detected._";
  }

  const high = componentFindings.filter((f) => f.componentConfidence === "high");
  const medium = componentFindings.filter((f) => f.componentConfidence === "medium");

  const lines: string[] = ["## 8. Components"];

  // Strict (high confidence) — ButtonStyle / ViewModifier / PrimitiveButtonStyle + extension View wrappers
  if (high.length === 0) {
    lines.push(
      "\n### Strict (high confidence)\n\n_No ButtonStyle / ViewModifier conformances found._",
    );
  } else {
    lines.push("\n### Strict (high confidence)");
    lines.push(
      "_ButtonStyle, ViewModifier, PrimitiveButtonStyle conformances and extension View wrappers._\n",
    );
    for (const f of high) {
      const protocol = f.context ?? "component";
      lines.push(`- \`${f.declName ?? "unknown"}\` (${protocol}) — \`${f.sourcePath}:${f.line}\``);
    }
  }

  // Likely (medium confidence) — name keyword or init signal
  if (medium.length === 0) {
    lines.push(
      "\n### Likely (medium confidence — name/init signal)\n\n_No likely components found._",
    );
  } else {
    lines.push("\n### Likely (medium confidence — name/init signal)");
    lines.push(
      "_Custom View structs with a component-keyword name, `configuration.label` body, or `@Binding` / typed init._\n",
    );
    for (const f of medium) {
      lines.push(
        `- \`${f.declName ?? "unknown"}\` (custom View, name/init match) — \`${f.sourcePath}:${f.line}\``,
      );
    }
    if (medium.length > 50) {
      lines.push(
        `\n_Showing all ${medium.length} likely components. Run with \`--include-likely-components\` to also surface low-confidence custom Views._`,
      );
    }
  }

  return lines.join("\n");
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
