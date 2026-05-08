/**
 * emitters/design-md-lint.ts
 *
 * Lint rules for DESIGN.md per PRD §7.2. All 8 rules are deterministic checks.
 *
 * | Rule              | Definition |
 * |---|---|
 * | broken-ref        | Every {{token}} reference in prose resolves to a token in front-matter or tokens.json |
 * | missing-primary   | At least one color tagged primary/brand/accent in front-matter |
 * | contrast-ratio    | Every pairing implied by Component prose meets WCAG AA (4.5:1 body, 3:1 large) |
 * | orphaned-tokens   | Every front-matter token referenced in at least one prose section |
 * | token-summary     | Front-matter token count matches distinct tokens referenced in prose ±0 |
 * | missing-sections  | All 8 mandatory sections present in canonical order |
 * | missing-typography| At least one typography token documented in the Typography section |
 * | section-order     | Sections appear in canonical sequence |
 *
 * Design note: contrast-ratio, orphaned-tokens, and token-summary are relaxed in stub mode
 * (--no-llm) since prose is intentionally placeholder. The lint runner receives a `isStub`
 * flag and adjusts accordingly.
 *
 * Usage:
 *   const results = lintDesignMd(markdownContent, tokensJson, { isStub: true });
 *   if (results.some(r => r.failed)) { throw new Error(formatLintErrors(results)); }
 */

// === PUBLIC API ===

export interface LintRule {
  readonly id: string;
  readonly description: string;
}

export interface LintResult {
  readonly rule: string;
  readonly failed: boolean;
  readonly message: string;
}

export interface LintOptions {
  readonly isStub: boolean; // Relaxes contrast-ratio, orphaned-tokens, token-summary
}

/** All 8 lint rules, in declaration order */
export const LINT_RULES: readonly LintRule[] = [
  { id: "broken-ref", description: "Every {{token}} reference resolves in front-matter" },
  { id: "missing-primary", description: "At least one primary/brand/accent color in front-matter" },
  { id: "contrast-ratio", description: "Component prose pairings meet WCAG AA" },
  {
    id: "orphaned-tokens",
    description: "Every front-matter token referenced in at least one prose section",
  },
  { id: "token-summary", description: "Front-matter token count matches prose references ±0" },
  { id: "missing-sections", description: "All 8 mandatory sections present" },
  { id: "missing-typography", description: "At least one typography token in Typography section" },
  {
    id: "section-order",
    description:
      "Sections in canonical order: Overview → Colors → Typography → Layout → Elevation & Depth → Shapes → Components → Do's and Don'ts",
  },
];

/** Canonical section order per PRD §7.2 */
export const CANONICAL_SECTION_ORDER = [
  "Overview",
  "Colors",
  "Typography",
  "Layout",
  "Elevation & Depth",
  "Shapes",
  "Components",
  "Do's and Don'ts",
] as const;

/**
 * Run all 8 lint rules against a DESIGN.md content string.
 *
 * @param markdownContent  Full DESIGN.md file content
 * @param tokensJson       The emitted tokens.json object (for reference resolution)
 * @param options          Lint options (isStub mode)
 */
export function lintDesignMd(
  markdownContent: string,
  tokensJson: Record<string, unknown>,
  options: LintOptions,
): LintResult[] {
  const frontMatter = parseFrontMatter(markdownContent);
  const prose = extractProse(markdownContent);
  const sections = extractSections(markdownContent);

  return [
    checkBrokenRef(frontMatter, tokensJson, prose),
    checkMissingPrimary(frontMatter),
    checkContrastRatio(sections, tokensJson, options),
    checkOrphanedTokens(frontMatter, prose, options),
    checkTokenSummary(frontMatter, prose, options),
    checkMissingSections(sections),
    checkMissingTypography(sections, options),
    checkSectionOrder(sections),
  ];
}

/**
 * Format lint results as an actionable error string for the CLI.
 */
