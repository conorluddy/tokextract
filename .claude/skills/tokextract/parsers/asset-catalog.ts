/**
 * parsers/asset-catalog.ts
 *
 * Walk `**\/*.xcassets\/*.colorset/Contents.json` and extract light/dark/high-contrast
 * color variants. Output is a map from asset name → NormalizedColor variants.
 *
 * Consumed by: the color pipeline in extract.ts to resolve `Color("AssetName")` findings
 * whose `assetName` field was populated by parsers/color.ts.
 *
 * === COLORSET STRUCTURE ===
 *
 * Xcode asset catalogs store colors in `<Name>.colorset/Contents.json`:
 * {
 *   "colors": [
 *     {
 *       "idiom": "universal",
 *       "appearances": [{ "appearance": "luminosity", "value": "dark" }],
 *       "color": {
 *         "color-space": "srgb",
 *         "components": { "red": "0.102", "green": "0.110", "blue": "0.118", "alpha": "1.000" }
 *       }
 *     }
 *   ]
 * }
 *
 * The `appearances` array is absent for the default (light) entry.
 * `high-contrast` entries have `"value": "high-contrast"`.
 */

import fs from "node:fs";
import path from "node:path";
import glob from "fast-glob";
import type { NormalizedColor } from "./types.js";

// === PUBLIC API ===

export interface ColorsetVariants {
  readonly assetName: string;
  readonly assetPath: string; // path to the .colorset directory
  readonly light: NormalizedColor | null;
  readonly dark: NormalizedColor | null;
  readonly highContrast: NormalizedColor | null;
}

/**
 * Walk all `.xcassets` directories under `rootPath` and extract all colorset variants.
 *
 * @param rootPath  Directory to search (the Swift repo root, matching `--path`)
 * @returns         Map from asset name (e.g. "AppBackground") → ColorsetVariants
 */
export async function loadAssetCatalogColors(
  rootPath: string,
): Promise<Map<string, ColorsetVariants>> {
  const pattern = "**/*.xcassets/**/*.colorset/Contents.json";
  const files = await glob(pattern, {
    cwd: rootPath,
    absolute: true,
    followSymbolicLinks: false,
    // Exclude SPM/Xcode build outputs that copy colorsets into derived locations.
    ignore: ["**/.build/**", "**/DerivedData/**", "**/build/**"],
  });

  const catalog = new Map<string, ColorsetVariants>();

  for (const contentsPath of files) {
    const variants = parseColorsetContents(contentsPath);
    if (variants) {
      // Asset name is the directory name minus .colorset
      // e.g. "AppBackground.colorset/Contents.json" → "AppBackground"
      const colorsetDir = path.dirname(contentsPath);
      const assetName = path.basename(colorsetDir, ".colorset");
      catalog.set(assetName, { ...variants, assetName, assetPath: colorsetDir });
    }
  }

  return catalog;
}

/**
 * Resolve a color asset name against the loaded catalog.
 * Returns null if the asset is not found — the caller should emit `assetMissing: true`.
 */
export function resolveAssetColor(
  assetName: string,
  catalog: Map<string, ColorsetVariants>,
): ColorsetVariants | null {
  return catalog.get(assetName) ?? null;
}

// === PRIVATE HELPERS ===

/** Raw shape of a single entry in the Contents.json `colors` array */
interface RawColorEntry {
  readonly idiom?: string;
  readonly appearances?: ReadonlyArray<{
    readonly appearance: string;
    readonly value: string;
  }>;
  readonly color?: {
    readonly "color-space"?: string;
    readonly components?: {
      readonly red?: string;
      readonly green?: string;
      readonly blue?: string;
      readonly alpha?: string;
    };
  };
}

interface RawContentsJson {
  readonly colors?: readonly RawColorEntry[];
}

function parseColorsetContents(
  contentsPath: string,
): Omit<ColorsetVariants, "assetName" | "assetPath"> | null {
  let raw: string;
  try {
    raw = fs.readFileSync(contentsPath, "utf-8");
  } catch {
    // File unreadable — treat as missing
    return null;
  }

  let parsed: RawContentsJson;
  try {
    parsed = JSON.parse(raw) as RawContentsJson;
  } catch {
    // Malformed JSON — treat as missing
    return null;
  }

  if (!parsed.colors || !Array.isArray(parsed.colors)) {
    return null;
  }

  let light: NormalizedColor | null = null;
  let dark: NormalizedColor | null = null;
  let highContrast: NormalizedColor | null = null;

  for (const entry of parsed.colors) {
    const appearances = entry.appearances ?? [];
    const luminosityAppearance = appearances.find(
      (a: { appearance: string; value: string }) => a.appearance === "luminosity",
    );
    const contrastAppearance = appearances.find(
      (a: { appearance: string; value: string }) => a.appearance === "contrast",
    );

    const isDark = luminosityAppearance?.value === "dark";
    const isLight = !luminosityAppearance || luminosityAppearance.value === "light";
    const isHighContrast = contrastAppearance?.value === "high-contrast";

    const normalized = normalizeColorEntry(entry);
    if (!normalized) continue;

    if (isHighContrast) {
      highContrast = normalized;
    } else if (isDark) {
      dark = normalized;
    } else if (isLight) {
      light = normalized;
    }
  }

  return { light, dark, highContrast };
}

/**
 * Normalize a raw color entry's components to a NormalizedColor.
 * Handles both decimal string ("0.102") and hex string ("1A") component formats.
 * Returns null if the entry has no parseable components.
 */
function normalizeColorEntry(entry: RawColorEntry): NormalizedColor | null {
  const components = entry.color?.components;
  if (!components) return null;

  const colorSpace = entry.color?.["color-space"] ?? "srgb";
  const space: "srgb" | "display-p3" = colorSpace === "display-p3" ? "display-p3" : "srgb";

  const r = parseComponentValue(components.red);
  const g = parseComponentValue(components.green);
  const b = parseComponentValue(components.blue);
  const a = parseComponentValue(components.alpha ?? "1.0");

  if (r === null || g === null || b === null || a === null) return null;

  return { r, g, b, a, colorSpace: space };
}

/**
 * Parse an Xcode color component value.
 * Xcode can write either:
 *   - decimal string: "0.102" (already in [0,1])
 *   - hex string: "1A" or "0x1A" (divide by 255)
 *   - integer string: "26" (divide by 255, since alpha can also be "1.000")
 */
function parseComponentValue(value: string | undefined): number | null {
  if (value === undefined) return null;

  const trimmed = value.trim();

  // Hex format: "0xRR" or bare "RR"
  if (trimmed.startsWith("0x") || (trimmed.length === 2 && /^[0-9A-Fa-f]{2}$/.test(trimmed))) {
    const hex = trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed;
    const n = Number.parseInt(hex, 16);
    return Number.isNaN(n) ? null : n / 255;
  }

  const n = Number.parseFloat(trimmed);
  if (Number.isNaN(n)) return null;

  // If value > 1.0, assume it's a 0-255 integer (rare but seen in some Xcode versions)
  if (n > 1.0) return n / 255;

  return n;
}
