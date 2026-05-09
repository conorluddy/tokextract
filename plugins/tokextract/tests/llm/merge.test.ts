/**
 * tests/llm/merge.test.ts
 *
 * Unit tests for llm/merge.ts — the Node-side merger that joins Mapping[]
 * with findings.raw.json to produce CandidateFile.
 *
 * Tests cover: join logic, mechanical fallback, multi-chunk union,
 * alphabetical ordering, mechanical name format, edge cases.
 */

import { describe, expect, it } from "vitest";
import { buildCandidateFile } from "../../llm/merge.js";
import type { FindingsFile, Mapping, NormalizedColor, RawFinding } from "../../parsers/types.js";

// === FIXTURES ===

const RED_COLOR: NormalizedColor = { r: 1.0, g: 0.0, b: 0.0, a: 1.0, colorSpace: "srgb" };
const BLUE_COLOR: NormalizedColor = { r: 0.0, g: 0.4, b: 1.0, a: 1.0, colorSpace: "srgb" };

function makeColorFinding(
  declName: string,
  sourcePath: string,
  normalizedValue: NormalizedColor | null = RED_COLOR,
  line = 10,
): RawFinding {
  return {
    category: "color",
    sourcePath,
    line,
    col: 4,
    declName,
    rawValue: `Color(.sRGB, red: ${normalizedValue?.r ?? 0}, green: ${normalizedValue?.g ?? 0}, blue: ${normalizedValue?.b ?? 0}, opacity: 1)`,
    normalizedValue,
    context: "extension Color static let",
    isDeclaration: true,
    severity: "info",
  };
}

function makeFindingsFile(findings: RawFinding[]): FindingsFile {
  return {
    tokextractVersion: "1.0.0-test",
    targetRepo: "/tmp/test-repo",
    extractedAt: "2026-05-08T00:00:00Z",
    findings,
  };
}

// === TESTS ===

describe("merge — join logic", () => {
  it("joins a Mapping to its finding by declName + sourcePath", () => {
    const finding = makeColorFinding("brandPrimary", "Sources/Color+Brand.swift");
    const findings = makeFindingsFile([finding]);

    const mapping: Mapping = {
      declName: "brandPrimary",
      sourcePath: "Sources/Color+Brand.swift",
      name: "color.semantic.brand-primary",
      group: "semantic",
      description: "Primary brand accent",
      confidence: "high",
    };

    const result = buildCandidateFile(findings, "color", [mapping]);

    expect(result.category).toBe("color");
    expect(result.candidates).toHaveLength(1);
    const candidate = result.candidates[0];
    expect(candidate?.name).toBe("color.semantic.brand-primary");
    expect(candidate?._llmDerived).toBe(true);
    expect(candidate?._confidence).toBe("high");
    expect(candidate?.$description).toBe("Primary brand accent");
  });

  it("sets $value from finding's normalizedValue, not LLM", () => {
    const finding = makeColorFinding("brandPrimary", "Sources/Color+Brand.swift", RED_COLOR);
    const findings = makeFindingsFile([finding]);

    const mapping: Mapping = {
      declName: "brandPrimary",
      sourcePath: "Sources/Color+Brand.swift",
      name: "color.semantic.brand-primary",
      group: "semantic",
      confidence: "high",
    };

    const result = buildCandidateFile(findings, "color", [mapping]);
    const value = result.candidates[0]?.$value as { colorSpace: string; components: number[] };

    expect(value.colorSpace).toBe("srgb");
    expect(value.components[0]).toBeCloseTo(1.0); // r
    expect(value.components[1]).toBeCloseTo(0.0); // g
    expect(value.components[2]).toBeCloseTo(0.0); // b
    expect(value.components[3]).toBeCloseTo(1.0); // a
  });

  it("populates _provenance from finding source coordinates", () => {
    const finding = makeColorFinding("brandPrimary", "Sources/Color+Brand.swift", RED_COLOR, 42);
    const findings = makeFindingsFile([finding]);

    const mapping: Mapping = {
      declName: "brandPrimary",
      sourcePath: "Sources/Color+Brand.swift",
      name: "color.semantic.brand-primary",
      group: "semantic",
      confidence: "high",
    };

    const result = buildCandidateFile(findings, "color", [mapping]);
    const provenance = result.candidates[0]?._provenance;

    expect(provenance).toHaveLength(1);
    expect(provenance?.[0]?.sourcePath).toBe("Sources/Color+Brand.swift");
    expect(provenance?.[0]?.line).toBe(42);
  });

  it("does not join by declName alone — sourcePath disambiguates", () => {
    // Same declName, different sourcePaths → mapping only matches one
    const finding1 = makeColorFinding("accent", "Sources/File1.swift");
    const finding2 = makeColorFinding("accent", "Sources/File2.swift");
    const findings = makeFindingsFile([finding1, finding2]);

    const mapping: Mapping = {
      declName: "accent",
      sourcePath: "Sources/File1.swift", // only matches finding1
      name: "color.semantic.accent",
      group: "semantic",
      confidence: "high",
    };

    const result = buildCandidateFile(findings, "color", [mapping]);

    const llmDerived = result.candidates.filter((c) => c._llmDerived);
    const mechanical = result.candidates.filter((c) => !c._llmDerived);

    expect(llmDerived).toHaveLength(1);
    expect(llmDerived[0]?.name).toBe("color.semantic.accent");

    expect(mechanical).toHaveLength(1); // finding2 got a mechanical fallback
    expect(mechanical[0]?._llmDerived).toBe(false);
  });
});

