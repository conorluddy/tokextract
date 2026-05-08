/**
 * analyzers/cluster-color.ts
 *
 * Cluster near-duplicate colors using CIEDE2000 (deltaE00).
 * Groups colors where the perceptual distance is below a configurable threshold
 * (default 2.5 per PRD §9.1).
 *
 * Uses the `delta-e` NPM package rather than a hand-rolled CIEDE2000 implementation.
 * delta-e operates on CIELAB {L, A, B} objects; we convert from sRGB via standard
 * D65-adapted matrices before clustering.
 *
 * === OUTPUT ===
 *
 * Each cluster has:
 * - members: the color findings in this cluster
 * - proposedCanonical: the most-used or median color in the cluster
 * - deltaEMax: the maximum pairwise distance within the cluster
 */

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const DeltaE = require("delta-e");

import type { NormalizedColor, RawFinding } from "../parsers/types.js";

// === PUBLIC API ===

export interface ColorCluster {
  readonly clusterId: number;
  readonly members: readonly RawFinding[];
  readonly proposedCanonical: RawFinding;
  readonly deltaEMax: number;
  readonly deltaEThreshold: number;
}

export interface ClusterColorResult {
  readonly clusters: readonly ColorCluster[];
  readonly singletons: readonly RawFinding[]; // colors with no near-duplicate
}

/**
 * Cluster color findings by CIEDE2000 perceptual distance.
 *
 * Only findings with a non-null, non-system-alias normalizedValue are clustered.
 * Findings with null normalizedValue (needs LLM) are returned as singletons.
 *
 * @param findings         Color findings from the parser
 * @param deltaEThreshold  Maximum CIEDE2000 distance to consider colors near-duplicates
 */
export function clusterColors(
  findings: readonly RawFinding[],
  deltaEThreshold = 2.5,
): ClusterColorResult {
  // Only cluster declaration-site findings with a resolved normalized value
  const clusterableFindings = findings.filter(
    (f) => f.category === "color" && f.normalizedValue !== null && !f.isSystemAlias,
  );

  if (clusterableFindings.length === 0) {
    return { clusters: [], singletons: [...findings] };
  }

  // Union-find approach: assign each finding to a cluster
  const clusterIds = new Array(clusterableFindings.length).fill(-1) as number[];
  let nextClusterId = 0;

  for (let i = 0; i < clusterableFindings.length; i++) {
    for (let j = i + 1; j < clusterableFindings.length; j++) {
      const colorA = clusterableFindings[i]?.normalizedValue as NormalizedColor | null;
      const colorB = clusterableFindings[j]?.normalizedValue as NormalizedColor | null;
      if (!colorA || !colorB) continue;

      const distance = computeDeltaE(colorA, colorB);
      if (distance < deltaEThreshold) {
        // Merge i and j into the same cluster
        const idA = clusterIds[i] ?? -1;
        const idB = clusterIds[j] ?? -1;

        if (idA === -1 && idB === -1) {
          // Both unassigned — create new cluster
          clusterIds[i] = nextClusterId;
          clusterIds[j] = nextClusterId;
          nextClusterId++;
        } else if (idA === -1) {
          // i unassigned — join j's cluster
          clusterIds[i] = idB;
        } else if (idB === -1) {
          // j unassigned — join i's cluster
          clusterIds[j] = idA;
        } else if (idA !== idB) {
          // Different clusters — merge idB into idA
          for (let k = 0; k < clusterIds.length; k++) {
            if (clusterIds[k] === idB) {
              clusterIds[k] = idA;
            }
          }
        }
      }
    }
  }

  // Build cluster map
  const clusterMap = new Map<number, RawFinding[]>();
  const unclusteredFindings: RawFinding[] = [];

  for (let i = 0; i < clusterableFindings.length; i++) {
    const finding = clusterableFindings[i];
    if (!finding) continue;
    const clusterId = clusterIds[i] ?? -1;
    if (clusterId === -1) {
      unclusteredFindings.push(finding);
    } else {
      const existing = clusterMap.get(clusterId) ?? [];
      existing.push(finding);
      clusterMap.set(clusterId, existing);
    }
  }

  // Build output clusters
  const clusters: ColorCluster[] = [];
  for (const [clusterId, members] of clusterMap) {
    if (members.length < 2) {
      // Single member "cluster" — treat as singleton
      unclusteredFindings.push(...members);
      continue;
    }

    const deltaEMax = computeMaxPairwiseDeltaE(members);
    const proposedCanonical = selectProposedCanonical(members);

    clusters.push({
      clusterId,
      members,
      proposedCanonical,
      deltaEMax,
      deltaEThreshold,
    });
  }

  // Singletons = non-clusterable findings + unclustered clusterable ones
  const nonClusterableFindings = findings.filter((f) => !clusterableFindings.includes(f));
  const singletons = [...nonClusterableFindings, ...unclusteredFindings];

  return { clusters, singletons };
}

