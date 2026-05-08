/**
 * tests/analyzers/drift-detector.test.ts
 *
 * Unit tests for analyzers/drift-detector.ts
 */

import { describe, expect, it } from "vitest";
import { detectDrift } from "../../analyzers/drift-detector.js";
import type { RawFinding } from "../../parsers/types.js";

// === HELPERS ===

function makeSpacingFinding(value: number, line = 10): RawFinding {
  return {
    category: "spacing",
    sourcePath: "Views/ContentView.swift",
    line,
    col: 4,
    declName: null,
    rawValue: `.padding(${value})`,
    normalizedValue: value,
    context: ".padding",
    isDeclaration: false,
  };
}

function makeCornerRadiusFinding(value: number): RawFinding {
  return {
    category: "cornerRadius",
    sourcePath: "Views/CardView.swift",
    line: 20,
    col: 4,
    declName: null,
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

function makeColorFinding(): RawFinding {
  return {
    category: "color",
    sourcePath: "Style/Colors.swift",
    line: 5,
    col: 0,
    declName: "brand",
    rawValue: "Color(red: 0.1, green: 0.2, blue: 0.3)",
    normalizedValue: { r: 0.1, g: 0.2, b: 0.3, a: 1.0, colorSpace: "srgb" },
    context: "extension Color static let",
    isDeclaration: true,
  };
}

// === TESTS ===

describe("detectDrift", () => {
  it("returns empty report for empty input", () => {
    const report = detectDrift([]);
    expect(report.findings).toHaveLength(0);
    expect(report.byCategory.size).toBe(0);
  });

  it("reports no drift when all spacing values are exactly on scale", () => {
    const findings: RawFinding[] = [
      makeSpacingFinding(4),
      makeSpacingFinding(8),
      makeSpacingFinding(16),
      makeSpacingFinding(24),
    ];

    const report = detectDrift(findings);
    expect(report.findings).toHaveLength(0);
    expect(report.byCategory.size).toBe(0);
  });

  it("flags spacing values that are off-scale with correct nearest and delta", () => {
    const findings: RawFinding[] = [
      makeSpacingFinding(14), // nearest: md=16, delta=2
      makeSpacingFinding(5), // nearest: xs=4, delta=1
      makeSpacingFinding(16), // exactly on scale — no drift
    ];

    const report = detectDrift(findings);
    expect(report.findings).toHaveLength(2);

    const drift14 = report.findings.find((f) => f.value === 14);
    expect(drift14).toBeDefined();
    expect(drift14?.nearestScaleValue).toBe(16);
    expect(drift14?.nearestScaleName).toBe("md");
    expect(drift14?.delta).toBe(2);

    const drift5 = report.findings.find((f) => f.value === 5);
    expect(drift5?.nearestScaleValue).toBe(4);
    expect(drift5?.nearestScaleName).toBe("xs");
    expect(drift5?.delta).toBe(1);
  });

  it("groups drift findings by category", () => {
    const findings: RawFinding[] = [
      makeSpacingFinding(14), // spacing drift
      makeSpacingFinding(5), // spacing drift
      makeCornerRadiusFinding(10), // cornerRadius drift (nearest: sm=8, delta=2)
    ];

    const report = detectDrift(findings);
    expect(report.findings).toHaveLength(3);

    const spacingDrift = report.byCategory.get("spacing");
    expect(spacingDrift).toHaveLength(2);

    const radiusDrift = report.byCategory.get("cornerRadius");
    expect(radiusDrift).toHaveLength(1);
    expect(radiusDrift?.[0]?.value).toBe(10);
    expect(radiusDrift?.[0]?.nearestScaleValue).toBe(8);
    expect(radiusDrift?.[0]?.delta).toBe(2);
  });

  it("expands 4-corner UnevenRoundedRectangle and flags each off-scale corner", () => {
    // 4=xs (on scale), 9=off (nearest sm=8, delta=1), 16=md (on scale), 22=off (nearest lg=24, delta=2)
    const finding = makeUnevenCornerFinding(4, 9, 16, 22);

    const report = detectDrift([finding]);

    // Two corners are off-scale (9 and 22)
    expect(report.findings).toHaveLength(2);

    const drift9 = report.findings.find((f) => f.value === 9);
    expect(drift9?.nearestScaleValue).toBe(8);
    expect(drift9?.nearestScaleName).toBe("sm");
    expect(drift9?.delta).toBe(1);

    const drift22 = report.findings.find((f) => f.value === 22);
    expect(drift22?.nearestScaleValue).toBe(24);
    expect(drift22?.nearestScaleName).toBe("lg");
    expect(drift22?.delta).toBe(2);
  });

  it("uses a custom scale when provided", () => {
    const customScale = [6, 12, 18, 36];
    const findings: RawFinding[] = [
      makeSpacingFinding(8), // off custom scale — nearest 6, delta 2
      makeSpacingFinding(12), // exactly on custom scale — no drift
    ];

    const report = detectDrift(findings, customScale);
    expect(report.findings).toHaveLength(1);

    const drift8 = report.findings[0];
    expect(drift8?.value).toBe(8);
    expect(drift8?.nearestScaleValue).toBe(6);
    expect(drift8?.delta).toBe(2);
    // Custom scale has no pre-defined name — falls back to number string
    expect(drift8?.nearestScaleName).toBe("6");
  });

  it("ignores color category findings", () => {
    const findings: RawFinding[] = [
      makeColorFinding(),
      makeColorFinding(),
      makeSpacingFinding(7), // One off-scale spacing finding
    ];

    const report = detectDrift(findings);
    // Only the off-scale spacing finding registers as drift
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.finding.category).toBe("spacing");
  });

  it("flags shadow radius drift correctly", () => {
    const findings: RawFinding[] = [
      makeShadowFinding(8), // exactly on scale
      makeShadowFinding(10), // off scale: nearest sm=8, delta=2
    ];

    const report = detectDrift(findings);
    expect(report.findings).toHaveLength(1);

    const shadowDrift = report.findings[0];
    expect(shadowDrift?.value).toBe(10);
    expect(shadowDrift?.nearestScaleValue).toBe(8);
    expect(shadowDrift?.nearestScaleName).toBe("sm");
    expect(shadowDrift?.delta).toBe(2);

    const shadowCategory = report.byCategory.get("shadow");
    expect(shadowCategory).toHaveLength(1);
  });

  it("returns empty report when scale is empty", () => {
    const findings: RawFinding[] = [makeSpacingFinding(8)];
    const report = detectDrift(findings, []);
    expect(report.findings).toHaveLength(0);
    expect(report.byCategory.size).toBe(0);
  });
});
