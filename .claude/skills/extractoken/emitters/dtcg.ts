/**
 * emitters/dtcg.ts
 *
 * DTCG 2025.10 emitter. Reads CandidateFile(s) from .extractoken/llm-out/ (or
 * from deterministic mechanical candidates in --no-llm mode), strips metadata
 * fields (_provenance, _confidence, _llmDerived, _inferred, unresolved), and
 * writes a validated tokens.json.
 *
 * Schema validation via Ajv runs before writing — a validation failure is a
 * hard error (fail-fast per PRD §7.1).
 *
 * Slice 1: color only. Slice 3 extends this to all categories.
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

// === PUBLIC API ===

export interface EmitDtcgOptions {
  readonly outputDir: string;
  readonly schemaPath: string;
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
      `DTCG schema not found at ${schemaPath}. Ensure schemas/dtcg-2025.10.json exists in the extractoken skill directory. Original error: ${error instanceof Error ? error.message : String(error)}`,
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

    candidates.push({
      name: tokenName,
      $type: "color",
      $value: {
        colorSpace: normalizedColor.colorSpace,
        components: [normalizedColor.r, normalizedColor.g, normalizedColor.b, normalizedColor.a],
      },
      $description: `Extracted from ${finding.sourcePath}:${finding.line}`,
      _provenance: [
        {
          sourcePath: finding.sourcePath,
          line: finding.line,
          rawValue: finding.rawValue,
        },
      ],
      _confidence: "high",
      _llmDerived: false,
    });
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