// === PRIVATE HELPERS ===

interface LabColor {
  readonly L: number;
  readonly A: number;
  readonly B: number;
}

/**
 * Compute CIEDE2000 delta-E between two sRGB colors.
 * Converts from sRGB → XYZ → CIELAB before calling the delta-e library.
 */
function computeDeltaE(colorA: NormalizedColor, colorB: NormalizedColor): number {
  const labA = srgbToLab(colorA);
  const labB = srgbToLab(colorB);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
  return DeltaE.getDeltaE00(labA, labB) as number;
}

function computeMaxPairwiseDeltaE(members: readonly RawFinding[]): number {
  let maxDeltaE = 0;
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      const colorA = members[i]?.normalizedValue as NormalizedColor | null;
      const colorB = members[j]?.normalizedValue as NormalizedColor | null;
      if (!colorA || !colorB) continue;
      const d = computeDeltaE(colorA, colorB);
      if (d > maxDeltaE) maxDeltaE = d;
    }
  }
  return maxDeltaE;
}

/**
 * Select the proposed canonical token from a cluster.
 * Strategy: prefer the finding with a declName over anonymous ones; among named,
 * prefer the one with the most "semantic" sounding name. Falls back to first member.
 */
function selectProposedCanonical(members: readonly RawFinding[]): RawFinding {
  const namedMembers = members.filter((m) => m.declName !== null);
  if (namedMembers.length > 0) {
    // Prefer members that look like semantic names (contain words like brand, primary, surface)
    const semanticMembers = namedMembers.filter(
      (m) =>
        m.declName !== null &&
        /brand|primary|surface|background|foreground|accent|semantic/i.test(m.declName),
    );
    const bestMatch = semanticMembers[0] ?? namedMembers[0] ?? members[0];
    if (!bestMatch) throw new Error("selectProposedCanonical called with empty members array");
    return bestMatch;
  }
  const first = members[0];
  if (!first) throw new Error("selectProposedCanonical called with empty members array");
  return first;
}

// === sRGB → CIELAB CONVERSION ===
// Standard D65-adapted matrices per IEC 61966-2-1

function linearize(channel: number): number {
  // sRGB transfer function inverse
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function srgbToXyz(color: NormalizedColor): { X: number; Y: number; Z: number } {
  const r = linearize(color.r);
  const g = linearize(color.g);
  const b = linearize(color.b);

  // D65 adapted sRGB → XYZ matrix
  return {
    X: r * 0.4124564 + g * 0.3575761 + b * 0.1804375,
    Y: r * 0.2126729 + g * 0.7151522 + b * 0.072175,
    Z: r * 0.0193339 + g * 0.119192 + b * 0.9503041,
  };
}

function xyzToLab(xyz: { X: number; Y: number; Z: number }): LabColor {
  // D65 white point
  const Xn = 0.95047;
  const Yn = 1.0;
  const Zn = 1.08883;

  const fx = labF(xyz.X / Xn);
  const fy = labF(xyz.Y / Yn);
  const fz = labF(xyz.Z / Zn);

  return {
    L: 116 * fy - 16,
    A: 500 * (fx - fy),
    B: 200 * (fy - fz),
  };
}

function labF(t: number): number {
  const delta = 6 / 29;
  return t > delta ** 3 ? Math.cbrt(t) : t / (3 * delta ** 2) + 4 / 29;
}

function srgbToLab(color: NormalizedColor): LabColor {
  return xyzToLab(srgbToXyz(color));
}

// Export for testing
export { computeDeltaE, srgbToLab };