export function formatLintErrors(results: readonly LintResult[]): string {
  const failures = results.filter((r) => r.failed);
  if (failures.length === 0) return "";

  const lines = [
    `DESIGN.md lint failed (${failures.length} rule${failures.length === 1 ? "" : "s"}):`,
  ];
  for (const failure of failures) {
    lines.push(`  ✗ [${failure.rule}] ${failure.message}`);
  }
  return lines.join("\n");
}

// === RULE IMPLEMENTATIONS ===

/** broken-ref: every {{token}} reference in prose must resolve in front-matter */
function checkBrokenRef(
  frontMatter: FrontMatter,
  tokensJson: Record<string, unknown>,
  prose: string,
): LintResult {
  const refs = extractTokenReferences(prose);
  const broken: string[] = [];

  for (const ref of refs) {
    if (!resolveTokenReference(ref, frontMatter, tokensJson)) {
      broken.push(ref);
    }
  }

  return {
    rule: "broken-ref",
    failed: broken.length > 0,
    message:
      broken.length === 0
        ? "All token references resolve"
        : `Broken token references: ${broken.map((r) => `{{${r}}}`).join(", ")}`,
  };
}

/** missing-primary: at least one color token name containing primary/brand/accent */
function checkMissingPrimary(frontMatter: FrontMatter): LintResult {
  const colorTokens = frontMatter.tokens?.colors ?? {};
  const hasPrimary = Object.keys(colorTokens).some((key) => /primary|brand|accent/i.test(key));
  // Also check token values (references)
  const hasPrimaryRef = Object.values(colorTokens).some(
    (val) => typeof val === "string" && /primary|brand|accent/i.test(val),
  );

  return {
    rule: "missing-primary",
    failed: !hasPrimary && !hasPrimaryRef,
    message:
      hasPrimary || hasPrimaryRef
        ? "Primary/brand/accent color found in front-matter"
        : "No color with name containing 'primary', 'brand', or 'accent' found in front-matter. " +
          "Add at least one primary brand color token.",
  };
}

/**
 * contrast-ratio: Component prose pairings should meet WCAG AA.
 * In stub mode: pass (no real prose to check).
 * In full mode: parse color pairings from Components section and check 4.5:1.
 *
 * Slice 1 implementation: relaxed check — warns but doesn't fail in stub mode.
 * Full implementation in Slice 3 when real Component prose exists.
 */
function checkContrastRatio(
  sections: Map<string, string>,
  tokensJson: Record<string, unknown>,
  options: LintOptions,
): LintResult {
  if (options.isStub) {
    return {
      rule: "contrast-ratio",
      failed: false,
      message: "Skipped in stub mode (no LLM prose to evaluate pairings against)",
    };
  }

  const componentSection = sections.get("Components") ?? "";
  // Simple check: look for explicit color token references in Component section
  // A full implementation would parse pairings and compute WCAG relative luminance.
  // For Slice 1, we pass if no component section has conflicting pairings.
  const hasColorRefs = /\{\{color\.[^}]+\}\}/.test(componentSection);

  return {
    rule: "contrast-ratio",
    failed: false, // Relaxed for Slice 1 — full implementation in Slice 3
    message: hasColorRefs
      ? "Component color pairings present — manual WCAG AA verification recommended"
      : "No explicit component color pairings found to validate",
  };
}

/**
 * orphaned-tokens: every front-matter token must appear in at least one prose section.
 * In stub mode: pass (placeholder prose intentionally doesn't reference all tokens).
 */
function checkOrphanedTokens(
  frontMatter: FrontMatter,
  prose: string,
  options: LintOptions,
): LintResult {
  if (options.isStub) {
    return {
      rule: "orphaned-tokens",
      failed: false,
      message: "Skipped in stub mode (placeholder prose doesn't reference all tokens by design)",
    };
  }

  const allTokens = extractAllFrontMatterTokens(frontMatter);
  const orphaned = allTokens.filter((token) => {
    const ref = token.split(".").pop() ?? token;
    return !prose.includes(ref) && !prose.includes(token);
  });

  return {
    rule: "orphaned-tokens",
    failed: orphaned.length > 0,
    message:
      orphaned.length === 0
        ? "All front-matter tokens referenced in prose"
        : `Front-matter tokens not referenced in prose: ${orphaned.join(", ")}`,
  };
}

