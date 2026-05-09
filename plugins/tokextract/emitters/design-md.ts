/**
 * emitters/design-md.ts
 *
 * Emits DESIGN.md in the Google @google/design.md alpha format.
 *
 * Slice 3 stub mode (--no-llm): all 8 mandatory sections are emitted with
 * deterministic content derived from the extracted token candidates.
 * The narrate LLM pass (Slice 3) writes the full LLM-generated DESIGN.md directly.
 *
 * The design-md-lint.ts module validates that all 8 sections exist in the right order
 * and the stub passes all lint rules.
 *
 * Format isolation: this file owns all schema knowledge for the alpha format.
 * If the format changes, only this file and design-md-lint.ts need updating.
 */

import fs from "node:fs";
import path from "node:path";
import type { CandidateFile, CandidateToken } from "../parsers/types.js";

// === PUBLIC API ===

export interface DesignMdOptions {
  readonly outputDir: string;
  readonly appName: string;
  readonly extractedAt: string;
  readonly isStub: boolean; // true in --no-llm mode
}

export interface DesignMdData {
  readonly colorTokens: readonly CandidateToken[];
  readonly typographyTokens: readonly CandidateToken[];
  readonly spacingTokens: readonly CandidateToken[];
  readonly allCandidateFiles: readonly CandidateFile[];
  readonly llmNarratedColorSection?: string; // Optional LLM-generated Colors prose (Slice 3+)
}

