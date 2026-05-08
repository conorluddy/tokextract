// === SHARED TYPES ===
// Contract types shared between parsers, analyzers, and emitters.
// Slice 1: color-focused. Slice 2 will fill in remaining categories.

// === RAW FINDINGS ===

export type TokenCategory =
  | "color"
  | "typography"
  | "spacing"
  | "cornerRadius"
  | "shadow"
  | "animation"
  | "component"
  | "liquidGlass"
  | "theme";

/** Normalized color value — sRGB or Display P3 components in [0,1] range */
export interface NormalizedColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
  readonly colorSpace: "srgb" | "display-p3";
}

/** A single extraction from the AST or regex side-channel pass */
export interface RawFinding {
  readonly category: TokenCategory;
  readonly sourcePath: string;
  readonly line: number;
  readonly col: number;
  readonly declName: string | null;
  readonly rawValue: string;
  readonly normalizedValue: unknown | null; // null = needs LLM
  readonly context: string;
  readonly isDeclaration: boolean;
  readonly isSystemAlias?: boolean;
  readonly assetName?: string;
  readonly assetMissing?: boolean;
  readonly hasDarkVariant?: boolean;
  readonly hasDynamicType?: boolean;
  readonly shapeType?: string;
  readonly modifierChain?: ReadonlyArray<{
    readonly name: string;
    readonly args: readonly string[];
  }>;
  readonly severity?: "info" | "warning" | "error";
  /** requiresSemanticResolution: true for Color(uiColor:) calls */
  readonly requiresSemanticResolution?: boolean;
  /**
   * Component parser confidence tier (component findings only).
   *
   * - "high"   — ButtonStyle / ViewModifier / PrimitiveButtonStyle conformance, or
   *              extension View convenience wrapper. Always emitted.
   * - "medium" — Custom struct View with a name-keyword match (Button, Card, Badge, …)
   *              or init-signal (typed params / @Binding). Emitted in v1 by default.
   * - "low"    — Custom struct View without name match or init signal.
   *              NOT emitted in v1. Available behind --include-likely-components opt-in.
   */
  readonly componentConfidence?: "high" | "medium" | "low";
}

export interface FindingsFile {
  readonly tokextractVersion: string;
  readonly targetRepo: string;
  readonly extractedAt: string;
  readonly findings: readonly RawFinding[];
}

// === CANDIDATE TOKENS ===
// Contract between LLM normalize pass and DTCG emitter

export interface TokenProvenance {
  readonly sourcePath: string;
  readonly line: number;
  readonly rawValue: string;
}

export interface CandidateToken {
  /** Final canonical name, namespaced per DTCG group conventions e.g. "color.semantic.brand" */
  readonly name: string;

  // DTCG fields — emitter copies these into tokens.json directly
  readonly $type: string;
  readonly $value: unknown;
  readonly $description?: string;
  readonly $extensions?: Record<string, unknown>;

  // Provenance — every candidate must cite its source(s)
  readonly _provenance: readonly TokenProvenance[];

  // LLM metadata — never written to tokens.json
  readonly _confidence: "high" | "medium" | "low";
  readonly _llmDerived: boolean;
  readonly _inferred?: string;
}

export interface UnresolvedToken {
  readonly rawValue: string;
  readonly sourcePath: string;
  readonly line: number;
  readonly reason: string;
}

export interface CandidateFile {
  readonly category: TokenCategory;
  readonly candidates: readonly CandidateToken[];
  readonly unresolved: readonly UnresolvedToken[];
}

// === LLM MAPPING (slim output contract, Slice 1.5) ===
// Subagent emits Mapping[] — Node helper merges with findings to build CandidateFile.

export interface Mapping {
  /** Join key: matches RawFinding.declName */
  readonly declName: string;
  /** Disambiguator: matches RawFinding.sourcePath */
  readonly sourcePath: string;
  /** Proposed canonical token name, e.g. "color.semantic.brand-primary" */
  readonly name: string;
  readonly group: "primitive" | "semantic" | "component";
  readonly description?: string;
  /** If semantic, the primitive name this aliases */
  readonly aliasOf?: string;
  readonly confidence: "high" | "medium" | "low";
}

// === LLM TASK MANIFEST ===

export type LlmTaskPass = "normalize" | "harmonize" | "narrate" | "self-critique";
export type LlmTaskStatus = "pending" | "done" | "error";

export interface LlmTask {
  readonly id: string; // e.g. "normalize-color"
  readonly pass: LlmTaskPass;
  readonly recommendedModel: string; // e.g. "claude-haiku-4-5-20251001"
  readonly promptPath: string; // .tokextract/prompts/normalize-color.md
  readonly responsePath: string; // .tokextract/llm-out/normalize-color.json
  readonly responseSchema: string | null; // path to JSON Schema, if any
  status: LlmTaskStatus; // mutable — updated as tasks complete
}

export interface LlmTaskManifest {
  readonly version: string;
  readonly outputDir: string;
  readonly generatedAt: string;
  tasks: LlmTask[]; // mutable — tasks updated in-place
}

// === CLI OPTIONS ===

export interface ExtractOptions {
  readonly path: string;
  readonly output: string;
  readonly noLlm: boolean;
  readonly maxFiles: number;
  readonly deltaEThreshold: number;
  readonly modelNormalize: string;
  readonly modelHarmonize: string;
  readonly modelNarrate: string;
  readonly skip: readonly string[];
  readonly verbose: boolean;
}
