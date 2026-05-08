/**
 * llm/normalize.ts
 *
 * Generates normalize prompt files and the llm-tasks.json manifest.
 *
 * New contract (Slice 1.5): slim Mapping[] output, Node-side merge.
 *
 * The subagent:
 *   1. Reads findings.raw.json itself via the Read tool (path embedded in prompt)
 *   2. Emits a Mapping[] — one entry per declaration finding
 *   3. Writes that to responsePath via the Write tool
 *
 * The Node helper (llm/merge.ts) then joins Mapping entries with findings to
 * build the full CandidateFile. The LLM never invents $value — provenance and
 * normalizedValue come from findings.
 *
 * Chunking: ≤50 declarations per task. If a category has more, multiple tasks
 * are emitted: normalize-color-1, normalize-color-2, etc.
 * Each emits mapping.<category>.<chunk>.json independently.
 */

import fs from "node:fs";
import path from "node:path";
import type { FindingsFile, LlmTask, LlmTaskManifest, TokenCategory } from "../parsers/types.js";

// === PUBLIC API ===

export interface NormalizeOptions {
  readonly outputDir: string;
  readonly tokextractSkillDir: string; // Path to ~/.claude/skills/tokextract/
  readonly modelNormalize: string;
  readonly categories: readonly TokenCategory[];
}

/** Max declarations per LLM task. ~50 × ~80 tokens/entry = ~4k output — well under 20k cap. */
const CHUNK_SIZE = 50;

/**
 * Write prompt files and llm-tasks.json manifest for the LLM normalize pass.
 * Returns the path to the manifest file.
 */
export function writeNormalizeManifest(
  findingsFile: FindingsFile,
  options: NormalizeOptions,
): string {
  const promptsDir = path.join(options.outputDir, ".tokextract", "prompts");
  const llmOutDir = path.join(options.outputDir, ".tokextract", "llm-out");
  const manifestPath = path.join(options.outputDir, ".tokextract", "llm-tasks.json");
  const findingsPath = path.join(options.outputDir, ".tokextract", "findings.raw.json");

  fs.mkdirSync(promptsDir, { recursive: true });
  fs.mkdirSync(llmOutDir, { recursive: true });

  const tasks: LlmTask[] = [];

  for (const category of options.categories) {
    // Only declaration findings need naming — call sites don't become tokens
    const declarationFindings = findingsFile.findings.filter(
      (f) => f.category === category && f.isDeclaration,
    );

    if (declarationFindings.length === 0) continue;

    // Split declarations into chunks of ≤CHUNK_SIZE
    const chunks = chunkArray([...declarationFindings], CHUNK_SIZE);

    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
      const chunk = chunks[chunkIndex];
      if (!chunk || chunk.length === 0) continue;

      const chunkNumber = chunkIndex + 1;
      const taskId = `normalize-${category}-${chunkNumber}`;
      const promptPath = path.join(promptsDir, `${taskId}.md`);
      const responsePath = path.join(llmOutDir, `mapping.${category}.${chunkNumber}.json`);
      const responseSchema = path.join(options.tokextractSkillDir, "schemas", "mapping.json");

      // Extract declNames in this chunk so the prompt can reference them specifically
      const chunkDeclNames = chunk.map((f) => f.declName).filter((n): n is string => n !== null);

      const promptContent = buildNormalizePrompt({
        category,
        findingsPath,
        chunkDeclNames,
        chunkNumber,
        totalChunks: chunks.length,
        responsePath,
      });

      fs.writeFileSync(promptPath, promptContent, "utf-8");

      const status = isTaskDone(responsePath) ? "done" : "pending";

      tasks.push({
        id: taskId,
        pass: "normalize",
        recommendedModel: options.modelNormalize,
        promptPath,
        responsePath,
        responseSchema,
        status,
      });
    }
  }

  const manifest: LlmTaskManifest = {
    version: "1.0.0",
    outputDir: options.outputDir,
    generatedAt: new Date().toISOString(),
    tasks,
  };

  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
  return manifestPath;
}

/**
 * Read the current manifest. Returns null if not found.
 */
export function readManifest(outputDir: string): LlmTaskManifest | null {
  const manifestPath = path.join(outputDir, ".tokextract", "llm-tasks.json");
  try {
    const content = fs.readFileSync(manifestPath, "utf-8");
    return JSON.parse(content) as LlmTaskManifest;
  } catch {
    return null;
  }
}

/**
 * Update a task's status in the manifest.
 */
