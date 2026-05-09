/**
 * emitters/dtcg.ts
 *
 * DTCG 2025.10 emitter. Reads CandidateFile(s) from .tokextract/llm-out/ (or
 * from deterministic mechanical candidates in --no-llm mode), strips metadata
 * fields (_provenance, _confidence, _llmDerived, _inferred, unresolved), and
 * writes a validated tokens.json.
 *
 * Schema validation via Ajv runs before writing — a validation failure is a
 * hard error (fail-fast per PRD §7.1).
 *
 * Slice 3: all 9 categories. Each category has a dedicated builder for --no-llm
 * mechanical candidates. The emitter itself is generic — it just flattens
 * CandidateFile.candidates into the DTCG tree.
 *
 * Per-category DTCG type mapping (PRD §7 table):
 * - color       → $type: "color"           — NormalizedColor → {colorSpace, components}
 * - typography  → $type: "typography"      — composite with fontFamily, fontSize, etc.
 *                                            + $extensions.swiftui.relativeTo
 * - spacing     → $type: "dimension"       — pixel number
 * - cornerRadius→ $type: "dimension"       — pixel number; + $extensions.swiftui.style
 * - shadow      → $type: "shadow"          — DTCG composite (color, offsetX, offsetY, blur, spread)
 * - animation   → $type: "duration"        — via $extensions.motion (DTCG motion draft)
 * - component   → $type: "custom"          — $extensions.swiftui.modifierChain
 * - liquidGlass → $type: "custom"          — $extensions.<vendor>.material
 * - theme       → $type: "custom"          — $extensions.<vendor>.theme
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
const require = createRequire(import.meta.url);

// Use Ajv with JSON Schema draft 2020-12 support
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const Ajv = require("ajv/dist/2020");
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const addFormats = require("ajv-formats");

import type { CandidateFile, CandidateToken } from "../parsers/types.js";
import { buildColorModes } from "./color-modes.js";

// === PUBLIC API ===

export interface EmitDtcgOptions {
  readonly outputDir: string;
  readonly schemaPath: string;
  /** Vendor namespace for $extensions.<vendor>.* keys (from Info.plist or fallback) */
  readonly vendorNamespace?: string;
}

export interface EmitDtcgResult {
  readonly tokensPath: string;
  readonly tokenCount: number;
  readonly validationPassed: boolean;
}

/**
 * Emit a validated tokens.json from one or more CandidateFile objects.
 *
 * @param candidateFiles  Candidates from LLM normalize pass (or mechanical fallback)
 * @param options         Output directory and schema path
 */
export function emitDtcg(
  candidateFiles: readonly CandidateFile[],
  options: EmitDtcgOptions,
): EmitDtcgResult {
  const tokensJson = buildTokensJson(candidateFiles);
  const tokenCount = countTokens(tokensJson);

  // Validate before writing — fail-fast
  validateAgainstSchema(tokensJson, options.schemaPath);

  const tokensPath = path.join(options.outputDir, "tokens.json");
  fs.mkdirSync(options.outputDir, { recursive: true });
  fs.writeFileSync(tokensPath, `${JSON.stringify(tokensJson, null, 2)}\n`, "utf-8");

  return { tokensPath, tokenCount, validationPassed: true };
}

// === PRIVATE HELPERS ===

type TokensJson = Record<string, unknown>;

/**
 * Build the tokens.json object from candidate files.
 *
 * DTCG structure: tokens are organized into nested groups.
 * Color token name "color.semantic.brand" → { color: { semantic: { brand: {...} } } }
 *
 * Strips metadata fields that must not appear in the final output:
 * _provenance, _confidence, _llmDerived, _inferred
 * Also strips the `unresolved` array (goes to audit.md instead).
 */
function buildTokensJson(candidateFiles: readonly CandidateFile[]): TokensJson {
  const tokens: TokensJson = {};

  for (const candidateFile of candidateFiles) {
    for (const candidate of candidateFile.candidates) {
      insertToken(tokens, candidate);
    }
  }

  return tokens;
}

/**
 * Insert a single candidate token into the token tree at its path.
 * Token name "color.semantic.brand" → tokens.color.semantic.brand
 */
function insertToken(tokens: TokensJson, candidate: CandidateToken): void {
  const segments = candidate.name.split(".");
  if (segments.length === 0) return;

  // Navigate/create intermediate groups
  let current = tokens;
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i];
    if (!segment) continue;

    if (!(segment in current)) {
      current[segment] = {};
    }
    const next = current[segment];
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      // Segment collision — skip this token
      return;
    }
    current = next as TokensJson;
  }

  const leafName = segments[segments.length - 1];
  if (!leafName) return;

  // Build the DTCG token object — only include DTCG-spec fields
  const tokenEntry: Record<string, unknown> = {
    $value: candidate.$value,
  };

  if (candidate.$type !== undefined) {
    tokenEntry.$type = candidate.$type;
  }
  if (candidate.$description !== undefined) {
    tokenEntry.$description = candidate.$description;
  }
  if (candidate.$extensions !== undefined) {
    tokenEntry.$extensions = candidate.$extensions;
  }
  if (candidate.$modes !== undefined) {
    tokenEntry.$modes = candidate.$modes;
  }

  // Explicitly NOT including: _provenance, _confidence, _llmDerived, _inferred
  current[leafName] = tokenEntry;
}

