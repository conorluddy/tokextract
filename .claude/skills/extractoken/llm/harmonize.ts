/**
 * llm/harmonize.ts
 *
 * Generates the harmonize prompt file and appends an LlmTask to the manifest.
 *
 * The harmonize pass reviews color clusters from the deterministic analyzer and
 * proposes canonical token names for each cluster of near-duplicate colors.
 *
 * Contract (Slice 1.5):
 * - Inline clusters.json directly (pre-aggregated; typically 5-50 clusters × ≤10 members
 *   each — stays well under 5KB even on large repos).
 * - Subagent writes HarmonizeRecommendation[] to responsePath via the Write tool.
 * - Subagent replies "done" after writing.
 */

import fs from "node:fs";
import path from "node:path";
import type { LlmTask } from "../parsers/types.js";

// === PUBLIC API ===

export interface HarmonizeOptions {
  readonly outputDir: string;
  readonly model: string;
  readonly clusters: unknown; // parsed clusters.json content (pre-aggregated, small)
  readonly llmTasks: LlmTask[]; // mutable — harmonize task is appended
}

/**
 * Write the harmonize prompt file and append an LlmTask to llmTasks.
 * Returns the path to the written prompt file.
 */
export function writeHarmonizeManifest(options: HarmonizeOptions): string {
  const promptsDir = path.join(options.outputDir, ".extractoken", "prompts");
  const llmOutDir = path.join(options.outputDir, ".extractoken", "llm-out");

  fs.mkdirSync(promptsDir, { recursive: true });
  fs.mkdirSync(llmOutDir, { recursive: true });

  const promptPath = path.join(promptsDir, "harmonize.md");
  const responsePath = path.join(llmOutDir, "mapping.harmonize.json");
  const responseSchema = path.join(
    path.dirname(new URL(import.meta.url).pathname),
    "..",
    "schemas",
    "harmonize-recommendations.json",
  );

  const promptContent = buildHarmonizePrompt({ clusters: options.clusters, responsePath });
  fs.writeFileSync(promptPath, promptContent, "utf-8");

  const status = isTaskDone(responsePath) ? "done" : "pending";

  options.llmTasks.push({
    id: "harmonize",
    pass: "harmonize",
    recommendedModel: options.model,
    promptPath,
    responsePath,
    responseSchema,
    status,
  });

  return promptPath;
}

// === TYPES ===

/** Slim summary of a single cluster for prompt inlining — subset of ColorCluster shape */
interface ClusterSummary {
  readonly id: string;
  readonly memberCount: number;
  readonly deltaEMax: number;
  readonly proposed: string;
  readonly sourceRefs: string[]; // "sourcePath:line" for each member
  readonly rawValues: string[]; // rawValue for each member (for LLM context)
}

// === PROMPT BUILDER ===

interface HarmonizePromptOptions {
  readonly clusters: unknown;
  readonly responsePath: string;
}

function buildHarmonizePrompt(opts: HarmonizePromptOptions): string {
  // Slim down clusters to just the fields the LLM needs — strips full RawFinding blobs
  const summaries = buildClusterSummaries(opts.clusters);
  // Compact JSON — stays well under 5KB for up to 50 clusters
  const clustersJson = JSON.stringify(summaries);

  return `# Extractoken — Color Cluster Harmonization

## Your task

You are reviewing color clusters from a SwiftUI design system. For each cluster of
near-duplicate colors, propose a canonical token name and explain why.

## Input — color clusters

The following clusters were produced by a CIEDE2000 distance analysis. Each cluster
contains near-duplicate color values found across the codebase.

\`\`\`json
${clustersJson}
\`\`\`

## Output schema

Write a JSON array of \`HarmonizeRecommendation\` objects to \`${opts.responsePath}\` using the Write tool.
Each object must match this shape exactly:

\`\`\`ts
interface HarmonizeRecommendation {
  clusterID: string;            // matches a cluster ID from the clusters above
  recommendation: string;       // 1-2 sentences explaining the consolidation rationale
  canonicalToken: {
    name: string;               // e.g. "color.semantic.surface.elevated"
    group: "primitive" | "semantic" | "component";
    description: string;        // 1-line intent
  };
  confidence: "high" | "medium" | "low";
  sourceRefs: string[];         // ["fileA:lineN", "fileB:lineM", ...]
}
\`\`\`

## Naming rules

- Format: \`color.<group>.<kebab-slug>\`
- Three tiers:
  - \`primitive\` — raw values with no semantic intent (e.g. \`color.primitive.ink-900\`)
  - \`semantic\` — intent-driven (e.g. \`color.semantic.surface-elevated\`, \`color.semantic.brand-primary\`)
  - \`component\` — scoped to a specific UI component (e.g. \`color.component.button-background\`)
- Use kebab-case segments. No camelCase in the name field.
- Prefer semantic tier when source names or usage context implies intent.
- Prefer the most commonly used value as the canonical representative.

## Confidence guidance

- \`high\`: ≥3 members in cluster; source names consistently imply the same intent
- \`medium\`: 2 members OR names are ambiguous
- \`low\`: single outlier or conflicting intent signals

## Important constraints

- Include one entry per cluster — do not skip any cluster.
- Do NOT invent new hex values or color components.
- sourceRefs must cite actual source paths + line numbers from the cluster data.
- Output must be a JSON array (not wrapped in an object).
- Write the array to \`${opts.responsePath}\` using the Write tool, then reply: done
`;
}

