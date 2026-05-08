/**
 * analyzers/cluster-numeric.ts
 *
 * Cluster numeric findings (spacing, cornerRadius, shadow radius) onto a
 * canonical scale (default: 4/8 scale — xs=4, sm=8, md=16, lg=24, xl=32, 2xl=48).
 *
 * For each finding, the nearest scale value is found by absolute distance.
 * Findings are grouped by their nearest scale value; members with delta > 0
 * are flagged as off-scale candidates.
 *
 * === OUTPUT ===
 *
 * Each cluster has:
 * - scaleName / scaleValue: the canonical slot this cluster maps to
 * - members: findings that mapped to this scale value, with their delta
 * - offScaleCount: how many members deviated from the exact scale value
 */

import type { RawFinding } from "../parsers/types.js";

// === PUBLIC API ===

export interface NumericCluster {
  readonly scaleName: string;
  readonly scaleValue: number;
  readonly members: ReadonlyArray<{
    readonly finding: RawFinding;
    readonly value: number;
    readonly delta: number;
  }>;
  readonly offScaleCount: number;
}

export interface NumericClusterResult {
  readonly clusters: readonly NumericCluster[];
  /** Raw value → count histogram across all numeric findings */
  readonly histogram: ReadonlyArray<{ value: number; count: number }>;
}

/** Default 4/8 spacing scale: xs → 2xl */
export const DEFAULT_NUMERIC_SCALE: readonly number[] = [4, 8, 16, 24, 32, 48];

/**
 * Cluster numeric findings onto a canonical scale.
 *
 * Accepts spacing, cornerRadius, and shadow category findings.
 * Findings in other categories (e.g. color) are silently ignored.
 * For cornerRadius findings with a 4-corner object value, each corner is
 * treated as an independent data point.
 *
 * @param findings  Raw findings from parsers
 * @param scale     Custom scale values; defaults to [4, 8, 16, 24, 32, 48]
 */
export function clusterNumeric(
  findings: readonly RawFinding[],
  scale: readonly number[] = DEFAULT_NUMERIC_SCALE,
): NumericClusterResult {
  if (scale.length === 0) {
    return { clusters: [], histogram: [] };
  }

  // Expand findings into (finding, value) pairs
  const pairs: Array<{ finding: RawFinding; value: number }> = [];
  for (const finding of findings) {
    const values = extractNumericValues(finding);
    for (const value of values) {
      pairs.push({ finding, value });
    }
  }

  if (pairs.length === 0) {
    return { clusters: [], histogram: [] };
  }

  // Build histogram: raw value → count
  const valueCounts = new Map<number, number>();
  for (const { value } of pairs) {
    valueCounts.set(value, (valueCounts.get(value) ?? 0) + 1);
  }
  const histogram = [...valueCounts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([value, count]) => ({ value, count }));

  // Group pairs by nearest scale value
  type MutableMember = { finding: RawFinding; value: number; delta: number };
  const clusterMap = new Map<number, MutableMember[]>();
  for (const scaleValue of scale) {
    clusterMap.set(scaleValue, []);
  }

  for (const { finding, value } of pairs) {
    const nearest = findNearestScaleValue(value, scale);
    const delta = Math.abs(value - nearest);
    const members = clusterMap.get(nearest);
    if (members) {
      members.push({ finding, value, delta });
    }
  }

  // Build output — only include scale slots that have members
  const clusters: NumericCluster[] = [];
  for (const scaleValue of scale) {
    const members = clusterMap.get(scaleValue);
    if (!members || members.length === 0) continue;
    clusters.push({
      scaleName: SCALE_NAMES[scaleValue] ?? String(scaleValue),
      scaleValue,
      members,
      offScaleCount: members.filter((m) => m.delta > 0).length,
    });
  }

  return { clusters, histogram };
}

// === PRIVATE HELPERS ===

/** Scale value → canonical token name */
const SCALE_NAMES: Readonly<Record<number, string>> = {
  4: "xs",
  8: "sm",
  16: "md",
  24: "lg",
  32: "xl",
  48: "2xl",
};

/**
 * Extract all numeric values from a finding.
 *
 * - spacing: normalizedValue is number | null
 * - cornerRadius: normalizedValue is number | UnevenCorners | null
 *   UnevenCorners (4-corner object) → 4 separate values
 * - shadow: normalizedValue is ShadowValue | null → use radius field
 *
 * Other categories return an empty array.
 */
export function extractNumericValues(finding: RawFinding): number[] {
  switch (finding.category) {
    case "spacing": {
      const v = finding.normalizedValue;
      if (typeof v === "number") return [v];
      return [];
    }

    case "cornerRadius": {
      const v = finding.normalizedValue;
      if (typeof v === "number") return [v];
      if (isUnevenCorners(v)) {
        return [v.topLeading, v.topTrailing, v.bottomLeading, v.bottomTrailing];
      }
      return [];
    }

    case "shadow": {
      const v = finding.normalizedValue;
      if (isShadowValue(v)) {
        return [v.radius];
      }
      return [];
    }

    default:
      return [];
  }
}

/** Find the scale value with the smallest absolute distance to `value`. */
function findNearestScaleValue(value: number, scale: readonly number[]): number {
  let nearest = scale[0] as number;
  let minDist = Math.abs(value - nearest);
  for (let i = 1; i < scale.length; i++) {
    const scaleValue = scale[i] as number;
    const dist = Math.abs(value - scaleValue);
    if (dist < minDist) {
      minDist = dist;
      nearest = scaleValue;
    }
  }
  return nearest;
}

/** Type guard for a 4-corner radius object */
interface UnevenCorners {
  readonly topLeading: number;
  readonly topTrailing: number;
  readonly bottomLeading: number;
  readonly bottomTrailing: number;
}

function isUnevenCorners(v: unknown): v is UnevenCorners {
  if (v === null || typeof v !== "object") return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj.topLeading === "number" &&
    typeof obj.topTrailing === "number" &&
    typeof obj.bottomLeading === "number" &&
    typeof obj.bottomTrailing === "number"
  );
}

/** Type guard for a shadow value */
interface ShadowValue {
  readonly radius: number;
  readonly x?: number;
  readonly y?: number;
  readonly color?: unknown;
  readonly opacity?: number;
}

function isShadowValue(v: unknown): v is ShadowValue {
  if (v === null || typeof v !== "object") return false;
  const obj = v as Record<string, unknown>;
  return typeof obj.radius === "number";
}