describe("merge — mechanical fallback", () => {
  it("generates a mechanical name for findings without a Mapping", () => {
    const finding = makeColorFinding("surfaceDark", "Sources/Color+Surface.swift", BLUE_COLOR);
    const findings = makeFindingsFile([finding]);

    const result = buildCandidateFile(findings, "color", []); // no mappings

    expect(result.candidates).toHaveLength(1);
    const candidate = result.candidates[0];
    expect(candidate?._llmDerived).toBe(false);
    expect(candidate?._confidence).toBe("low");
    // Mechanical name: camelCase → kebab
    expect(candidate?.name).toBe("color.primitive.surface-dark");
  });

  it("falls back to hex-derived name when declName is null and normalizedValue exists", () => {
    const finding: RawFinding = {
      category: "color",
      sourcePath: "Sources/View.swift",
      line: 5,
      col: 0,
      declName: null, // no name
      rawValue: "Color(.sRGB, red: 0.102, green: 0.110, blue: 0.118, opacity: 1)",
      normalizedValue: { r: 0.102, g: 0.11, b: 0.118, a: 1.0, colorSpace: "srgb" },
      context: "extension Color static let",
      isDeclaration: true,
      severity: "info",
    };
    const findings = makeFindingsFile([finding]);

    const result = buildCandidateFile(findings, "color", []);

    expect(result.candidates).toHaveLength(1);
    // Should produce a hex-based name: color.primitive.<hex>
    expect(result.candidates[0]?.name).toMatch(/^color\.primitive\.[0-9a-f]{6}$/);
  });

  it("moves findings with null normalizedValue and no mapping to unresolved", () => {
    const finding: RawFinding = {
      category: "color",
      sourcePath: "Sources/View.swift",
      line: 5,
      col: 0,
      declName: "mystery",
      rawValue: 'Color("SomeAsset")',
      normalizedValue: null, // cannot determine value
      context: "extension Color static let",
      isDeclaration: true,
      assetMissing: true,
      severity: "error",
    };
    const findings = makeFindingsFile([finding]);

    const result = buildCandidateFile(findings, "color", []);

    expect(result.candidates).toHaveLength(0);
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0]?.rawValue).toBe('Color("SomeAsset")');
  });
});

describe("merge — multi-chunk union", () => {
  it("unions mappings from multiple chunks correctly", () => {
    const finding1 = makeColorFinding("brandPrimary", "Sources/Colors.swift", RED_COLOR);
    const finding2 = makeColorFinding("surfaceDark", "Sources/Colors.swift", BLUE_COLOR);
    const findings = makeFindingsFile([finding1, finding2]);

    // Two separate chunks (as if read from two separate JSON files then unioned)
    const chunk1: Mapping[] = [
      {
        declName: "brandPrimary",
        sourcePath: "Sources/Colors.swift",
        name: "color.semantic.brand-primary",
        group: "semantic",
        confidence: "high",
      },
    ];
    const chunk2: Mapping[] = [
      {
        declName: "surfaceDark",
        sourcePath: "Sources/Colors.swift",
        name: "color.semantic.surface-dark",
        group: "semantic",
        confidence: "high",
      },
    ];

    const allMappings = [...chunk1, ...chunk2];
    const result = buildCandidateFile(findings, "color", allMappings);

    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.map((c) => c.name)).toContain("color.semantic.brand-primary");
    expect(result.candidates.map((c) => c.name)).toContain("color.semantic.surface-dark");
  });
});

