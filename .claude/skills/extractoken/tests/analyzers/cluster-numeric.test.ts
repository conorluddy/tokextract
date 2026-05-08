/**
 * tests/analyzers/cluster-numeric.test.ts
 *
 * Unit tests for analyzers/cluster-numeric.ts
 */

import { describe, expect, it } from "vitest";
import { clusterNumeric, extractNumericValues } from "../../analyzers/cluster-numeric.js";
import type { RawFinding } from "../../parsers/types.js";

// === HELPERS ===

function makeSpacingFinding(value: number, declName = "padding"): RawFinding {
  return {
    category: "spacing",
    sourcePath: "Views/ContentView.swift",
    line: 10,
    col: 4,
    declName,
    rawValue: `.padding(${value})`,
    normalizedValue: value,
    context: ".padding",
    isDeclaration: false,
  };
}

function makeCornerRadiusFinding(value: number, declName = "cornerRadius"): RawFinding {
  return {
    category: "cornerRadius",
    sourcePath: "Views/CardView.swift",
    line: 20,
    col: 4,
    declName,
    rawValue: `.cornerRadius(${value})`,
    normalizedValue: value,
    context: ".cornerRadius",
    isDeclaration: false,
  };
}

function makeUnevenCornerFinding(
  topLeading: number,
  topTrailing: number,
  bottomLeading: number,
  bottomTrailing: number,
): RawFinding {
  return {
    category: "cornerRadius",
    sourcePath: "Views/CardView.swift",
    line: 30,
    col: 4,
    declName: null,
    rawValue: `UnevenRoundedRectangle(${topLeading}, ${topTrailing}, ${bottomLeading}, ${bottomTrailing})`,
    normalizedValue: { topLeading, topTrailing, bottomLeading, bottomTrailing },
    context: "UnevenRoundedRectangle",
    isDeclaration: false,
  };
}

function makeShadowFinding(radius: number): RawFinding {
  return {
    category: "shadow",
    sourcePath: "Views/CardView.swift",
    line: 40,
    col: 4,
    declName: null,
    rawValue: `.shadow(radius: ${radius})`,
    normalizedValue: { color: null, radius, x: 0, y: 2, opacity: 0.1 },
    context: ".shadow",
    isDeclaration: false,
  };
}

function makeColorFinding(hex: string): RawFinding {
  return {
    category: "color",
    sourcePath: "Style/Colors.swift",
    line: 5,
    col: 0,
    declName: "brand",
    rawValue: `Color(hex: "${hex}")`,
    normalizedValue: { r: 0.1, g: 0.2, b: 0.3, a: 1.0, colorSpace: "srgb" },
    context: "extension Color static let",
    isDeclaration: true,
  };
}

// === TESTS ===

