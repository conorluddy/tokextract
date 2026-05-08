/**
 * emitters/design-md.ts
 *
 * Emits DESIGN.md in the Google @google/design.md alpha format.
 *
 * Slice 1 stub mode: all 8 mandatory sections are emitted. Only the Colors section
 * gets real content (derived deterministically from token candidates). The other 7
 * sections emit placeholder prose. This is intentional — the narrate LLM pass
 * (Slice 3) will fill them in with real prose.
 *
 * The design-md-lint.ts module validates that all 8 sections exist in the right order
 * and the stub passes all lint rules.
 *
 * Format isolation: this file owns all schema knowledge for the alpha format.
 * If the format changes, only this file and design-md-lint.ts need updating.
 */

import fs from "node:fs";
import path from "node:path";
import type { CandidateToken } from "../parsers/types.js";

// === PUBLIC API ===

export interface DesignMdOptions {
  readonly outputDir: string;
  readonly appName: string;
  readonly extractedAt: string;
  readonly isStub: boolean; // true in --no-llm mode
}

export interface DesignMdData {
  readonly colorTokens: readonly CandidateToken[];
  readonly llmNarratedColorSection?: string; // Optional LLM-generated Colors prose (Slice 3+)
}

/**
 * Emit DESIGN.md. In stub mode (--no-llm), all sections except Colors use placeholder prose.
 * Returns the path written.
 */
export function emitDesignMd(data: DesignMdData, options: DesignMdOptions): string {
  const content = buildDesignMdContent(data, options);
  const designMdPath = path.join(options.outputDir, "DESIGN.md");
  fs.mkdirSync(options.outputDir, { recursive: true });
  fs.writeFileSync(designMdPath, `${content}\n`, "utf-8");
  return designMdPath;
}

// === CONTENT BUILDERS ===

function buildDesignMdContent(data: DesignMdData, options: DesignMdOptions): string {
  const frontMatter = buildFrontMatter(data.colorTokens, options);
  const sections = [
    buildOverviewSection(options),
    buildColorsSection(data, options),
    buildTypographySection(options),
    buildLayoutSection(options),
    buildElevationSection(options),
    buildShapesSection(options),
    buildComponentsSection(options),
    buildDosAndDontsSection(options),
  ];

  return [frontMatter, ...sections].join("\n\n");
}

function buildFrontMatter(
  colorTokens: readonly CandidateToken[],
  options: DesignMdOptions,
): string {
  const colorEntries = colorTokens
    .slice(0, 10) // Limit to 10 tokens in front-matter
    .map((t) => `    ${tokenLastSegment(t.name)}: "${t.name}"`)
    .join("\n");

  return `---
name: "${options.appName} Design System"
version: "1.0.0"
extracted: "${options.extractedAt.slice(0, 10)}"
source: "SwiftUI — tree-sitter pass${options.isStub ? "" : " + LLM normalization"}"
generated: "${options.isStub ? "deterministic" : "llm-narrated"}"
tokens:
  colors:
${colorEntries || "    # No color tokens extracted"}
---`;
}

function buildOverviewSection(options: DesignMdOptions): string {
  if (options.isStub) {
    return `## Overview

_[Stub — LLM narration pass not run. Re-run without \`--no-llm\` for brand-intent prose.]_

${options.appName} design system extracted by Extractoken. See \`tokens.json\` for the complete token inventory and \`audit.md\` for actionable harmonization recommendations.`;
  }
  return "## Overview\n\n_[LLM narration content goes here]_";
}

function buildColorsSection(data: DesignMdData, options: DesignMdOptions): string {
  if (data.llmNarratedColorSection) {
    return `## Colors\n\n${data.llmNarratedColorSection}`;
  }

  if (data.colorTokens.length === 0) {
    return "## Colors\n\n_No color tokens were extracted from the target repository._";
  }

  // Build deterministic color documentation
  const tokenList = data.colorTokens
    .map((t) => {
      const valueStr = formatColorValue(t.$value);
      const desc = t.$description ? ` — ${t.$description}` : "";
      return `- \`${t.name}\`: ${valueStr}${desc}`;
    })
    .join("\n");

  const primaryToken = data.colorTokens.find((t) => /brand|primary|accent/i.test(t.name));

  const primaryNote = primaryToken ? `\n\nPrimary brand color: \`{{${primaryToken.name}}}\`.` : "";

  return `## Colors

The palette contains ${data.colorTokens.length} extracted color token${data.colorTokens.length === 1 ? "" : "s"}.${primaryNote}

${options.isStub ? "_[Full color narrative available after LLM narration pass.]_\n\n" : ""}${tokenList}`;
}

function buildTypographySection(options: DesignMdOptions): string {
  return `## Typography

_[Stub — typography extraction is Slice 2 scope. Re-run after parsers/typography.ts is implemented.]_

At least one typography token is required. See \`tokens.json\` for the complete font inventory once Slice 2 is complete.`;
}

function buildLayoutSection(options: DesignMdOptions): string {
  return `## Layout

_[Stub — spacing extraction is Slice 2 scope.]_

Spacing tokens will follow a 4/8 scale. See \`tokens.json\` for extracted spacing values.`;
}

function buildElevationSection(options: DesignMdOptions): string {
  return `## Elevation & Depth

_[Stub — shadow extraction is Slice 2 scope.]_

Elevation tokens capture shadow parameters (color, radius, offset). See \`tokens.json\`.`;
}

function buildShapesSection(options: DesignMdOptions): string {
  return `## Shapes

_[Stub — corner radius extraction is Slice 2 scope.]_

Shape tokens capture corner radius values and style (continuous/circular). See \`tokens.json\`.`;
}

function buildComponentsSection(options: DesignMdOptions): string {
  return `## Components

_[Stub — component extraction is Slice 2 scope.]_

Component tokens capture ButtonStyle, ViewModifier, and custom View modifier chains. See \`tokens.json\`.`;
}

function buildDosAndDontsSection(options: DesignMdOptions): string {
  const brandNote = options.isStub
    ? "**Do** use defined color tokens instead of inline hex literals.\n**Don't** introduce new hex values without a corresponding token declaration."
    : "_[LLM-generated Do's and Don'ts]_";

  return `## Do's and Don'ts

${brandNote}`;
}

// === UTILITIES ===

function tokenLastSegment(name: string): string {
  const parts = name.split(".");
  return parts[parts.length - 1] ?? name;
}

function formatColorValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    const colorValue = value as { colorSpace?: string; components?: number[] };
    if (colorValue.colorSpace && colorValue.components) {
      const [r, g, b, a] = colorValue.components;
      const rHex = Math.round((r ?? 0) * 255)
        .toString(16)
        .padStart(2, "0");
      const gHex = Math.round((g ?? 0) * 255)
        .toString(16)
        .padStart(2, "0");
      const bHex = Math.round((b ?? 0) * 255)
        .toString(16)
        .padStart(2, "0");
      const hex = `#${rHex}${gHex}${bHex}`.toUpperCase();
      const alphaNote = a !== undefined && a < 1 ? ` (${Math.round(a * 100)}% opacity)` : "";
      return `${hex}${alphaNote} (${colorValue.colorSpace})`;
    }
  }
  return JSON.stringify(value);
}