describe("merge — alphabetical ordering", () => {
  it("sorts candidates alphabetically by name", () => {
    const findings = makeFindingsFile([
      makeColorFinding("zColor", "Sources/Colors.swift", RED_COLOR),
      makeColorFinding("aColor", "Sources/Colors.swift", BLUE_COLOR),
      makeColorFinding("mColor", "Sources/Colors.swift", RED_COLOR),
    ]);

    const mappings: Mapping[] = [
      {
        declName: "zColor",
        sourcePath: "Sources/Colors.swift",
        name: "color.semantic.z-color",
        group: "semantic",
        confidence: "high",
      },
      {
        declName: "aColor",
        sourcePath: "Sources/Colors.swift",
        name: "color.semantic.a-color",
        group: "semantic",
        confidence: "high",
      },
      {
        declName: "mColor",
        sourcePath: "Sources/Colors.swift",
        name: "color.semantic.m-color",
        group: "semantic",
        confidence: "high",
      },
    ];

    const result = buildCandidateFile(findings, "color", mappings);
    const names = result.candidates.map((c) => c.name);

    expect(names).toEqual([
      "color.semantic.a-color",
      "color.semantic.m-color",
      "color.semantic.z-color",
    ]);
  });
});

describe("merge — aliasOf propagation", () => {
  it("sets _inferred when mapping has aliasOf", () => {
    const finding = makeColorFinding("ctaBackground", "Sources/Colors.swift", RED_COLOR);
    const findings = makeFindingsFile([finding]);

    const mapping: Mapping = {
      declName: "ctaBackground",
      sourcePath: "Sources/Colors.swift",
      name: "color.semantic.cta-background",
      group: "semantic",
      aliasOf: "color.primitive.brand-red",
      confidence: "high",
    };

    const result = buildCandidateFile(findings, "color", [mapping]);
    expect(result.candidates[0]?._inferred).toBe("aliasOf:color.primitive.brand-red");
  });
});

describe("merge — dark-mode propagation", () => {
  const DARK_COLOR: NormalizedColor = {
    r: 0.125,
    g: 0.125,
    b: 0.114,
    a: 1.0,
    colorSpace: "display-p3",
  };

  it("emits $modes.dark on the LLM-named candidate when finding carries darkValue", () => {
    const finding: RawFinding = {
      ...makeColorFinding("appBackground", "Assets.xcassets/AppBackground.colorset"),
      assetName: "AppBackground",
      darkValue: DARK_COLOR,
    };
    const findings = makeFindingsFile([finding]);
    const mapping: Mapping = {
      declName: "appBackground",
      sourcePath: "Assets.xcassets/AppBackground.colorset",
      name: "color.semantic.background",
      group: "semantic",
      confidence: "high",
    };

    const result = buildCandidateFile(findings, "color", [mapping]);
    expect(result.candidates[0]?.$modes).toEqual({
      dark: {
        $value: { colorSpace: "display-p3", components: [0.125, 0.125, 0.114, 1.0] },
      },
    });
  });

  it("emits $modes.dark on the mechanical fallback when no mapping is provided", () => {
    const finding: RawFinding = {
      ...makeColorFinding("appBackground", "Assets.xcassets/AppBackground.colorset"),
      darkValue: DARK_COLOR,
    };
    const findings = makeFindingsFile([finding]);

    const result = buildCandidateFile(findings, "color", []);
    expect(result.candidates[0]?.$modes).toEqual({
      dark: {
        $value: { colorSpace: "display-p3", components: [0.125, 0.125, 0.114, 1.0] },
      },
    });
  });

  it("does not set $modes when finding has no darkValue", () => {
    const finding = makeColorFinding("brandPrimary", "Sources/Color+Brand.swift");
    const findings = makeFindingsFile([finding]);

    const result = buildCandidateFile(findings, "color", []);
    expect(result.candidates[0]?.$modes).toBeUndefined();
  });
});

describe("merge — call-site findings excluded from candidates", () => {
  it("does not include call-site (non-declaration) findings in candidates", () => {
    const callSiteFinding: RawFinding = {
      category: "color",
      sourcePath: "Sources/MyView.swift",
      line: 20,
      col: 8,
      declName: null,
      rawValue: ".foregroundStyle(.accent)",
      normalizedValue: null,
      context: ".foregroundStyle(.accent) implicit ShapeStyle",
      isDeclaration: false,
      assetName: "accent",
      severity: "info",
    };
    const findings = makeFindingsFile([callSiteFinding]);

    const result = buildCandidateFile(findings, "color", []);

    expect(result.candidates).toHaveLength(0);
    expect(result.unresolved).toHaveLength(0); // call sites are filtered, not unresolved
  });
});
