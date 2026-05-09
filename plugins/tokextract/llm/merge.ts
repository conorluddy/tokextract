/**
 * llm/merge.ts
 *
 * Node-side merger: joins Mapping[] (LLM slim output) with findings.raw.json
 * to produce a complete CandidateFile.
 *
 * Design invariants:
 * - The LLM never invents $value. normalizedValue always comes from findings.
 * - _provenance is always populated from finding source coordinates.
 * - _llmDerived: true when a Mapping entry exists; false for mechanical fallbacks.
 * - Findings with no Mapping get a mechanical name derived from their normalizedValue.
 * - Output candidates are sorted alphabetical by name within each group tier.
 */

import fs from "node:fs";
import path from "node:path";
import type {
  CandidateFile,
  CandidateToken,
  FindingsFile,
  Mapping,
  NormalizedColor,
  RawFinding,
  TokenCategory,
  UnresolvedToken,
} from "../parsers/types.js";

// === PUBLIC API ===

/**
 * Load all mapping chunk files from llm-out/, merge with findings, return CandidateFile.
 *
 * @param findingsFile  Parsed findings.raw.json
 * @param category      Token category to merge (e.g. "color")
 * @param llmOutDir     Path to .tokextract/llm-out/
 */
export function mergeMappings(
  findingsFile: FindingsFile,
  category: TokenCategory,
  llmOutDir: string,
): CandidateFile {
  const mappings = loadAllMappingChunks(category, llmOutDir);
  return buildCandidateFile(findingsFile, category, mappings);
}

/**
 * Load harmonize recommendations from mapping.harmonize.json if present.
 * Returns an empty array if the file doesn't exist or can't be parsed.
 *
 * @param llmOutDir  Path to .tokextract/llm-out/
 */
export function loadHarmonizeRecommendations(llmOutDir: string): HarmonizeRecommendation[] {
  const harmonizePath = path.join(llmOutDir, "mapping.harmonize.json");
  if (!fs.existsSync(harmonizePath)) return [];

  try {
    const content = fs.readFileSync(harmonizePath, "utf-8");
    const parsed = JSON.parse(content) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed as HarmonizeRecommendation[];
  } catch {
    return [];
  }
}

/** HarmonizeRecommendation as emitted by the harmonize subagent */
export interface HarmonizeRecommendation {
  readonly clusterID: string;
  readonly recommendation: string;
  readonly canonicalToken: {
    readonly name: string;
    readonly group: "primitive" | "semantic" | "component";
    readonly description: string;
  };
  readonly confidence: "high" | "medium" | "low";
  readonly sourceRefs: readonly string[];
}

/**
 * Build a CandidateFile from findings + pre-loaded Mapping[].
 * Exported for unit testing without touching the filesystem.
 */
export function buildCandidateFile(
  findingsFile: FindingsFile,
  category: TokenCategory,
  mappings: readonly Mapping[],
): CandidateFile {
  const declarationFindings = findingsFile.findings.filter(
    (f) => f.category === category && f.isDeclaration,
  );

  // Build join index: (declName + "||" + sourcePath) → Mapping
  const mappingIndex = buildMappingIndex(mappings);

  const candidates: CandidateToken[] = [];
  const unresolved: UnresolvedToken[] = [];

  for (const finding of declarationFindings) {
    const joinKey =
      finding.declName !== null ? buildJoinKey(finding.declName, finding.sourcePath) : null;

    const mapping = joinKey ? mappingIndex.get(joinKey) : undefined;

    if (mapping) {
      const candidate = buildLlmCandidate(finding, mapping);
      if (candidate) {
        candidates.push(candidate);
      } else {
        unresolved.push({
          rawValue: finding.rawValue,
          sourcePath: finding.sourcePath,
          line: finding.line,
          reason: "LLM mapping present but normalizedValue unavailable — cannot emit $value",
        });
      }
    } else {
      // Mechanical fallback: derive a name from declName (camelCase→kebab) or hex value
      const fallback = buildMechanicalCandidate(finding, category);
      if (fallback) {
        candidates.push(fallback);
      } else {
        unresolved.push({
          rawValue: finding.rawValue,
          sourcePath: finding.sourcePath,
          line: finding.line,
          reason:
            finding.declName === null
              ? "finding has no declName and normalizedValue is null — cannot produce a token"
              : "no LLM mapping and normalizedValue is null — cannot produce a token",
        });
      }
    }
  }

  // Sort alphabetically by name within output (group tiers will sort naturally: component < primitive < semantic)
  candidates.sort((a, b) => a.name.localeCompare(b.name));

  return { category, candidates, unresolved };
}

// === PRIVATE HELPERS ===

/**
 * Read all mapping.<category>.<chunk>.json files from llmOutDir.
 * Unions all chunks into a single Mapping[]. Duplicate declName+sourcePath
 * combinations in different chunks use the last-read value (shouldn't happen in practice).
 */
function loadAllMappingChunks(category: TokenCategory, llmOutDir: string): Mapping[] {
  if (!fs.existsSync(llmOutDir)) return [];

  const allMappings: Mapping[] = [];
  const chunkPattern = new RegExp(`^mapping\\.${category}\\.(\\d+)\\.json$`);

  let files: string[];
  try {
    files = fs.readdirSync(llmOutDir);
  } catch {
    return [];
  }

  const chunkFiles = files.filter((f) => chunkPattern.test(f)).sort(); // natural sort: mapping.color.1.json, mapping.color.2.json, ...

  for (const file of chunkFiles) {
    try {
      const content = fs.readFileSync(path.join(llmOutDir, file), "utf-8");
      const parsed = JSON.parse(content) as unknown;
      if (Array.isArray(parsed)) {
        allMappings.push(...(parsed as Mapping[]));
      }
    } catch {
      // Skip malformed chunk — merger is resilient; unfound mappings get mechanical fallback
    }
  }

  return allMappings;
}

