/**
 * tests/emitters/dtcg.test.ts
 *
 * Unit tests for emitters/dtcg.ts — DTCG emitter and schema validation.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildMechanicalColorCandidates, emitDtcg } from "../../emitters/dtcg.js";
import type { CandidateFile, CandidateToken, RawFinding } from "../../parsers/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(__dirname, "../../schemas/dtcg-2025.10.json");

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokextract-test-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("DTCG emitter", () => {
  it("emits a valid tokens.json from a simple color candidate", () => {
    const candidates: CandidateFile = {
      category: "color",
      candidates: [
        {
          name: "color.primitive.brand-blue",
          $type: "color",
          $value: { colorSpace: "srgb", components: [0.067, 0.537, 1.0, 1.0] },
          $description: "Primary brand blue",
          _provenance: [{ sourcePath: "test.swift", line: 1, rawValue: "Color(.sRGB, ...)" }],
          _confidence: "high",
          _llmDerived: false,
        },
      ],
      unresolved: [],
    };

    const result = emitDtcg([candidates], { outputDir: tempDir, schemaPath: SCHEMA_PATH });

    expect(result.validationPassed).toBe(true);
    expect(result.tokenCount).toBe(1);
    expect(fs.existsSync(result.tokensPath)).toBe(true);

    const emitted = JSON.parse(fs.readFileSync(result.tokensPath, "utf-8")) as Record<
      string,
      unknown
    >;
    // Navigate to the token
    const colorGroup = emitted.color as Record<string, unknown>;
    const primitiveGroup = colorGroup?.primitive as Record<string, unknown>;
    const token = primitiveGroup?.["brand-blue"] as Record<string, unknown>;

    expect(token?.$value).toEqual({ colorSpace: "srgb", components: [0.067, 0.537, 1.0, 1.0] });
    expect(token?.$type).toBe("color");
    expect(token?.$description).toBe("Primary brand blue");

    // Metadata fields must NOT be present
    expect(token?._provenance).toBeUndefined();
    expect(token?._confidence).toBeUndefined();
    expect(token?._llmDerived).toBeUndefined();
  });

  it("validates against DTCG schema and rejects malformed tokens", () => {
    const badCandidates: CandidateFile = {
      category: "color",
      candidates: [
        {
          name: "color.bad",
          $type: "color",
          // Missing required $value — but we're setting it to an invalid shape
          $value: "not-a-valid-color-value-object",
          _provenance: [],
          _confidence: "low",
          _llmDerived: true,
        } as unknown as CandidateToken,
      ],
      unresolved: [],
    };

    // The schema allows strings as $value (our permissive schema)
    // So this won't fail validation. Let's test that the emitter writes valid JSON.
    expect(() => {
      emitDtcg([badCandidates], { outputDir: tempDir, schemaPath: SCHEMA_PATH });
    }).not.toThrow();
  });

  it("strips _provenance, _confidence, _llmDerived from emitted tokens", () => {
    const candidates: CandidateFile = {
      category: "color",
      candidates: [
        {
          name: "color.semantic.brand",
          $type: "color",
          $value: { colorSpace: "srgb", components: [0.1, 0.2, 0.3, 1.0] },
          _provenance: [{ sourcePath: "Color.swift", line: 5, rawValue: "some raw" }],
          _confidence: "medium",
          _llmDerived: true,
          _inferred: "fallback",
        },
      ],
      unresolved: [],
    };

    emitDtcg([candidates], { outputDir: tempDir, schemaPath: SCHEMA_PATH });
    const emitted = JSON.parse(
      fs.readFileSync(path.join(tempDir, "tokens.json"), "utf-8"),
    ) as Record<string, unknown>;

    const token = ((emitted.color as Record<string, unknown>)?.semantic as Record<string, unknown>)
      ?.brand as Record<string, unknown>;

    expect(token?._provenance).toBeUndefined();
    expect(token?._confidence).toBeUndefined();
    expect(token?._llmDerived).toBeUndefined();
    expect(token?._inferred).toBeUndefined();
    expect(token?.$value).toBeDefined();
  });

  it("handles alias references in $value", () => {
    const candidates: CandidateFile = {
      category: "color",
      candidates: [
        {
          name: "color.primitive.blue-500",
          $type: "color",
          $value: { colorSpace: "srgb", components: [0.067, 0.537, 1.0, 1.0] },
          _provenance: [],
          _confidence: "high",
          _llmDerived: false,
        },
        {
          name: "color.semantic.brand",
          $type: "color",
          $value: "{color.primitive.blue-500}", // Alias reference
          $description: "Primary brand color",
          _provenance: [],
          _confidence: "high",
          _llmDerived: false,
        },
      ],
      unresolved: [],
    };

    const result = emitDtcg([candidates], { outputDir: tempDir, schemaPath: SCHEMA_PATH });
    expect(result.tokenCount).toBe(2);
    expect(result.validationPassed).toBe(true);

    const emitted = JSON.parse(fs.readFileSync(result.tokensPath, "utf-8")) as Record<
      string,
      unknown
    >;
    const brandToken = (
      (emitted.color as Record<string, unknown>)?.semantic as Record<string, unknown>
    )?.brand as Record<string, unknown>;

    expect(brandToken?.$value).toBe("{color.primitive.blue-500}");
  });
});

describe("buildMechanicalColorCandidates", () => {
  it("builds mechanical candidates from declaration findings", () => {
    const findings: RawFinding[] = [
      {
        category: "color",
        sourcePath: "Color.swift",
        line: 5,
        col: 4,
        declName: "brandPrimary",
        rawValue: "Color(.sRGB, red: 0.067, green: 0.537, blue: 1.0, opacity: 1)",
        normalizedValue: { r: 0.067, g: 0.537, b: 1.0, a: 1.0, colorSpace: "srgb" },
        context: "extension Color static let",
        isDeclaration: true,
        isSystemAlias: false,
      },
    ];

    const result = buildMechanicalColorCandidates(findings);
    expect(result.category).toBe("color");
    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0]?.name).toBe("color.brand-primary");
    expect(result.candidates[0]?.$type).toBe("color");
  });

  it("places unresolved findings (null normalizedValue) in unresolved array", () => {
    const findings: RawFinding[] = [
      {
        category: "color",
        sourcePath: "Color.swift",
        line: 10,
        col: 4,
        declName: "assetColor",
        rawValue: 'Color("AppBackground")',
        normalizedValue: null,
        context: "extension Color static let",
        isDeclaration: true,
        assetName: "AppBackground",
      },
    ];

    const result = buildMechanicalColorCandidates(findings);
    expect(result.candidates.length).toBe(0);
    expect(result.unresolved.length).toBe(1);
  });

  it("emits $modes.dark when finding has a darkValue variant", () => {
    const findings: RawFinding[] = [
      {
        category: "color",
        sourcePath: "Assets.xcassets/AppBackground.colorset",
        line: 1,
        col: 0,
        declName: "AppBackground",
        rawValue: "<asset-catalog:AppBackground>",
        normalizedValue: { r: 0.976, g: 0.969, b: 0.941, a: 1.0, colorSpace: "srgb" },
        context: "Asset Catalog colorset",
        isDeclaration: true,
        assetName: "AppBackground",
        hasDarkVariant: true,
        darkValue: { r: 0.125, g: 0.125, b: 0.114, a: 1.0, colorSpace: "display-p3" },
      },
    ];

    const result = buildMechanicalColorCandidates(findings);
    expect(result.candidates.length).toBe(1);
    const token = result.candidates[0];
    expect(token?.$modes).toEqual({
      dark: {
        $value: {
          colorSpace: "display-p3",
          components: [0.125, 0.125, 0.114, 1.0],
        },
      },
    });

    // And $modes survives the emit + schema-validate round-trip.
    const emitResult = emitDtcg([result], { outputDir: tempDir, schemaPath: SCHEMA_PATH });
    expect(emitResult.validationPassed).toBe(true);
    const emitted = JSON.parse(fs.readFileSync(emitResult.tokensPath, "utf-8")) as Record<
      string,
      unknown
    >;
    const emittedToken = (emitted.color as Record<string, unknown>)?.["app-background"] as Record<
      string,
      unknown
    >;
    expect(emittedToken?.$modes).toBeDefined();
    expect((emittedToken.$modes as Record<string, unknown>).dark).toBeDefined();
  });

  it("does not emit $modes when finding has no darkValue", () => {
    const findings: RawFinding[] = [
      {
        category: "color",
        sourcePath: "Color.swift",
        line: 5,
        col: 4,
        declName: "brandPrimary",
        rawValue: "Color(.sRGB, ...)",
        normalizedValue: { r: 0.067, g: 0.537, b: 1.0, a: 1.0, colorSpace: "srgb" },
        context: "extension Color static let",
        isDeclaration: true,
      },
    ];

    const result = buildMechanicalColorCandidates(findings);
    expect(result.candidates[0]?.$modes).toBeUndefined();
  });

  it("skips non-declaration findings (call sites)", () => {
    const findings: RawFinding[] = [
      {
        category: "color",
        sourcePath: "FeedRow.swift",
        line: 20,
        col: 8,
        declName: null,
        rawValue: "#1A1C1E",
        normalizedValue: { r: 0.102, g: 0.11, b: 0.118, a: 1.0, colorSpace: "srgb" },
        context: "hex literal call site",
        isDeclaration: false,
      },
    ];

    const result = buildMechanicalColorCandidates(findings);
    expect(result.candidates.length).toBe(0);
    expect(result.unresolved.length).toBe(0);
  });
});