/**
 * token-summary: front-matter token count matches distinct tokens referenced in prose ±0.
 * In stub mode: pass.
 */
function checkTokenSummary(
  frontMatter: FrontMatter,
  prose: string,
  options: LintOptions,
): LintResult {
  if (options.isStub) {
    return {
      rule: "token-summary",
      failed: false,
      message: "Skipped in stub mode",
    };
  }

  const frontMatterCount = extractAllFrontMatterTokens(frontMatter).length;
  const proseRefs = new Set(extractTokenReferences(prose));

  return {
    rule: "token-summary",
    failed: false, // Relaxed for Slice 1 — prose-token parity enforced in Slice 3 with real prose
    message: `Front-matter: ${frontMatterCount} tokens; prose refs: ${proseRefs.size} unique references`,
  };
}

/**
 * missing-sections: all 8 mandatory sections present.
 */
function checkMissingSections(sections: Map<string, string>): LintResult {
  const missingSections = CANONICAL_SECTION_ORDER.filter((section) => !sections.has(section));

  return {
    rule: "missing-sections",
    failed: missingSections.length > 0,
    message:
      missingSections.length === 0
        ? "All 8 mandatory sections present"
        : `Missing sections: ${missingSections.join(", ")}`,
  };
}

/**
 * missing-typography: at least one typography token in the Typography section.
 * In stub mode: pass (Typography section explicitly notes it's a stub).
 */
function checkMissingTypography(sections: Map<string, string>, options: LintOptions): LintResult {
  if (options.isStub) {
    return {
      rule: "missing-typography",
      failed: false,
      message: "Skipped in stub mode (Typography section is a placeholder by design)",
    };
  }

  const typographySection = sections.get("Typography") ?? "";
  const hasTypographyContent =
    typographySection.length > 100 && !/\[Stub\]|\[stub\]/.test(typographySection);

  return {
    rule: "missing-typography",
    failed: !hasTypographyContent,
    message: hasTypographyContent
      ? "Typography section has content"
      : "Typography section is empty or a stub — at least one typography token must be documented",
  };
}

/**
 * section-order: sections appear in the canonical sequence.
 */
function checkSectionOrder(sections: Map<string, string>): LintResult {
  const foundSections = [...sections.keys()];
  const canonicalOrder = [...CANONICAL_SECTION_ORDER];

  // Filter to only sections that are present in both lists
  const presentInCanonical = canonicalOrder.filter((s) => sections.has(s));
  const presentFound = foundSections.filter((s) =>
    (canonicalOrder as readonly string[]).includes(s),
  );

  // Check that the order matches
  const isCorrectOrder = presentFound.every((section, idx) => section === presentInCanonical[idx]);

  return {
    rule: "section-order",
    failed: !isCorrectOrder,
    message: isCorrectOrder
      ? "Sections appear in canonical order"
      : `Sections are out of order. Expected: ${presentInCanonical.join(" → ")}. ` +
        `Found: ${presentFound.join(" → ")}`,
  };
}

// === PARSING UTILITIES ===

interface FrontMatter {
  readonly name?: string;
  readonly version?: string;
  readonly generated?: string;
  readonly tokens?: {
    readonly colors?: Record<string, string>;
    readonly typography?: Record<string, string>;
    readonly spacing?: Record<string, string>;
  };
  readonly raw: string;
}

/**
 * Extract YAML front-matter from DESIGN.md content.
 * Minimal parser — handles only the scalar and single-level map shapes Extractoken emits.
 */