export function updateTaskStatus(
  outputDir: string,
  taskId: string,
  status: "pending" | "done" | "error",
): void {
  const manifest = readManifest(outputDir);
  if (!manifest) return;

  const task = manifest.tasks.find((t) => t.id === taskId);
  if (task) {
    task.status = status;
  }

  const manifestPath = path.join(outputDir, ".tokextract", "llm-tasks.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
}

// === PROMPT BUILDER ===

interface PromptOptions {
  readonly category: TokenCategory;
  readonly findingsPath: string;
  readonly chunkDeclNames: readonly string[];
  readonly chunkNumber: number;
  readonly totalChunks: number;
  readonly responsePath: string;
}

function buildNormalizePrompt(opts: PromptOptions): string {
  const { category, findingsPath, chunkDeclNames, chunkNumber, totalChunks, responsePath } = opts;
  const categoryLabel = category.charAt(0).toUpperCase() + category.slice(1);
  const chunkLabel = totalChunks > 1 ? ` (chunk ${chunkNumber}/${totalChunks})` : "";

  const declList = chunkDeclNames.map((n) => `  - ${n}`).join("\n");

  return `# Tokextract — ${categoryLabel} Token Normalization${chunkLabel}

## Your task

Propose canonical design-token names for ${category} declarations extracted from a SwiftUI codebase.

## Step 1 — Read the findings

Read this file using the Read tool:
\`${findingsPath}\`

Focus only on findings where \`isDeclaration: true\` and \`category: "${category}"\`.
This chunk covers these specific declarations:
${declList}

## Step 2 — Write your Mapping[]

Write a JSON array to \`${responsePath}\` using the Write tool.
Each object in the array must match this schema:

\`\`\`ts
interface Mapping {
  declName: string;      // must match a declName from findings.raw.json
  sourcePath: string;    // must match the finding's sourcePath (disambiguator for overloads)
  name: string;          // proposed canonical token name, kebab-case, dot-separated groups
  group: "primitive" | "semantic" | "component";
  description?: string;  // optional 1-line intent
  aliasOf?: string;      // if semantic, the primitive name it aliases (e.g. "color.primitive.blue-500")
  confidence: "high" | "medium" | "low";
}
\`\`\`

## Naming rules

- Format: \`${category}.<group>.<kebab-slug>\`
- Three tiers:
  - \`primitive\` — raw values with no semantic intent (e.g. \`color.primitive.blue-500\`)
  - \`semantic\` — intent-driven (e.g. \`color.semantic.brand-primary\`, \`color.semantic.surface-elevated\`)
  - \`component\` — scoped to a specific UI component (e.g. \`color.component.button-background\`)
- Use kebab-case segments. No camelCase in the name field.
- Prefer semantic tier when the Swift declName implies intent (e.g. \`brandPrimary\`, \`surfaceDark\`).
- Prefer primitive tier for hex-only values with no context (e.g. a raw \`#1A1C1E\`).
- Asset Catalog colors with descriptive names go semantic.
- System aliases (Color.primary, .label, etc.) — skip them; they won't appear in this list.

## Example mappings

\`\`\`json
[
  {
    "declName": "brandPrimary",
    "sourcePath": "Sources/UI/Tokens/Color+Brand.swift",
    "name": "color.semantic.brand-primary",
    "group": "semantic",
    "description": "Primary brand accent used on CTAs and interactive elements",
    "confidence": "high"
  },
  {
    "declName": "GraplaSurfaceBackground",
    "sourcePath": "Grapla.xcassets/GraplaSurfaceBackground.colorset/Contents.json",
    "name": "color.semantic.surface-background",
    "group": "semantic",
    "description": "App background surface, light/dark adaptive",
    "confidence": "high"
  },
  {
    "declName": "rawBlue",
    "sourcePath": "Sources/UI/Tokens/Color+Primitives.swift",
    "name": "color.primitive.blue-500",
    "group": "primitive",
    "confidence": "medium"
  }
]
\`\`\`

## Important constraints

- Only map the declarations listed above — do not invent entries for findings not in this chunk.
- Do NOT set \`$value\` or any color components — the Node helper derives values from findings.
- If you cannot confidently name a declaration, include it with \`confidence: "low"\`.
- Output must be a JSON array (not wrapped in an object).
- Write the array to \`${responsePath}\` using the Write tool, then reply: done
`;
}

// === UTILITIES ===

function chunkArray<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

function isTaskDone(responsePath: string): boolean {
  try {
    const content = fs.readFileSync(responsePath, "utf-8");
    const parsed = JSON.parse(content) as unknown[];
    return Array.isArray(parsed);
  } catch {
    return false;
  }
}
