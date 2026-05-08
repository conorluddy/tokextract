/**
 * tests/parsers/asset-catalog.test.ts
 *
 * Unit tests for parsers/asset-catalog.ts
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadAssetCatalogColors, resolveAssetColor } from "../../parsers/asset-catalog.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(__dirname, "../fixtures/grapla-color-only");

describe("asset-catalog parser", () => {
  it("loads colorset variants from the fixture xcassets directory", async () => {
    const catalog = await loadAssetCatalogColors(FIXTURE_DIR);
    expect(catalog.size).toBeGreaterThan(0);
    expect(catalog.has("AppBackground")).toBe(true);
  });

  it("extracts light and dark variants from AppBackground.colorset", async () => {
    const catalog = await loadAssetCatalogColors(FIXTURE_DIR);
    const bg = resolveAssetColor("AppBackground", catalog);

    expect(bg).not.toBeNull();
    expect(bg?.light).not.toBeNull();
    expect(bg?.dark).not.toBeNull();

    // Light: white (1, 1, 1, 1)
    expect(bg?.light?.r).toBeCloseTo(1.0, 3);
    expect(bg?.light?.g).toBeCloseTo(1.0, 3);
    expect(bg?.light?.b).toBeCloseTo(1.0, 3);
    expect(bg?.light?.a).toBeCloseTo(1.0, 3);

    // Dark: (0.102, 0.110, 0.118, 1)
    expect(bg?.dark?.r).toBeCloseTo(0.102, 3);
    expect(bg?.dark?.g).toBeCloseTo(0.11, 3);
    expect(bg?.dark?.b).toBeCloseTo(0.118, 3);
    expect(bg?.dark?.a).toBeCloseTo(1.0, 3);
  });

  it("returns null for a non-existent asset name", async () => {
    const catalog = await loadAssetCatalogColors(FIXTURE_DIR);
    const result = resolveAssetColor("NonExistentColor", catalog);
    expect(result).toBeNull();
  });

  it("records the correct color space", async () => {
    const catalog = await loadAssetCatalogColors(FIXTURE_DIR);
    const bg = resolveAssetColor("AppBackground", catalog);
    expect(bg?.light?.colorSpace).toBe("srgb");
    expect(bg?.dark?.colorSpace).toBe("srgb");
  });
});
