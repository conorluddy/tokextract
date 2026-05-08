/**
 * tests/e2e/golden.test.ts
 *
 * Golden-file test: run the full --no-llm pipeline on the grapla-color-only fixture
 * and compare tokens.json against the expected golden file.
 *
 * This test runs the pipeline programmatically rather than shelling out to the CLI,
 * so it doesn't require a dist build and works in Vitest directly.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import glob from "fast-glob";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clusterColors } from "../../analyzers/cluster-color.js";
import { formatLintErrors, lintDesignMd } from "../../emitters/design-md-lint.js";
import { emitDesignMd } from "../../emitters/design-md.js";
import { buildMechanicalColorCandidates, emitDtcg } from "../../emitters/dtcg.js";
import { loadAssetCatalogColors, resolveAssetColor } from "../../parsers/asset-catalog.js";
import { extractColors } from "../../parsers/color.js";
import type { RawFinding } from "../../parsers/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(__dirname, "../fixtures/grapla-color-only");
const GOLDEN_FILE = path.resolve(FIXTURE_DIR, "expected/tokens.json");
const SCHEMA_PATH = path.resolve(__dirname, "../../schemas/dtcg-2025.10.json");

let outputDir: string;

beforeAll(() => {
  outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "extractoken-golden-"));
});

afterAll(() => {
  fs.rmSync(outputDir, { recursive: true, force: true });
});

describe("golden file — grapla-color-only fixture", () => {
  it("produces tokens.json matching the golden file (±whitespace)", async () => {
    // Stage 1: Discover Swift files
    const swiftFiles = await glob("**/*.swift", {
      cwd: FIXTURE_DIR,
      absolute: true,
      followSymbolicLinks: false,
    });
    expect(swiftFiles.length).toBeGreaterThan(0);

    // Stage 2: Parse colors
    const allFindings: RawFinding[] = [];
    for (const filePath of swiftFiles) {
      const source = fs.readFileSync(filePath, "utf-8");
      const relativePath = path.relative(FIXTURE_DIR, filePath);
      const findings = extractColors(source, relativePath);
      allFindings.push(...findings);
    }

    // Stage 2b: Asset catalog
    const catalog = await loadAssetCatalogColors(FIXTURE_DIR);
    for (const finding of allFindings) {
      if (finding.assetName) {
        const resolved = resolveAssetColor(finding.assetName, catalog);
        if (!resolved) {
          const idx = allFindings.indexOf(finding);
          if (idx !== -1) {
            allFindings[idx] = {
              ...finding,
              assetMissing: true,
              severity: "error",
              normalizedValue: null,
            };
          }
        }
      }
    }

    const declarationFindings = allFindings.filter((f) => f.isDeclaration);

    // Stage 4: Cluster
    clusterColors(declarationFindings, 2.5);

    // Stage 6b: Mechanical candidates
    const candidates = buildMechanicalColorCandidates(allFindings);
    expect(candidates.candidates.length).toBeGreaterThan(0);

    // Stage 7a: Emit
    const result = emitDtcg([candidates], { outputDir, schemaPath: SCHEMA_PATH });
    expect(result.validationPassed).toBe(true);
    expect(result.tokenCount).toBeGreaterThan(0);

    // Compare against golden
    const actualJson = JSON.parse(fs.readFileSync(result.tokensPath, "utf-8")) as Record<
      string,
      unknown
    >;
    const goldenJson = JSON.parse(fs.readFileSync(GOLDEN_FILE, "utf-8")) as Record<string, unknown>;

    expect(actualJson).toEqual(goldenJson);
  });

  it("produces DESIGN.md that passes all lint rules in stub mode", async () => {
    // Get candidates (rerun pipeline)
    const swiftFiles = await glob("**/*.swift", {
      cwd: FIXTURE_DIR,
      absolute: true,
    });
    const allFindings: RawFinding[] = [];
    for (const filePath of swiftFiles) {
      const source = fs.readFileSync(filePath, "utf-8");
      const relativePath = path.relative(FIXTURE_DIR, filePath);
      allFindings.push(...extractColors(source, relativePath));
    }

    const candidates = buildMechanicalColorCandidates(allFindings);

    const designMdPath = emitDesignMd(
      { colorTokens: candidates.candidates },
      {
        outputDir,
        appName: "GraplaColorOnly",
        extractedAt: new Date().toISOString(),
        isStub: true,
      },
    );

    expect(fs.existsSync(designMdPath)).toBe(true);

    const content = fs.readFileSync(designMdPath, "utf-8");
    const tokensJson = JSON.parse(
      fs.readFileSync(path.join(outputDir, "tokens.json"), "utf-8"),
    ) as Record<string, unknown>;

    const results = lintDesignMd(content, tokensJson, { isStub: true });
    const errors = formatLintErrors(results);
    expect(errors).toBe("");
  });

  it("at least one near-duplicate cluster exists in the fixture (surfaceDark ≈ surface dark variant)", async () => {
    const swiftFiles = await glob("**/*.swift", {
      cwd: FIXTURE_DIR,
      absolute: true,
    });
    const allFindings: RawFinding[] = [];
    for (const filePath of swiftFiles) {
      const source = fs.readFileSync(filePath, "utf-8");
      const relativePath = path.relative(FIXTURE_DIR, filePath);
      allFindings.push(...extractColors(source, relativePath));
    }

    const declarationFindings = allFindings.filter((f) => f.isDeclaration);
    const { clusters } = clusterColors(declarationFindings, 2.5);

    // The fixture has surfaceDark (0.102, 0.110, 0.118) which is very close to
    // the dark variant of the Color(light:dark:) surface token (#1A1C1E = 0.102, 0.11, 0.118)
    expect(clusters.length).toBeGreaterThanOrEqual(1);
  });
});
