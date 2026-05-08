/**
 * analyzers/drift-detector.ts
 *
 * Detect numeric drift — literals whose value isn't exactly on the canonical
 * scale (default: 4/8 scale — xs=4, sm=8, md=16, lg=24, xl=32, 2xl=48).
 *
 * "Drift" is defined as delta > 0 from the nearest scale value.
 * This is a superset of "off-scale": a value of 14 is drift (nearest: md=16,
 * delta=2). A value of exactly 16 is not drift.
 *
 * === OUTPUT ===
 *
 * DriftReport contains:
 * - findings: every drifting (finding, value) pair with nearest scale + delta
 * - byCategory: same findings grouped by TokenCategory for audit rendering
 */

import type { RawFinding } from "../parsers/types.js";
import { DEFAULT_NUMERIC_SCALE, extractNumericValues } from "./cluster-numeric.js";

// === PUBLIC API ===

export interface DriftFinding {
  readonly finding: RawFinding;
  readonly value: number;
  readonly nearestScaleValue: number;
  readonly nearestScaleName: string;
  readonly delta: number;
}

export interface DriftReport {
  readonly findings: readonly DriftFinding[];
  /** Drift findings grouped by RawFinding category (spacing, cornerRadius, shadow …) */
  readonly byCategory: ReadonlyMap<string, readonly DriftFinding[]>;
}

/**
 * Detect numeric literals that deviate from the canonical scale.
 *
 * For each numeric finding, every extractable value is tested.
 * UnevenRoundedRectangle (4-corner) values are each tested independently.
 *
 * Only categories handled by extractNumericValues contribute findings;
 * color, typography, animation, etc. are silently ignored.
 *
 * @param findings  Raw findings from parsers
 * @param scale     Custom scale values; defaults to [4, 8, 16, 24, 32, 48]
 */
export function detectDrift(
  findings: readonly RawFinding[],
  scale: readonly number[] = DEFAULT_NUMERIC_SCALE,
): DriftReport {
  if (scale.length === 0 || findings.length === 0) {
    return { findings: [], byCategory: new Map() };
  }

  const scaleSet = new Set(scale);
  const driftFindings: DriftFinding[] = [];

  for (const finding of findings) {
    const values = extractNumericValues(finding);
    for (const value of values) {
      if (scaleSet.has(value)) continue; // Exactly on scale — not drift

      const nearestScaleValue = findNearestScaleValue(value, scale);
      const delta = Math.abs(value - nearestScaleValue);

      driftFindings.push({
        finding,
        value,
        nearestScaleValue,
        nearestScaleName: SCALE_NAMES[nearestScaleValue] ?? String(nearestScaleValue),
        delta,
      });
    }
  }

  // Group by category
  const byCategoryMap = new Map<string, DriftFinding[]>();
  for (const driftFinding of driftFindings) {
    const category = driftFinding.finding.category;
    const existing = byCategoryMap.get(category) ?? [];
    existing.push(driftFinding);
    byCategoryMap.set(category, existing);
  }

  // Freeze each group array for the return type
  const byCategory: ReadonlyMap<string, readonly DriftFinding[]> = new Map(
    [...byCategoryMap.entries()].map(([k, v]) => [k, v]),
  );

  return { findings: driftFindings, byCategory };
}

// === PRIVATE HELPERS ===

const SCALE_NAMES: Readonly<Record<number, string>> = {
  4: "xs",
  8: "sm",
  16: "md",
  24: "lg",
  32: "xl",
  48: "2xl",
};

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
