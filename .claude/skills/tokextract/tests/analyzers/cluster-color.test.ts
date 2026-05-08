/**
 * tests/analyzers/cluster-color.test.ts
 *
 * Unit tests for analyzers/cluster-color.ts
 */

import { describe, expect, it } from "vitest";
import { clusterColors, computeDeltaE } from "../../analyzers/cluster-color.js";
import type { NormalizedColor, RawFinding } from "../../parsers/types.js";

function makeColorFinding(declName: string, r: number, g: number, b: number, a = 1.0): RawFinding {
  return {
    category: "color",
    sourcePath: "test.swift",
    line: 1,
    col: 0,
    declName,
    rawValue: `Color(red: ${r}, green: ${g}, blue: ${b})`,
    normalizedValue: { r, g, b, a, colorSpace: "srgb" } as NormalizedColor,
    context: "extension Color static let",
    isDeclaration: true,
    isSystemAlias: false,
  };
}

describe("cluster-color analyzer", () => {
  it("returns no clusters when all colors are perceptually distinct", () => {
    const findings: RawFinding[] = [
      makeColorFinding("red", 1, 0, 0),
      makeColorFinding("green", 0, 1, 0),
      makeColorFinding("blue", 0, 0, 1),
    ];

    const result = clusterColors(findings, 2.5);
    expect(result.clusters.length).toBe(0);
    expect(result.singletons.length).toBe(3);
  });

  it("clusters near-identical dark gray colors", () => {
    // Three near-black values: #1A1C1E, #1A1D1E, #1B1C1E
    // In sRGB these differ by ~1-2 steps out of 255
    const findings: RawFinding[] = [
      makeColorFinding("color1", 0x1a / 255, 0x1c / 255, 0x1e / 255),
      makeColorFinding("color2", 0x1a / 255, 0x1d / 255, 0x1e / 255),
      makeColorFinding("color3", 0x1b / 255, 0x1c / 255, 0x1e / 255),
    ];

    const result = clusterColors(findings, 2.5);
    expect(result.clusters.length).toBeGreaterThanOrEqual(1);
    // All three should be in the same cluster
    const totalInClusters = result.clusters.reduce((sum, c) => sum + c.members.length, 0);
    expect(totalInClusters).toBe(3);
  });

  it("respects the deltaE threshold — increasing threshold merges more colors", () => {
    // Slightly different grays that are close but might not cluster at 2.5
    const findings: RawFinding[] = [
      makeColorFinding("grayA", 0.3, 0.3, 0.3),
      makeColorFinding("grayB", 0.35, 0.35, 0.35),
    ];

    const strictResult = clusterColors(findings, 0.5); // Very tight
    const looseResult = clusterColors(findings, 10.0); // Very loose

    // At very loose threshold, they should cluster
    expect(looseResult.clusters.length).toBeGreaterThan(strictResult.clusters.length);
  });

  it("does not cluster system aliases", () => {
    const systemAliasRed: RawFinding = {
      category: "color",
      sourcePath: "test.swift",
      line: 1,
      col: 0,
      declName: "systemRed",
      rawValue: "Color.red",
      normalizedValue: { r: 1, g: 0, b: 0, a: 1, colorSpace: "srgb" } as NormalizedColor,
      context: "extension Color static let",
      isDeclaration: true,
      isSystemAlias: true, // Should be excluded from clustering
    };
    const regularRed = makeColorFinding("brandRed", 1.0, 0.0, 0.0); // Same color, non-alias

    const result = clusterColors([systemAliasRed, regularRed], 2.5);
    // System alias should not be clustered with the regular red
    expect(result.clusters.length).toBe(0);
  });

  it("does not cluster findings with null normalizedValue", () => {
    const nullValueFinding: RawFinding = {
      category: "color",
      sourcePath: "test.swift",
      line: 1,
      col: 0,
      declName: "assetColor",
      rawValue: 'Color("AppBackground")',
      normalizedValue: null, // Needs LLM
      context: "extension Color static let",
      isDeclaration: true,
    };
    const regularFinding = makeColorFinding("brand", 0.1, 0.1, 0.1);

    const result = clusterColors([nullValueFinding, regularFinding], 2.5);
    expect(result.clusters.length).toBe(0);
    // The null-value finding should end up in singletons
    expect(result.singletons.some((s) => s.declName === "assetColor")).toBe(true);
  });

  it("computeDeltaE returns 0 for identical colors", () => {
    const white: NormalizedColor = { r: 1, g: 1, b: 1, a: 1, colorSpace: "srgb" };
    const delta = computeDeltaE(white, white);
    expect(delta).toBeCloseTo(0, 4);
  });

  it("computeDeltaE returns large values for very different colors", () => {
    const white: NormalizedColor = { r: 1, g: 1, b: 1, a: 1, colorSpace: "srgb" };
    const black: NormalizedColor = { r: 0, g: 0, b: 0, a: 1, colorSpace: "srgb" };
    const delta = computeDeltaE(white, black);
    // White and black have very high deltaE (should be ~100)
    expect(delta).toBeGreaterThan(50);
  });
});