describe("clusterNumeric", () => {
  it("returns empty clusters and histogram for empty input", () => {
    const result = clusterNumeric([]);
    expect(result.clusters).toHaveLength(0);
    expect(result.histogram).toHaveLength(0);
  });

  it("clusters spacing findings that are exactly on scale", () => {
    const findings: RawFinding[] = [
      makeSpacingFinding(8),
      makeSpacingFinding(16),
      makeSpacingFinding(16),
      makeSpacingFinding(32),
    ];

    const result = clusterNumeric(findings);

    // Should have clusters for 8 (sm), 16 (md), 32 (xl)
    expect(result.clusters.length).toBe(3);

    const smCluster = result.clusters.find((c) => c.scaleName === "sm");
    expect(smCluster).toBeDefined();
    expect(smCluster?.members).toHaveLength(1);
    expect(smCluster?.offScaleCount).toBe(0);

    const mdCluster = result.clusters.find((c) => c.scaleName === "md");
    expect(mdCluster?.members).toHaveLength(2);
    expect(mdCluster?.offScaleCount).toBe(0);
  });

  it("flags off-scale values with correct delta", () => {
    // 14 is off-scale — nearest is md=16, delta=2
    // 5 is off-scale — nearest is xs=4, delta=1
    const findings: RawFinding[] = [makeSpacingFinding(14), makeSpacingFinding(5)];

    const result = clusterNumeric(findings);

    // Both map to the nearest scale value
    const mdCluster = result.clusters.find((c) => c.scaleName === "md");
    expect(mdCluster).toBeDefined();
    expect(mdCluster?.offScaleCount).toBe(1);
    const mdMember = mdCluster?.members[0];
    expect(mdMember?.value).toBe(14);
    expect(mdMember?.delta).toBe(2);

    const xsCluster = result.clusters.find((c) => c.scaleName === "xs");
    expect(xsCluster?.offScaleCount).toBe(1);
    const xsMember = xsCluster?.members[0];
    expect(xsMember?.value).toBe(5);
    expect(xsMember?.delta).toBe(1);
  });

  it("expands 4-corner UnevenRoundedRectangle into 4 data points", () => {
    // All 4 corners use distinct scale values
    const finding = makeUnevenCornerFinding(4, 8, 16, 24);
    const result = clusterNumeric([finding]);

    // Each corner maps to its own scale slot
    expect(result.clusters.length).toBe(4);

    const xsCluster = result.clusters.find((c) => c.scaleName === "xs");
    const smCluster = result.clusters.find((c) => c.scaleName === "sm");
    const mdCluster = result.clusters.find((c) => c.scaleName === "md");
    const lgCluster = result.clusters.find((c) => c.scaleName === "lg");

    expect(xsCluster?.members).toHaveLength(1);
    expect(smCluster?.members).toHaveLength(1);
    expect(mdCluster?.members).toHaveLength(1);
    expect(lgCluster?.members).toHaveLength(1);

    // All corners are exactly on scale — no drift
    for (const cluster of result.clusters) {
      expect(cluster.offScaleCount).toBe(0);
    }
  });

  it("ignores color category findings", () => {
    const findings: RawFinding[] = [
      makeColorFinding("#FF0000"),
      makeColorFinding("#00FF00"),
      makeSpacingFinding(8), // Should still be picked up
    ];

    const result = clusterNumeric(findings);

    // Only the spacing finding contributes
    expect(result.clusters.length).toBe(1);
    expect(result.clusters[0]?.scaleName).toBe("sm");
    expect(result.histogram).toHaveLength(1);
    expect(result.histogram[0]).toEqual({ value: 8, count: 1 });
  });

  it("uses a custom scale when provided", () => {
    const customScale = [6, 12, 18, 36];
    const findings: RawFinding[] = [
      makeSpacingFinding(6),
      makeSpacingFinding(12),
      makeSpacingFinding(18),
    ];

    const result = clusterNumeric(findings, customScale);

    // All three values are exactly on the custom scale
    expect(result.clusters.length).toBe(3);
    for (const cluster of result.clusters) {
      expect(cluster.offScaleCount).toBe(0);
    }

    // Custom scale values have no pre-defined names — fall back to number string
    const cluster6 = result.clusters.find((c) => c.scaleValue === 6);
    expect(cluster6?.scaleName).toBe("6");
  });

  it("clusters shadow findings using the radius field", () => {
    const findings: RawFinding[] = [
      makeShadowFinding(8),
      makeShadowFinding(10), // Off-scale: nearest is sm=8, delta=2
    ];

    const result = clusterNumeric(findings);
    const smCluster = result.clusters.find((c) => c.scaleName === "sm");

    expect(smCluster).toBeDefined();
    expect(smCluster?.members).toHaveLength(2);
    // Exactly-on-scale member has delta 0, off-scale has delta 2
    const exactMember = smCluster?.members.find((m) => m.value === 8);
    const offMember = smCluster?.members.find((m) => m.value === 10);
    expect(exactMember?.delta).toBe(0);
    expect(offMember?.delta).toBe(2);
    expect(smCluster?.offScaleCount).toBe(1);
  });

  it("builds a correct histogram across mixed categories", () => {
    const findings: RawFinding[] = [
      makeSpacingFinding(16),
      makeSpacingFinding(16),
      makeCornerRadiusFinding(8),
    ];

    const result = clusterNumeric(findings);

    const entry16 = result.histogram.find((h) => h.value === 16);
    const entry8 = result.histogram.find((h) => h.value === 8);
    expect(entry16?.count).toBe(2);
    expect(entry8?.count).toBe(1);
  });
});

describe("extractNumericValues", () => {
  it("returns empty array for color finding", () => {
    const finding = makeColorFinding("#AABBCC");
    expect(extractNumericValues(finding)).toEqual([]);
  });

  it("returns single number for uniform cornerRadius finding", () => {
    const finding = makeCornerRadiusFinding(12);
    expect(extractNumericValues(finding)).toEqual([12]);
  });

  it("returns all 4 corner values for uneven cornerRadius finding", () => {
    const finding = makeUnevenCornerFinding(4, 8, 16, 24);
    expect(extractNumericValues(finding)).toEqual([4, 8, 16, 24]);
  });

  it("returns radius from shadow finding", () => {
    const finding = makeShadowFinding(16);
    expect(extractNumericValues(finding)).toEqual([16]);
  });

  it("returns empty array when normalizedValue is null", () => {
    const nullFinding: RawFinding = {
      ...makeSpacingFinding(8),
      normalizedValue: null,
    };
    expect(extractNumericValues(nullFinding)).toEqual([]);
  });
});
