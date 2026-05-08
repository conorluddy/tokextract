/**
 * llm/narrate.ts
 *
 * Generates the narrate prompt file and appends an LlmTask to the manifest.
 *
 * The narrate pass is the highest-leverage LLM use in the pipeline. The subagent
 * reads the final tokens.json and audit.md, then writes a complete DESIGN.md
 * (Google @google/design.md alpha format) directly to <outputDir>/DESIGN.md.
 *
 * Contract (Slice 1.5):
 * - Never inline tokens.json (potentially large). Give the subagent the path.
 * - Subagent writes DESIGN.md directly to <outputDir>/DESIGN.md via the Write tool.
 * - responsePath is <outputDir>/DESIGN.md (not under .tokextract/llm-out/).
 * - responseSchema is null (output is markdown, not JSON).
 * - Subagent replies "done" after writing.
 */

import fs from "node:fs";
import path from "node:path";
import type { LlmTask } from "../parsers/types.js";

// === PUBLIC API ===

export interface NarrateOptions {
  readonly outputDir: string;
  readonly model: string;
  readonly llmTasks: LlmTask[]; // mutable — narrate task is appended
}

/**
 * Write the narrate prompt file and append an LlmTask to llmTasks.
 * Returns the path to the written prompt file.
 */
export function writeNarrateManifest(options: NarrateOptions): string {
  const promptsDir = path.join(options.outputDir, ".tokextract", "prompts");
  fs.mkdirSync(promptsDir, { recursive: true });

  const promptPath = path.join(promptsDir, "narrate.md");
  const responsePath = path.join(options.outputDir, "DESIGN.md");
  const tokensPath = path.join(options.outputDir, "tokens.json");
  const auditPath = path.join(options.outputDir, "audit.md");

  const promptContent = buildNarratePrompt({ tokensPath, auditPath, responsePath });
  fs.writeFileSync(promptPath, promptContent, "utf-8");

  const status = isTaskDone(responsePath) ? "done" : "pending";

  options.llmTasks.push({
    id: "narrate",
    pass: "narrate",
    recommendedModel: options.model,
    promptPath,
    responsePath,
    responseSchema: null,
    status,
  });

  return promptPath;
}

// === PROMPT BUILDER ===

interface NarratePromptOptions {
  readonly tokensPath: string;
  readonly auditPath: string;
  readonly responsePath: string;
}

function buildNarratePrompt(opts: NarratePromptOptions): string {
  return `# Tokextract — DESIGN.md Narration

## Your task

You are writing the brand-narrative DESIGN.md for a SwiftUI app's design system.

Read the following files using the Read tool:
- \`${opts.tokensPath}\` — the complete DTCG token inventory
- \`${opts.auditPath}\` — drift findings and harmonization context

Then write a complete DESIGN.md to \`${opts.responsePath}\` using the Write tool.

## DESIGN.md format

### YAML front-matter (required)

\`\`\`yaml
---
name: "<AppName> Design System"
version: "1.0.0"
extracted: "<YYYY-MM-DD>"
source: "SwiftUI — tree-sitter pass + LLM normalization"
generated: "llm-narrated"
tokens:
  colors:
    <token-last-segment>: "{<full.token.name>}"
    # ... up to 10 color tokens
  typography:
    <token-last-segment>: "{<full.token.name>}"
  spacing:
    <token-last-segment>: "{<full.token.name>}"
---
\`\`\`

### Mandatory sections (in this exact order)

1. **Overview** — app purpose, design philosophy, what makes this visual language distinctive
2. **Colors** — palette structure, primitive → semantic → component hierarchy, brand rationale
3. **Typography** — type stack, Dynamic Type usage, scale rationale
4. **Layout** — spacing scale, grid system, common padding/margin patterns
5. **Elevation & Depth** — shadow levels, elevation tokens, depth philosophy
6. **Shapes** — corner radius scale, curve style (continuous/circular), shape vocabulary
7. **Components** — key component tokens, ButtonStyle/ViewModifier patterns, modifier chain examples
8. **Do's and Don'ts** — explicit usage rules, anti-patterns, Liquid Glass guidance if applicable

## Lint rules your output must satisfy

| Rule | Requirement |
|---|---|
| \`missing-sections\` | All 8 sections present in the canonical order above |
| \`section-order\` | Sections appear in order: Overview → Colors → Typography → Layout → Elevation & Depth → Shapes → Components → Do's and Don'ts |
| \`broken-ref\` | Every \`{{token}}\` reference resolves to a token in front-matter or tokens.json |
| \`missing-primary\` | At least one color tagged as primary/brand (name contains \`primary\`, \`brand\`, or \`accent\`) |
| \`contrast-ratio\` | Every foreground/background pairing in Components meets WCAG AA (4.5:1 body, 3:1 large ≥18.66px) |
| \`orphaned-tokens\` | Every token in front-matter is referenced in at least one prose section |
| \`missing-typography\` | At least one typography token documented in the Typography section |
| \`token-summary\` | Front-matter token count matches tokens referenced in prose ±0 |

## Writing guidelines

- Acceptance bar: an LLM given only this DESIGN.md plus a feature brief should produce brand-correct SwiftUI UI without further prompting. Write for that reader.
- Each section should explain *why*, not just *what*. DTCG carries the values; DESIGN.md carries the intent.
- Use \`\`{{token.name}}\`\` syntax to reference tokens inline in prose. Every such reference must resolve.
- In Do's and Don'ts: if \`.glassEffect()\` tokens are present, include the rule: **Don't** apply \`.glassEffect()\` to cards, list rows, or media containers — Apple's design guidance reserves glass for the navigation layer.
- Tone: clear, specific, actionable. Avoid filler prose. Dense and scannable.
- Token tier naming: \`primitive\` → raw values, \`semantic\` → intent-driven roles, \`component\` → UI-component-scoped.

## Critical instruction

Write the complete DESIGN.md file to \`${opts.responsePath}\` using the Write tool.
Do not return the content in your reply — use the Write tool only.
After writing, reply with exactly: done
`;
}

// === UTILITIES ===

function isTaskDone(responsePath: string): boolean {
  try {
    fs.accessSync(responsePath, fs.constants.F_OK);
    const content = fs.readFileSync(responsePath, "utf-8");
    // A real DESIGN.md will have YAML front-matter and at least one section header
    return content.includes("---") && content.includes("## Overview");
  } catch {
    return false;
  }
}