// === CLUSTER SLIMMER ===

/**
 * Convert raw clusters (ColorCluster[] shape from analyzers/cluster-color.ts) to
 * slim summaries safe to inline in a ≤5KB prompt.
 *
 * Full RawFinding objects are dropped — only sourcePath:line refs and rawValues are kept.
 * This is resilient to shape changes in the analyzer: unknown fields are ignored.
 */
interface ClusterRecord {
  clusterId?: unknown;
  id?: unknown;
  members?: unknown;
  proposedCanonical?: { rawValue?: unknown } | null;
  proposed?: unknown;
  deltaEMax?: unknown;
}

interface MemberRecord {
  sourcePath?: unknown;
  line?: unknown;
  rawValue?: unknown;
}

interface ClustersWrapper {
  clusters?: unknown;
}

function buildClusterSummaries(clusters: unknown): ClusterSummary[] {
  // Support both raw array and wrapped object { clusters: [...] }
  const wrapper = clusters as ClustersWrapper;
  const arr = Array.isArray(clusters)
    ? (clusters as unknown[])
    : Array.isArray(wrapper.clusters)
      ? (wrapper.clusters as unknown[])
      : [];

  if (arr.length === 0) return [];

  const summaries: ClusterSummary[] = [];

  for (const cluster of arr) {
    if (typeof cluster !== "object" || cluster === null) continue;

    const c = cluster as ClusterRecord;

    // Support both `clusterId` (number) and `id` (string/number) from different output shapes
    const rawId = c.clusterId ?? c.id ?? "unknown";
    const id = String(rawId);

    const members = Array.isArray(c.members) ? (c.members as unknown[]) : [];
    const proposed =
      typeof c.proposedCanonical === "object" && c.proposedCanonical !== null
        ? String(c.proposedCanonical.rawValue ?? "")
        : typeof c.proposed === "string"
          ? c.proposed
          : "";

    const deltaEMax = typeof c.deltaEMax === "number" ? c.deltaEMax : 0;

    const sourceRefs: string[] = [];
    const rawValues: string[] = [];

    for (const member of members) {
      if (typeof member !== "object" || member === null) continue;
      const m = member as MemberRecord;
      const sp = typeof m.sourcePath === "string" ? m.sourcePath : "";
      const line = typeof m.line === "number" ? m.line : 0;
      const rv = typeof m.rawValue === "string" ? m.rawValue : "";
      if (sp) sourceRefs.push(`${sp}:${line}`);
      if (rv) rawValues.push(rv);
    }

    summaries.push({ id, memberCount: members.length, deltaEMax, proposed, sourceRefs, rawValues });
  }

  return summaries;
}

// === UTILITIES ===

function isTaskDone(responsePath: string): boolean {
  try {
    const content = fs.readFileSync(responsePath, "utf-8");
    const parsed = JSON.parse(content) as unknown;
    return Array.isArray(parsed);
  } catch {
    return false;
  }
}
