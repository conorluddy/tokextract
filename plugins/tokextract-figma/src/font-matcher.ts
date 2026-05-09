// Resolves a requested {family, style} to an actually-installed Figma font.
// Tokextract often emits PostScript-style families ("JetBrainsMono-Regular")
// while Figma reports the same font as family "JetBrains Mono" + style
// "Regular". We try four progressively-fuzzier matches before giving up.

const STYLE_SUFFIXES = [
  "ExtraBoldItalic", "ExtraLightItalic", "SemiBoldItalic",
  "BoldItalic", "MediumItalic", "LightItalic", "ThinItalic", "BlackItalic",
  "ExtraBold", "ExtraLight", "SemiBold",
  "Bold", "Medium", "Light", "Thin", "Black", "Heavy",
  "Italic", "Regular", "Book",
];

const STYLE_CANONICAL: Record<string, string> = {
  thin: "Thin",
  extralight: "Extra Light", ultralight: "Extra Light",
  light: "Light",
  regular: "Regular", normal: "Regular", book: "Regular",
  medium: "Medium",
  semibold: "Semi Bold", demibold: "Semi Bold",
  bold: "Bold",
  extrabold: "Extra Bold", ultrabold: "Extra Bold",
  black: "Black", heavy: "Black",
  italic: "Italic",
};

export type MatchReason = "exact" | "split" | "normalised" | "fallback";

export interface MatchedFont { fontName: FontName; reason: MatchReason; }

interface FontIndex { byCombined: Map<string, FontName>; byFamily: Map<string, string>; }

let indexCache: FontIndex | null = null;

async function buildIndex(): Promise<FontIndex> {
  if (indexCache) return indexCache;
  const available = await figma.listAvailableFontsAsync();
  const byCombined = new Map<string, FontName>();
  const byFamily = new Map<string, string>();
  for (const font of available) {
    byCombined.set(normalize(font.fontName.family + font.fontName.style), font.fontName);
    if (!byFamily.has(normalize(font.fontName.family))) {
      byFamily.set(normalize(font.fontName.family), font.fontName.family);
    }
  }
  indexCache = { byCombined, byFamily };
  return indexCache;
}

function normalize(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function splitStyleSuffix(family: string): { family: string; style: string } | null {
  for (const suffix of STYLE_SUFFIXES) {
    const pattern = new RegExp(`[-_\\s]${suffix}$`);
    if (pattern.test(family)) {
      const stripped = family.replace(pattern, "");
      if (stripped.length === 0) return null;
      const canonical = STYLE_CANONICAL[suffix.toLowerCase()] ?? suffix;
      return { family: stripped, style: canonical };
    }
  }
  return null;
}

async function tryLoad(font: FontName): Promise<boolean> {
  try {
    await figma.loadFontAsync(font);
    return true;
  } catch {
    return false;
  }
}

export async function findFont(
  requested: FontName,
  fallbacks: FontName[] = [],
): Promise<MatchedFont> {
  if (await tryLoad(requested)) return { fontName: requested, reason: "exact" };

  const split = splitStyleSuffix(requested.family);
  if (split) {
    const splitFont: FontName = { family: split.family, style: split.style };
    if (await tryLoad(splitFont)) return { fontName: splitFont, reason: "split" };
  }

  const index = await buildIndex();
  const candidate = split ?? { family: requested.family, style: requested.style };

  const combinedHit = index.byCombined.get(normalize(candidate.family + candidate.style));
  if (combinedHit && await tryLoad(combinedHit)) return { fontName: combinedHit, reason: "normalised" };

  const familyHit = index.byFamily.get(normalize(candidate.family));
  if (familyHit) {
    const styled: FontName = { family: familyHit, style: candidate.style };
    if (await tryLoad(styled)) return { fontName: styled, reason: "normalised" };
    const regular: FontName = { family: familyHit, style: "Regular" };
    if (await tryLoad(regular)) return { fontName: regular, reason: "normalised" };
  }

  for (const fb of fallbacks) {
    if (await tryLoad(fb)) return { fontName: fb, reason: "fallback" };
  }

  const { byCombined } = index;
  for (const fontName of byCombined.values()) {
    if (await tryLoad(fontName)) return { fontName, reason: "fallback" };
  }
  throw new Error("No fonts available on this Figma instance.");
}

export const DEFAULT_FALLBACKS: FontName[] = [
  { family: "Inter", style: "Regular" },
  { family: "Roboto", style: "Regular" },
];