/**
 * Count the number of leaf tokens (objects with $value) in the token tree.
 */
function countTokens(tokensJson: TokensJson): number {
  let count = 0;

  function walk(obj: unknown): void {
    if (typeof obj !== "object" || obj === null) return;
    const record = obj as Record<string, unknown>;
    if ("$value" in record) {
      count++;
      return;
    }
    for (const value of Object.values(record)) {
      walk(value);
    }
  }

  walk(tokensJson);
  return count;
}

/**
 * Validate the tokens.json object against the bundled DTCG JSON Schema.
 * Throws with an actionable error message on validation failure.
 */
function validateAgainstSchema(tokensJson: TokensJson, schemaPath: string): void {
  let schemaContent: string;
  try {
    schemaContent = fs.readFileSync(schemaPath, "utf-8");
  } catch (error) {
    throw new Error(
      `DTCG schema not found at ${schemaPath}. Ensure schemas/dtcg-2025.10.json exists in the tokextract skill directory. Original error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let schema: unknown;
  try {
    schema = JSON.parse(schemaContent);
  } catch (error) {
    throw new Error(
      `DTCG schema at ${schemaPath} is not valid JSON: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment
  const ajv = new Ajv({ strict: false, allErrors: true });
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call
  addFormats(ajv);

  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
  const validate = ajv.compile(schema);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call
  const valid = validate(tokensJson) as boolean;

  if (!valid) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const errors = (validate.errors ?? []) as Array<{ instancePath: string; message?: string }>;
    const errorMessages = errors
      .slice(0, 5)
      .map((e) => `  - ${e.instancePath || "root"}: ${e.message ?? "unknown error"}`)
      .join("\n");

    throw new Error(
      `tokens.json failed DTCG schema validation. Fix these errors before writing output:\n${errorMessages}${errors.length > 5 ? `\n  ... and ${errors.length - 5} more errors` : ""}`,
    );
  }
}

/**
 * Build a mechanical CandidateFile from raw color findings in --no-llm mode.
 * Token names are mechanical: color-<hexvalue> or color-<declName>.
 * These lack semantic naming but are valid DTCG and useful for CI testing.
 */
export function buildMechanicalColorCandidates(
  findings: readonly import("../parsers/types.js").RawFinding[],
): CandidateFile {
  const candidates: CandidateToken[] = [];
  const unresolved: CandidateFile["unresolved"][number][] = [];
  const seen = new Set<string>();

  for (const finding of findings) {
    if (finding.category !== "color") continue;
    if (!finding.isDeclaration) continue;
    if (finding.isSystemAlias) continue;

    // Skip asset-catalog references with missing files
    if (finding.assetMissing) {
      unresolved.push({
        rawValue: finding.rawValue,
        sourcePath: finding.sourcePath,
        line: finding.line,
        reason: "Asset Catalog file missing",
      });
      continue;
    }

    // Build a mechanical token name
    const tokenName = buildMechanicalTokenName(finding);
    if (seen.has(tokenName)) continue;
    seen.add(tokenName);

    const normalizedColor = finding.normalizedValue as
      | import("../parsers/types.js").NormalizedColor
      | null;

    if (!normalizedColor) {
      unresolved.push({
        rawValue: finding.rawValue,
        sourcePath: finding.sourcePath,
        line: finding.line,
        reason: finding.requiresSemanticResolution
          ? "UIColor semantic resolution required"
          : "Normalized value unavailable — needs LLM pass",
      });
      continue;
    }

    const modes = buildColorModes(finding);
    const candidate: CandidateToken = {
      name: tokenName,
      $type: "color",
      $value: {
        colorSpace: normalizedColor.colorSpace,
        components: [normalizedColor.r, normalizedColor.g, normalizedColor.b, normalizedColor.a],
      },
      $description: `Extracted from ${finding.sourcePath}:${finding.line}`,
      ...(modes ? { $modes: modes } : {}),
      _provenance: [
        {
          sourcePath: finding.sourcePath,
          line: finding.line,
          rawValue: finding.rawValue,
        },
      ],
      _confidence: "high",
      _llmDerived: false,
    };
    candidates.push(candidate);
  }

  return { category: "color", candidates, unresolved };
}

function buildMechanicalTokenName(finding: import("../parsers/types.js").RawFinding): string {
  if (finding.declName) {
    // Convert camelCase to kebab-case and prefix with color.
    const kebab = finding.declName
      .replace(/([A-Z])/g, "-$1")
      .toLowerCase()
      .replace(/^-/, "");
    return `color.${kebab}`;
  }

  // Fall back to hex value
  const normalized = finding.normalizedValue as
    | import("../parsers/types.js").NormalizedColor
    | null;
  if (normalized) {
    const r = Math.round(normalized.r * 255)
      .toString(16)
      .padStart(2, "0");
    const g = Math.round(normalized.g * 255)
      .toString(16)
      .padStart(2, "0");
    const b = Math.round(normalized.b * 255)
      .toString(16)
      .padStart(2, "0");
    return `color.${r}${g}${b}`;
  }

  return `color.unknown-${finding.line}`;
}

// === MULTI-CATEGORY MECHANICAL CANDIDATES (T3.4) ===

/**
 * Build mechanical CandidateFile[] for all categories in --no-llm mode.
 * Returns one CandidateFile per category that has at least one declaration finding.
 * vendorNamespace is used for $extensions.<vendor>.* keys on glass, animation, component, theme.
 */
export function buildMechanicalCandidates(
  findings: readonly import("../parsers/types.js").RawFinding[],
  vendorNamespace = "com.unknown",
): CandidateFile[] {
  const categories: import("../parsers/types.js").TokenCategory[] = [
    "color",
    "typography",
    "spacing",
    "cornerRadius",
    "shadow",
    "animation",
    "component",
    "liquidGlass",
    "theme",
  ];

  const result: CandidateFile[] = [];

  for (const category of categories) {
    const categoryFindings = findings.filter((f) => f.category === category && f.isDeclaration);
    if (categoryFindings.length === 0) continue;

    const file = buildCategoryMechanicalFile(categoryFindings, category, vendorNamespace);
    result.push(file);
  }

  return result;
}

/**
 * Build a mechanical CandidateFile for a single category.
 */
function buildCategoryMechanicalFile(
  findings: readonly import("../parsers/types.js").RawFinding[],
  category: import("../parsers/types.js").TokenCategory,
  vendorNamespace: string,
): CandidateFile {
  if (category === "color") {
    return buildMechanicalColorCandidates(findings);
  }

  const candidates: CandidateToken[] = [];
  const unresolved: CandidateFile["unresolved"][number][] = [];
  const seen = new Set<string>();

  for (const finding of findings) {
    if (finding.normalizedValue === null || finding.normalizedValue === undefined) {
      if (finding.declName !== null) {
        // Produce a best-effort token with null value marker
        unresolved.push({
          rawValue: finding.rawValue,
          sourcePath: finding.sourcePath,
          line: finding.line,
          reason: "normalizedValue unavailable — needs LLM pass",
        });
      }
      continue;
    }

    const tokenName = buildCategoryMechanicalName(finding, category);
    if (seen.has(tokenName)) continue;
    seen.add(tokenName);

    const candidate = buildCategoryCandidate(finding, category, tokenName, vendorNamespace);
    if (candidate) candidates.push(candidate);
  }

  // Sort alphabetically
  candidates.sort((a, b) => a.name.localeCompare(b.name));

  return { category, candidates, unresolved };
}

/**
 * Build a mechanical token name for non-color categories.
 */
function buildCategoryMechanicalName(
  finding: import("../parsers/types.js").RawFinding,
  category: import("../parsers/types.js").TokenCategory,
): string {
  if (finding.declName) {
    const kebab = camelToKebab(finding.declName);
    return `${category}.${kebab}`;
  }
  // Fallback: slug from rawValue
  const slug = finding.rawValue
    .replace(/[^a-zA-Z0-9]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase()
    .slice(0, 40);
  return `${category}.${slug || `unknown-${finding.line}`}`;
}

function camelToKebab(name: string): string {
  return name
    .replace(/([A-Z])/g, "-$1")
    .toLowerCase()
    .replace(/^-/, "");
}

/**
 * Build a DTCG CandidateToken for a non-color category finding.
 */
function buildCategoryCandidate(
  finding: import("../parsers/types.js").RawFinding,
  category: import("../parsers/types.js").TokenCategory,
  tokenName: string,
  vendorNamespace: string,
): CandidateToken | null {
  const provenance = [
    { sourcePath: finding.sourcePath, line: finding.line, rawValue: finding.rawValue },
  ];

  // Helper: only include $description when the value is defined (exactOptionalPropertyTypes compat)
  const desc = (label: string): { $description: string } | Record<string, never> =>
    finding.declName ? { $description: `${label}: ${finding.declName}` } : {};

  switch (category) {
    case "typography": {
      // DTCG composite token for typography
      const v = finding.normalizedValue as Record<string, unknown> | null;
      if (!v) return null;
      const extensions: Record<string, unknown> = {};
      if (v.relativeTo) {
        extensions.swiftui = { relativeTo: v.relativeTo };
      }
      return {
        name: tokenName,
        $type: "typography",
        $value: {
          fontFamily: v.fontFamily ?? "system",
          fontSize: v.fontSize ?? 16,
          fontWeight: v.fontWeight ?? 400,
          lineHeight: v.lineHeight ?? 1.5,
          letterSpacing: v.letterSpacing ?? "0px",
        },
        ...desc("Typography token"),
        ...(Object.keys(extensions).length > 0 ? { $extensions: extensions } : {}),
        _provenance: provenance,
        _confidence: "high",
        _llmDerived: false,
      };
    }

    case "spacing": {
      const v = finding.normalizedValue;
      if (typeof v !== "number") return null;
      return {
        name: tokenName,
        $type: "dimension",
        $value: `${v}px`,
        ...desc("Spacing token"),
        _provenance: provenance,
        _confidence: "high",
        _llmDerived: false,
      };
    }

    case "cornerRadius": {
      const v = finding.normalizedValue;
      const extensions: Record<string, unknown> = {};
      if (finding.shapeType) {
        extensions.swiftui = { style: finding.shapeType };
      }
      if (typeof v === "number") {
        return {
          name: tokenName,
          $type: "dimension",
          $value: `${v}px`,
          ...desc("Corner radius"),
          ...(Object.keys(extensions).length > 0 ? { $extensions: extensions } : {}),
          _provenance: provenance,
          _confidence: "high",
          _llmDerived: false,
        };
      }
      // 4-corner object — emit as an extensions object
      return {
        name: tokenName,
        $type: "dimension",
        $value: "0px",
        $extensions: {
          swiftui: {
            cornerRadii: v,
            ...(finding.shapeType ? { style: finding.shapeType } : {}),
          },
        },
        ...desc("Uneven corner radius"),
        _provenance: provenance,
        _confidence: "medium",
        _llmDerived: false,
      };
    }

    case "shadow": {
      // DTCG shadow composite token
      const v = finding.normalizedValue as Record<string, unknown> | null;
      if (!v) return null;
      return {
        name: tokenName,
        $type: "shadow",
        $value: {
          color: v.color ?? "rgba(0,0,0,0.12)",
          offsetX: typeof v.x === "number" ? `${v.x}px` : "0px",
          offsetY: typeof v.y === "number" ? `${v.y}px` : "0px",
          blur: typeof v.radius === "number" ? `${v.radius}px` : "0px",
          spread: "0px",
        },
        ...desc("Shadow token"),
        _provenance: provenance,
        _confidence: "high",
        _llmDerived: false,
      };
    }

    case "animation": {
      const v = finding.normalizedValue as Record<string, unknown> | null;
      const duration = typeof v?.duration === "number" ? v.duration : 0.3;
      const curve = typeof v?.curve === "string" ? v.curve : "easeInOut";
      return {
        name: tokenName,
        $type: "duration",
        $value: `${duration}ms`,
        $extensions: {
          motion: { curve, duration, ...(v?.spring ? { spring: v.spring } : {}) },
        },
        ...desc("Animation token"),
        _provenance: provenance,
        _confidence: "high",
        _llmDerived: false,
      };
    }

    case "component": {
      return {
        name: tokenName,
        $type: "custom",
        $value: finding.declName ?? finding.rawValue.slice(0, 80),
        $extensions: {
          swiftui: {
            modifierChain: finding.modifierChain ?? [],
            protocol: finding.context ?? "ViewModifier",
          },
        },
        ...desc("Component token"),
        _provenance: provenance,
        _confidence: "medium",
        _llmDerived: false,
      };
    }

    case "liquidGlass": {
      const vendor = vendorNamespace.replace(/\./g, "_");
      return {
        name: tokenName,
        $type: "custom",
        $value: finding.declName ?? "glass",
        $extensions: {
          [vendor]: {
            material: {
              variant: finding.context ?? "regular",
              rawValue: finding.rawValue.slice(0, 120),
            },
          },
        },
        ...desc("Liquid Glass material"),
        _provenance: provenance,
        _confidence: "medium",
        _llmDerived: false,
      };
    }

    case "theme": {
      const vendor = vendorNamespace.replace(/\./g, "_");
      return {
        name: tokenName,
        $type: "custom",
        $value: finding.declName ?? "theme",
        $extensions: {
          [vendor]: {
            theme: {
              injectionPattern: finding.context ?? "EnvironmentKey",
              rawValue: finding.rawValue.slice(0, 120),
            },
          },
        },
        ...desc("Theme injection"),
        _provenance: provenance,
        _confidence: "medium",
        _llmDerived: false,
      };
    }

    default:
      return null;
  }
}
