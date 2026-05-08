/**
 * preview-html.ts — Self-contained HTML preview of the extracted design system.
 *
 * Reads the static shell at emitters/preview/preview-shell.html, injects a single
 * JSON payload (tokens + DESIGN.md + cluster cards + meta) into a <script> tag,
 * and writes <outputDir>/preview.html. No external assets, no network requests.
 *
 * The renderer (inline in the shell) walks the tokens tree and builds the DOM.
 * Cluster members are pre-flattened here with a `cssColor` so the renderer never
 * needs to know the RawFinding shape.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ColorCluster } from "../analyzers/cluster-color.js";
import type { NormalizedColor, RawFinding } from "../parsers/types.js";

// === PUBLIC API ===

export interface PreviewMeta {
  readonly appName: string;
  readonly vendorNamespace: string;
  readonly extractedAt: string;
  readonly repoPath: string;
}

export interface EmitPreviewHtmlInput {
  readonly tokens: unknown;
  readonly designMd: string;
  readonly clusters: readonly ColorCluster[];
  readonly meta: PreviewMeta;
}

export interface EmitPreviewHtmlOptions {
  readonly outputDir: string;
}

export function emitPreviewHtml(
  input: EmitPreviewHtmlInput,
  options: EmitPreviewHtmlOptions,
): string {
  const shellPath = resolveShellPath();
  const shell = fs.readFileSync(shellPath, "utf-8");

  const payload = {
    meta: input.meta,
    tokens: input.tokens,
    designMd: input.designMd,
    clusters: input.clusters.map(flattenCluster),
  };

  const json = JSON.stringify(payload).replace(/<\/script>/gi, "<\\/script>");
  const marker = "<!-- TOKEXTRACT_DATA -->";
  if (!shell.includes(marker)) {
    throw new Error(`preview shell is missing the ${marker} marker at ${shellPath}`);
  }
  const html = shell.replace(marker, json);

  const outPath = path.join(options.outputDir, "preview.html");
  fs.writeFileSync(outPath, html, "utf-8");
  return outPath;
}

// === HELPERS ===

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveShellPath(): string {
  // The shell is checked into source at emitters/preview/preview-shell.html and
  // copied alongside compiled JS at dist/emitters/preview/preview-shell.html via
  // the build script. Both locations are siblings of this module.
  return path.join(__dirname, "preview", "preview-shell.html");
}

interface FlattenedClusterMember {
  readonly declName: string | null;
  readonly rawValue: string;
  readonly sourcePath: string;
  readonly line: number;
  readonly cssColor: string;
}

interface FlattenedCluster {
  readonly clusterId: number;
  readonly deltaEMax: number;
  readonly deltaEThreshold: number;
  readonly proposedCanonical: FlattenedClusterMember;
  readonly members: readonly FlattenedClusterMember[];
}

function flattenCluster(cluster: ColorCluster): FlattenedCluster {
  return {
    clusterId: cluster.clusterId,
    deltaEMax: cluster.deltaEMax,
    deltaEThreshold: cluster.deltaEThreshold,
    proposedCanonical: flattenMember(cluster.proposedCanonical),
    members: cluster.members.map(flattenMember),
  };
}

function flattenMember(finding: RawFinding): FlattenedClusterMember {
  return {
    declName: finding.declName,
    rawValue: finding.rawValue,
    sourcePath: finding.sourcePath,
    line: finding.line,
    cssColor: normalizedToCss(finding.normalizedValue),
  };
}

function normalizedToCss(normalized: unknown): string {
  if (!normalized || typeof normalized !== "object") return "transparent";
  const candidate = normalized as Partial<NormalizedColor>;
  if (
    typeof candidate.r !== "number" ||
    typeof candidate.g !== "number" ||
    typeof candidate.b !== "number"
  ) {
    return "transparent";
  }
  const r = clamp255(candidate.r);
  const g = clamp255(candidate.g);
  const b = clamp255(candidate.b);
  const a = typeof candidate.a === "number" ? candidate.a : 1;
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

function clamp255(component: number): number {
  return Math.max(0, Math.min(255, Math.round(component * 255)));
}