function buildMappingIndex(mappings: readonly Mapping[]): Map<string, Mapping> {
  const index = new Map<string, Mapping>();
  for (const mapping of mappings) {
    index.set(buildJoinKey(mapping.declName, mapping.sourcePath), mapping);
  }
  return index;
}

function buildJoinKey(declName: string, sourcePath: string): string {
  return `${declName}||${sourcePath}`;
}

/**
 * Build a CandidateToken from a finding + LLM Mapping.
 * Returns null if the finding has no normalizedValue (cannot emit a $value).
 */
function buildLlmCandidate(finding: RawFinding, mapping: Mapping): CandidateToken | null {
  const dtcgValue = findingToDtcgValue(finding);
  if (dtcgValue === null) return null;

  const modes = buildDarkMode(finding);

  const candidate: CandidateToken = {
    name: mapping.name,
    $type: categoryToDtcgType(finding.category),
    $value: dtcgValue,
    ...(modes ? { $modes: modes } : {}),
    ...(mapping.description ? { $description: mapping.description } : {}),
    _provenance: [
      {
        sourcePath: finding.sourcePath,
        line: finding.line,
        rawValue: finding.rawValue,
      },
    ],
    _confidence: mapping.confidence,
    _llmDerived: true,
    ...(mapping.aliasOf ? { _inferred: `aliasOf:${mapping.aliasOf}` } : {}),
  };

  return candidate;
}

/**
 * Build a mechanical CandidateToken for findings without an LLM Mapping.
 * Returns null if normalizedValue is null (value cannot be determined).
 */
function buildMechanicalCandidate(
  finding: RawFinding,
  category: TokenCategory,
): CandidateToken | null {
  const dtcgValue = findingToDtcgValue(finding);
  if (dtcgValue === null) return null;

  const mechanicalName = buildMechanicalName(finding, category);
  const modes = buildDarkMode(finding);

  return {
    name: mechanicalName,
    $type: categoryToDtcgType(category),
    $value: dtcgValue,
    ...(modes ? { $modes: modes } : {}),
    _provenance: [
      {
        sourcePath: finding.sourcePath,
        line: finding.line,
        rawValue: finding.rawValue,
      },
    ],
    _confidence: "low",
    _llmDerived: false,
  };
}

/**
 * Derive a mechanical token name from the finding.
 * Format: <category>.primitive.<slug>
 *
 * For colors: hex from normalizedValue, e.g. "color.primitive.1a1c1e"
 * For named asset colors: camel→kebab from declName, e.g. "color.primitive.grапla-accent-primary"
 * For other categories: camel→kebab from declName or rawValue slug
 */
function buildMechanicalName(finding: RawFinding, category: TokenCategory): string {
  const prefix = `${category}.primitive`;

  // If declName available, convert camelCase → kebab
  if (finding.declName) {
    return `${prefix}.${camelToKebab(finding.declName)}`;
  }

  // Color fallback: hex from normalizedValue
  if (category === "color" && finding.normalizedValue) {
    const hex = colorToHex(finding.normalizedValue as NormalizedColor);
    if (hex) return `${prefix}.${hex}`;
  }

  // Last resort: slug from rawValue
  const slug = finding.rawValue
    .replace(/[^a-zA-Z0-9]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase()
    .slice(0, 40);

  return `${prefix}.${slug || "unknown"}`;
}

function camelToKebab(name: string): string {
  return name
    .replace(/([A-Z])/g, "-$1")
    .toLowerCase()
    .replace(/^-/, "");
}

function colorToHex(color: NormalizedColor): string | null {
  const r = Math.round(color.r * 255)
    .toString(16)
    .padStart(2, "0");
  const g = Math.round(color.g * 255)
    .toString(16)
    .padStart(2, "0");
  const b = Math.round(color.b * 255)
    .toString(16)
    .padStart(2, "0");
  return `${r}${g}${b}`;
}

/**
 * Convert a finding's normalizedValue to a DTCG-compatible $value.
 * Returns null when normalizedValue is absent or unresolvable.
 */
/**
 * Build a `$modes` object from a finding's dark-mode color variant, when present.
 * Returns null when the finding has no dark variant (or it isn't a color).
 */
function buildDarkMode(finding: RawFinding): Record<string, { $value: unknown }> | null {
  if (finding.category !== "color") return null;
  const dark = finding.darkValue;
  if (!dark) return null;
  return {
    dark: {
      $value: {
        colorSpace: dark.colorSpace ?? "srgb",
        components: [dark.r, dark.g, dark.b, dark.a ?? 1.0],
      },
    },
  };
}

function findingToDtcgValue(finding: RawFinding): unknown | null {
  if (finding.normalizedValue === null || finding.normalizedValue === undefined) {
    return null;
  }

  if (finding.category === "color") {
    const c = finding.normalizedValue as NormalizedColor;
    if (typeof c.r === "number" && typeof c.g === "number" && typeof c.b === "number") {
      return {
        colorSpace: c.colorSpace ?? "srgb",
        components: [c.r, c.g, c.b, c.a ?? 1.0],
      };
    }
    return null;
  }

  // For other categories, return normalizedValue as-is
  return finding.normalizedValue;
}

function categoryToDtcgType(category: TokenCategory): string {
  const typeMap: Record<TokenCategory, string> = {
    color: "color",
    typography: "typography",
    spacing: "dimension",
    cornerRadius: "dimension",
    shadow: "shadow",
    animation: "duration",
    component: "custom",
    liquidGlass: "custom",
    theme: "custom",
  };
  return typeMap[category] ?? "custom";
}
