/**
 * llm/harmonize.ts
 *
 * Generates the harmonize prompt file and appends an LlmTask to the manifest.
 *
 * The harmonize pass reviews color + numeric clusters from the deterministic analyzer
 * and proposes canonical token names for each near-duplicate cluster.
 *
 * Contract (Slice 1.5 / 3.7):
 * - Inline clusters directly (pre-aggregated; typically 5-50 clusters × ≤10 members
 *   each — stays well under 5KB even on large repos).
 * - Accepts three input shapes:
 *     1. Plain array: ColorCluster[]
 *     2. Wrapped object: { clusters: ColorCluster[] }
 *     3. Combined wrapper: { colorClusters: <shape1|2>, numericClusters: <shape1|2> }
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
  const promptsDir = path.join(options.outputDir, ".tokextract", "prompts");
  const llmOutDir = path.join(options.outputDir, ".tokextract", "llm-out");

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

const WORKED_EXAMPLE = `{
  "clusterID": "near-black-ink",
  "recommendation": "These three colors are visually indistinguishable (max ΔE 1.8). They are all used as text fill on dark surfaces and are interchangeable. Consolidate to a single token.",
  "canonicalToken": {
    "name": "color.semantic.ink-primary",
    "group": "semantic",
    "description": "Primary ink color for text on dark surfaces."
  },
  "confidence": "high",
  "sourceRefs": ["Styles/Colors.swift:12", "Views/Dashboard/DashboardView.swift:67", "Components/Card/CardBackground.swift:9"]
}`;

function buildHarmonizePrompt(opts: HarmonizePromptOptions): string {
  // Slim down clusters to just the fields the LLM needs — strips full RawFinding blobs
  const summaries = buildClusterSummaries(opts.clusters);
  const clusterCount = summaries.length;
  // Compact JSON — stays well under 5KB for up to 50 clusters
  const clustersJson = JSON.stringify(summaries);
  const minExpected = Math.floor(clusterCount * 0.5);
  const maxExpected = Math.floor(clusterCount * 0.85);

  return `# Tokextract — Cluster Harmonization

You MUST emit a recommendation for every cluster you would consolidate. For ${clusterCount} clusters, expect ${minExpected}–${maxExpected} recommendations (50–85% yield). Returning \`[]\` is only correct when every cluster's members are intentionally distinct — which is extremely rare on real codebases.

## Input — ${clusterCount} clusters

\`\`\`json
${clustersJson}
\`\`\`

## Worked example (exact shape required)

\`\`\`json
${WORKED_EXAMPLE}
\`\`\`

## Output rules

- **clusterID**: matches a cluster id above
- **recommendation**: 1-2 sentences of consolidation rationale
- **canonicalToken.name**: \`color.<group>.<kebab-slug>\` — primitive/semantic/component; prefer semantic when name implies intent
- **canonicalToken.description**: 1-line intent
- **confidence**:
  - \`high\`: ΔE=0 or names clearly redundant (e.g. \`GraplaSurface1\` ≡ \`BackgroundLight\`)
  - \`medium\`: ΔE 1–2.5 with similar intent
  - \`low\`: visually similar but semantically distinct names
- **sourceRefs**: cite actual file:line from the cluster data — required, minimum 1
- Unsure? Use \`confidence: "low"\` — never skip a cluster entirely.

Write a JSON array to \`${opts.responsePath}\` using the Write tool, then reply: done
`;
}

// === CLUSTER SLIMMER ===

/**
 * Convert raw clusters to slim summaries safe to inline in a ≤5KB prompt.
 *
 * Accepts three input shapes (resilient to analyzer shape changes):
 *   1. Plain array: ClusterRecord[]
 *   2. Wrapped object: { clusters: ClusterRecord[] }
 *   3. Combined wrapper: { colorClusters: <shape1|2>, numericClusters: <shape1|2> }
 *
 * Full RawFinding objects are dropped — only sourcePath:line refs and rawValues are kept.
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

interface CombinedClustersWrapper {
  colorClusters?: unknown;
  numericClusters?: unknown;
}

/**
 * Extract a flat array of ClusterRecord items from any supported input shape.
 * Handles: plain array, { clusters: [...] }, { colorClusters: ..., numericClusters: ... }.
 */
function extractClusterArray(input: unknown): unknown[] {
  if (Array.isArray(input)) return input as unknown[];

  if (typeof input !== "object" || input === null) return [];

  // Combined wrapper: { colorClusters, numericClusters }
  const combined = input as CombinedClustersWrapper;
  if (combined.colorClusters !== undefined || combined.numericClusters !== undefined) {
    return [
      ...extractClusterArray(combined.colorClusters),
      ...extractClusterArray(combined.numericClusters),
    ];
  }

  // Single wrapped object: { clusters: [...] }
  const wrapper = input as ClustersWrapper;
  if (Array.isArray(wrapper.clusters)) return wrapper.clusters as unknown[];

  return [];
}

function buildClusterSummaries(clusters: unknown): ClusterSummary[] {
  const arr = extractClusterArray(clusters);
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