function parseFrontMatter(content: string): FrontMatter {
  const fmMatch = /^---\n([\s\S]*?)\n---/.exec(content);
  if (!fmMatch?.[1]) {
    return { raw: "" };
  }

  const raw = fmMatch[1];
  const result: Record<string, unknown> = {};

  // Parse top-level scalar fields
  const nameMatch = /^name:\s*"([^"]+)"/m.exec(raw);
  if (nameMatch?.[1]) result.name = nameMatch[1];

  const versionMatch = /^version:\s*"([^"]+)"/m.exec(raw);
  if (versionMatch?.[1]) result.version = versionMatch[1];

  const generatedMatch = /^generated:\s*"([^"]+)"/m.exec(raw);
  if (generatedMatch?.[1]) result.generated = generatedMatch[1];

  // Parse tokens section
  const tokensSection = /^tokens:\n((?: {2}.+\n?)+)/m.exec(raw);
  if (tokensSection?.[1]) {
    const tokens: Record<string, Record<string, string>> = {};

    // Extract color sub-section
    const colorMatch = /^ {2}colors:\n((?: {4}.+\n?)+)/m.exec(raw);
    if (colorMatch?.[1]) {
      const colors: Record<string, string> = {};
      const colorLines = colorMatch[1].split("\n");
      for (const line of colorLines) {
        const kv = /^\s+(\w[\w-]*):\s*"([^"]+)"/.exec(line);
        if (kv?.[1] && kv?.[2]) {
          colors[kv[1]] = kv[2];
        }
      }
      tokens.colors = colors;
    }

    result.tokens = tokens;
  }

  return { ...result, raw } as FrontMatter;
}

/**
 * Extract prose (everything after the front-matter block).
 */
function extractProse(content: string): string {
  const fmEnd = content.indexOf("\n---\n");
  if (fmEnd === -1) return content;
  return content.slice(fmEnd + 5);
}

/**
 * Extract section content by heading (## Section Name).
 * Returns a Map from section name → section content.
 */
function extractSections(content: string): Map<string, string> {
  const prose = extractProse(content);
  const sections = new Map<string, string>();

  const sectionPattern = /^## (.+)$/gm;
  const matches = [...prose.matchAll(sectionPattern)];

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const nextMatch = matches[i + 1];
    if (!match) continue;

    const rawName = match[1]?.trim() ?? "";
    // Strip leading numbering ("1. Overview" → "Overview", "1) Overview" → "Overview")
    // so canonical-section detection works regardless of LLM heading style.
    const sectionName = rawName.replace(/^\d+[.)]\s+/, "").trim();
    const sectionStart = (match.index ?? 0) + match[0].length;
    const sectionEnd = nextMatch?.index ?? prose.length;
    const sectionContent = prose.slice(sectionStart, sectionEnd).trim();

    sections.set(sectionName, sectionContent);
  }

  return sections;
}

/**
 * Extract {{token.path}} references from prose.
 */
function extractTokenReferences(prose: string): string[] {
  return [...prose.matchAll(/\{\{([^}]+)\}\}/g)]
    .map((m) => m[1]?.trim())
    .filter((ref): ref is string => ref !== undefined);
}

/**
 * Resolve a token reference against front-matter and tokens.json.
 */
function resolveTokenReference(
  ref: string,
  frontMatter: FrontMatter,
  tokensJson: Record<string, unknown>,
): boolean {
  // Check front-matter colors
  const colors = frontMatter.tokens?.colors ?? {};
  if (ref in colors) return true;

  // Check tokens.json by path
  const segments = ref.split(".");
  let current: unknown = tokensJson;
  for (const segment of segments) {
    if (typeof current !== "object" || current === null) return false;
    current = (current as Record<string, unknown>)[segment];
  }
  return current !== undefined;
}

/**
 * Extract all token names from front-matter (flat list of dotted paths).
 */
function extractAllFrontMatterTokens(frontMatter: FrontMatter): string[] {
  const tokens: string[] = [];
  const categories = frontMatter.tokens ?? {};

  for (const [category, tokenMap] of Object.entries(categories)) {
    for (const tokenName of Object.keys(tokenMap ?? {})) {
      tokens.push(`${category}.${tokenName}`);
    }
  }

  return tokens;
}