/**
 * Emit DESIGN.md. In stub mode (--no-llm), all sections use deterministic placeholder prose.
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
  const frontMatter = buildFrontMatter(data, options);
  const sections = [
    buildOverviewSection(data, options),
    buildColorsSection(data, options),
    buildTypographySection(data, options),
    buildLayoutSection(data, options),
    buildElevationSection(data, options),
    buildShapesSection(data, options),
    buildComponentsSection(data, options),
    buildDosAndDontsSection(data, options),
  ];

  return [frontMatter, ...sections].join("\n\n");
}

function buildFrontMatter(data: DesignMdData, options: DesignMdOptions): string {
  const colorEntries = data.colorTokens
    .slice(0, 10)
    .map((t) => `    ${tokenLastSegment(t.name)}: "${t.name}"`)
    .join("\n");

  const typographyEntries = data.typographyTokens
    .slice(0, 5)
    .map((t) => `    ${tokenLastSegment(t.name)}: "${t.name}"`)
    .join("\n");

  const spacingEntries = data.spacingTokens
    .slice(0, 5)
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
  typography:
${typographyEntries || "    # No typography tokens extracted"}
  spacing:
${spacingEntries || "    # No spacing tokens extracted"}
---`;
}

function buildOverviewSection(data: DesignMdData, options: DesignMdOptions): string {
  const categoryCount = data.allCandidateFiles.length;
  const totalTokens = data.allCandidateFiles.reduce((sum, cf) => sum + cf.candidates.length, 0);

  return `## Overview

${options.isStub ? "_[Stub — LLM narration pass not run. Re-run without `--no-llm` for brand-intent prose.]_\n\n" : ""}${options.appName} design system extracted by Tokextract. ${totalTokens} tokens across ${categoryCount} categor${categoryCount === 1 ? "y" : "ies"}. See \`tokens.json\` for the complete token inventory and \`audit.md\` for actionable harmonization recommendations.`;
}

function buildColorsSection(data: DesignMdData, options: DesignMdOptions): string {
  if (data.llmNarratedColorSection) {
    return `## Colors\n\n${data.llmNarratedColorSection}`;
  }

  if (data.colorTokens.length === 0) {
    return "## Colors\n\n_No color tokens were extracted from the target repository._";
  }

  const tokenList = data.colorTokens
    .slice(0, 20)
    .map((t) => {
      const valueStr = formatColorValue(t.$value);
      const darkValue = extractDarkValue(t);
      const adaptive = darkValue ? ` / ${formatColorValue(darkValue)} dark` : "";
      const desc = t.$description ? ` — ${t.$description}` : "";
      return `- \`${t.name}\`: ${valueStr}${adaptive}${desc}`;
    })
    .join("\n");

  const primaryToken = data.colorTokens.find((t) => /brand|primary|accent/i.test(t.name));
  const primaryNote = primaryToken ? `\n\nPrimary brand color: \`{{${primaryToken.name}}}\`.` : "";

  return `## Colors

The palette contains ${data.colorTokens.length} extracted color token${data.colorTokens.length === 1 ? "" : "s"}.${primaryNote}

${options.isStub ? "_[Full color narrative available after LLM narration pass.]_\n\n" : ""}${tokenList}${data.colorTokens.length > 20 ? `\n\n_...and ${data.colorTokens.length - 20} more color tokens in tokens.json._` : ""}`;
}

function buildTypographySection(data: DesignMdData, options: DesignMdOptions): string {
  const typographyFile = data.allCandidateFiles.find((cf) => cf.category === "typography");
  const count = typographyFile?.candidates.length ?? 0;

  if (count === 0) {
    return `## Typography

_[Stub — no typography tokens extracted. Run against a repo with Font.custom() declarations.]_

At least one typography token is required. See \`tokens.json\` for the complete font inventory.`;
  }

  const sampleNames = typographyFile?.candidates
    .slice(0, 5)
    .map((t) => `- \`${t.name}\``)
    .join("\n");

  return `## Typography

${count} typography token${count === 1 ? "" : "s"} extracted.${options.isStub ? " _[Full narrative after LLM narration pass.]_" : ""}

**Sample tokens:**
${sampleNames}${count > 5 ? `\n\n_...and ${count - 5} more in tokens.json._` : ""}

Tokens capture font family, size, weight, line height, and letter spacing. Tokens with \`$extensions.swiftui.relativeTo\` support Dynamic Type scaling.`;
}

function buildLayoutSection(data: DesignMdData, options: DesignMdOptions): string {
  const spacingFile = data.allCandidateFiles.find((cf) => cf.category === "spacing");
  const count = spacingFile?.candidates.length ?? 0;

  if (count === 0) {
    return `## Layout

_[Stub — no spacing tokens extracted.]_

Spacing tokens follow a 4/8 scale (xs=4, sm=8, md=16, lg=24, xl=32, 2xl=48). See \`tokens.json\` for extracted spacing values and \`audit.md\` for off-scale literals.`;
  }

  const sampleNames = spacingFile?.candidates
    .slice(0, 5)
    .map((t) => {
      const valueStr = typeof t.$value === "string" ? ` = ${t.$value}` : "";
      return `- \`${t.name}\`${valueStr}`;
    })
    .join("\n");

  return `## Layout

${count} spacing token${count === 1 ? "" : "s"} extracted. Spacing follows a 4/8 base scale.${options.isStub ? " _[Full narrative after LLM narration pass.]_" : ""}

**Sample spacing tokens:**
${sampleNames}${count > 5 ? `\n\n_...and ${count - 5} more in tokens.json._` : ""}`;
}

function buildElevationSection(data: DesignMdData, options: DesignMdOptions): string {
  const shadowFile = data.allCandidateFiles.find((cf) => cf.category === "shadow");
  const count = shadowFile?.candidates.length ?? 0;

  if (count === 0) {
    return `## Elevation & Depth

_[Stub — no shadow tokens extracted.]_

Elevation tokens capture shadow parameters (color, radius, offset). See \`tokens.json\`.`;
  }

  const sampleNames = shadowFile?.candidates
    .slice(0, 5)
    .map((t) => `- \`${t.name}\``)
    .join("\n");

  return `## Elevation & Depth

${count} shadow token${count === 1 ? "" : "s"} extracted.${options.isStub ? " _[Full narrative after LLM narration pass.]_" : ""}

**Sample shadow tokens:**
${sampleNames}${count > 5 ? `\n\n_...and ${count - 5} more in tokens.json._` : ""}

Shadow tokens use DTCG composite shadow format: \`{color, offsetX, offsetY, blur, spread}\`.`;
}

function buildShapesSection(data: DesignMdData, options: DesignMdOptions): string {
  const shapeFile = data.allCandidateFiles.find((cf) => cf.category === "cornerRadius");
  const count = shapeFile?.candidates.length ?? 0;

  if (count === 0) {
    return `## Shapes

_[Stub — no corner radius tokens extracted.]_

Shape tokens capture corner radius values and style (continuous/circular). See \`tokens.json\`.`;
  }

  const sampleNames = shapeFile?.candidates
    .slice(0, 5)
    .map((t) => {
      const valueStr = typeof t.$value === "string" ? ` = ${t.$value}` : "";
      return `- \`${t.name}\`${valueStr}`;
    })
    .join("\n");

  return `## Shapes

${count} corner radius token${count === 1 ? "" : "s"} extracted.${options.isStub ? " _[Full narrative after LLM narration pass.]_" : ""}

**Sample shape tokens:**
${sampleNames}${count > 5 ? `\n\n_...and ${count - 5} more in tokens.json._` : ""}

Tokens with \`$extensions.swiftui.style\` encode the continuous/circular distinction.`;
}

function buildComponentsSection(data: DesignMdData, options: DesignMdOptions): string {
  const componentFile = data.allCandidateFiles.find((cf) => cf.category === "component");
  const glassFile = data.allCandidateFiles.find((cf) => cf.category === "liquidGlass");
  const componentCount = componentFile?.candidates.length ?? 0;
  const glassCount = glassFile?.candidates.length ?? 0;

  if (componentCount === 0 && glassCount === 0) {
    return `## Components

_[Stub — no component tokens extracted.]_

Component tokens capture ButtonStyle, ViewModifier, and custom View modifier chains. See \`tokens.json\`.`;
  }

  const sampleNames = (componentFile?.candidates ?? [])
    .slice(0, 5)
    .map((t) => `- \`${t.name}\``)
    .join("\n");

  const glassNote =
    glassCount > 0
      ? `\n\n${glassCount} Liquid Glass token${glassCount === 1 ? "" : "s"} detected. See Do's and Don'ts for usage guidance.`
      : "";

  return `## Components

${componentCount} component token${componentCount === 1 ? "" : "s"} extracted.${options.isStub ? " _[Full narrative after LLM narration pass.]_" : ""}

**Sample component tokens:**
${sampleNames || "_No named component tokens._"}${componentCount > 5 ? `\n\n_...and ${componentCount - 5} more in tokens.json._` : ""}${glassNote}`;
}

function buildDosAndDontsSection(data: DesignMdData, options: DesignMdOptions): string {
  const hasGlass = data.allCandidateFiles.some(
    (cf) => cf.category === "liquidGlass" && cf.candidates.length > 0,
  );
  const hasPrimaryColor = data.colorTokens.some((t) => /brand|primary|accent/i.test(t.name));

  const rules: string[] = [
    "**Do** use defined color tokens instead of inline hex literals.",
    "**Don't** introduce new hex values without a corresponding token declaration.",
  ];

  if (hasPrimaryColor) {
    rules.push("**Do** use the primary brand color token for CTAs and interactive elements.");
  }

  if (hasGlass) {
    rules.push(
      "**Don't** apply `.glassEffect()` to cards, list rows, or media containers — Apple's design guidance reserves glass for the navigation layer (TabBar, NavigationBar, toolbars).",
      "**Do** use `.glassEffect()` on NavigationBar backgrounds, tab bars, and floating toolbars.",
    );
  }

  if (options.isStub) {
    rules.push(
      "_[Additional rules from LLM narration pass will appear here after re-run without `--no-llm`.]_",
    );
  }

  const rulesText = rules.map((r) => `- ${r}`).join("\n");

  return `## Do's and Don'ts

${rulesText}`;
}

// === UTILITIES ===

function tokenLastSegment(name: string): string {
  const parts = name.split(".");
  return parts[parts.length - 1] ?? name;
}

function extractDarkValue(token: { $modes?: unknown }): unknown | null {
  const modes = token.$modes;
  if (typeof modes !== "object" || modes === null) return null;
  const dark = (modes as Record<string, { $value?: unknown }>).dark;
  return dark?.$value ?? null;
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
