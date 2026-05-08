#!/usr/bin/env node
/**
 * extract.ts — Extractoken CLI entry point
 *
 * Subcommands:
 *   parse    Stages 1–5a: discover Swift files, run AST parsers + regex side-channel,
 *            analyze (cluster-color), write findings.raw.json, write prompt files + manifest
 *   emit     Stages 6b–7a: read LLM outputs (or build mechanical candidates in --no-llm mode),
 *            emit tokens.json (Ajv-validated), audit.md, DESIGN.md stub
 *   finalize Stage 8: run DESIGN.md lint pass, print summary
 *
 * See PRD §8.5 for full flag documentation.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import glob from "fast-glob";
import { clusterColors } from "./analyzers/cluster-color.js";
import { scanHexLiterals } from "./analyzers/usage-scanner.js";
import { emitAuditReport } from "./emitters/audit-report.js";
import { formatLintErrors, lintDesignMd } from "./emitters/design-md-lint.js";
import { emitDesignMd } from "./emitters/design-md.js";
import { buildMechanicalColorCandidates, emitDtcg } from "./emitters/dtcg.js";
import { mergeMappings } from "./llm/merge.js";
import { writeNormalizeManifest } from "./llm/normalize.js";
import { loadAssetCatalogColors, resolveAssetColor } from "./parsers/asset-catalog.js";
import { extractColors } from "./parsers/color.js";
import type { CandidateFile, FindingsFile, RawFinding } from "./parsers/types.js";

// === CLI SETUP ===

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTRACTOKEN_VERSION = "1.0.0-slice1";
const DEFAULT_MODEL_NORMALIZE = "claude-haiku-4-5-20251001";
const DEFAULT_MODEL_HARMONIZE = "claude-sonnet-4-6";
const DEFAULT_MODEL_NARRATE = "claude-sonnet-4-6";
const DEFAULT_MAX_FILES = 2000;
const DEFAULT_DELTA_E_THRESHOLD = 2.5;

/**
 * iOS system semantic ColorResource names — resolve at runtime via UIKit/SwiftUI.
 * Used by Stage 2b to mark `Color(.label)` etc. as `isSystemAlias: true` rather
 * than emitting `assetMissing: true`.
 *
 * Sources:
 * - UIColor system background / fill / label semantics (UIKit)
 * - UIColor.systemGray[2-6] and UIColor.system<Color> static properties (UIKit)
 * - SwiftUI Color static members (.primary, .secondary, .accentColor, .tint)
 */
const SYSTEM_COLOR_RESOURCE_NAMES = new Set<string>([
  // === SwiftUI semantic colors ===
  "primary",
  "secondary",
  "accentColor",
  "tint",

  // === UIKit label semantics ===
  "label",
  "secondaryLabel",
  "tertiaryLabel",
  "quaternaryLabel",
  "placeholderText",
  "link",

  // === UIKit background semantics ===
  "systemBackground",
  "secondarySystemBackground",
  "tertiarySystemBackground",
  "systemGroupedBackground",
  "secondarySystemGroupedBackground",
  "tertiarySystemGroupedBackground",

  // === UIKit fill semantics ===
  "systemFill",
  "secondarySystemFill",
  "tertiarySystemFill",
  "quaternarySystemFill",

  // === UIKit separator semantics ===
  "separator",
  "opaqueSeparator",

  // === UIColor.systemGray family ===
  "systemGray",
  "systemGray2",
  "systemGray3",
  "systemGray4",
  "systemGray5",
  "systemGray6",

  // === UIColor system palette (static properties on UIColor) ===
  "systemRed",
  "systemGreen",
  "systemBlue",
  "systemOrange",
  "systemPink",
  "systemPurple",
  "systemYellow",
  "systemTeal",
  "systemIndigo",
  "systemBrown",
  "systemMint",
  "systemCyan",
]);

const program = new Command();

program
  .name("extract")
  .description("Extractoken — reverse-engineer a SwiftUI design system to DTCG tokens")
  .version(EXTRACTOKEN_VERSION);

// === parse subcommand ===

program
  .command("parse")
  .description("Stage 1–5a: discover Swift files, parse, analyze, write findings + manifest")
  .requiredOption("--path <dir>", "Path to the SwiftUI repository root")
  .option("--output <dir>", "Output directory (default: <path>/.extractoken-out)")
  .option("--no-llm", "Skip LLM passes (deterministic only)")
  .option("--max-files <n>", "Hard limit on .swift files (abort above)", String(DEFAULT_MAX_FILES))
  .option(
    "--delta-e-threshold <n>",
    "ΔE threshold for color clustering",
    String(DEFAULT_DELTA_E_THRESHOLD),
  )
  .option("--model-normalize <id>", "Model for normalize pass", DEFAULT_MODEL_NORMALIZE)
  .option(
    "--skip <categories>",
    "Comma-separated list of categories to skip (e.g. typography,spacing)",
  )
  .option("--verbose", "Verbose output", false)
  .action(
    async (opts: {
      path: string;
      output?: string;
      llm: boolean;
      maxFiles: string;
      deltaEThreshold: string;
      modelNormalize: string;
      skip?: string;
      verbose: boolean;
    }) => {
      await runParse({
        repoPath: path.resolve(opts.path),
        outputDir: opts.output
          ? path.resolve(opts.output)
          : path.resolve(opts.path, ".extractoken-out"),
        noLlm: !opts.llm,
        maxFiles: Number.parseInt(opts.maxFiles, 10),
        deltaEThreshold: Number.parseFloat(opts.deltaEThreshold),
        modelNormalize: opts.modelNormalize,
        skipCategories: opts.skip ? opts.skip.split(",").map((s) => s.trim()) : [],
        verbose: opts.verbose,
      });
    },
  );

// === emit subcommand ===

program
  .command("emit")
  .description("Stage 6b–7a: read LLM outputs, emit tokens.json + audit.md + DESIGN.md")
  .requiredOption("--output <dir>", "Output directory (same as used in parse)")
  .option("--no-llm", "Use mechanical candidates instead of LLM outputs")
  .option("--verbose", "Verbose output", false)
  .action(async (opts: { output: string; llm: boolean; verbose: boolean }) => {
    await runEmit({
      outputDir: path.resolve(opts.output),
      noLlm: !opts.llm,
      verbose: opts.verbose,
    });
  });

// === finalize subcommand ===

program
  .command("finalize")
  .description("Stage 8: run DESIGN.md lint pass and print summary")
  .requiredOption("--output <dir>", "Output directory")
  .option("--no-llm", "Stub mode (relaxed lint rules)")
  .option("--verbose", "Verbose output", false)
  .action(async (opts: { output: string; llm: boolean; verbose: boolean }) => {
    await runFinalize({
      outputDir: path.resolve(opts.output),
      noLlm: !opts.llm,
      verbose: opts.verbose,
    });
  });

program.parse(process.argv);

// === PARSE STAGE ===

interface ParseOptions {
  readonly repoPath: string;
  readonly outputDir: string;
  readonly noLlm: boolean;
  readonly maxFiles: number;
  readonly deltaEThreshold: number;
  readonly modelNormalize: string;
  readonly skipCategories: readonly string[];
  readonly verbose: boolean;
}

async function runParse(options: ParseOptions): Promise<void> {
  const {
    repoPath,
    outputDir,
    noLlm,
    maxFiles,
    deltaEThreshold,
    modelNormalize,
    skipCategories,
    verbose,
  } = options;

  log(verbose, `Extractoken ${EXTRACTOKEN_VERSION} — parse`);
  log(verbose, `  repo: ${repoPath}`);
  log(verbose, `  output: ${outputDir}`);

  // Validate repo path exists
  if (!fs.existsSync(repoPath)) {
    fatal(`Repository path does not exist: ${repoPath}`);
  }

  // === Stage 1: Discovery ===
  console.log("Stage 1: Discovering Swift files...");
  const swiftFiles = await glob("**/*.swift", {
    cwd: repoPath,
    absolute: true,
    followSymbolicLinks: false,
    ignore: ["**/node_modules/**", "**/.build/**", "**/DerivedData/**"],
  });

  if (swiftFiles.length > maxFiles) {
    fatal(
      `Repository has ${swiftFiles.length} Swift files, exceeding --max-files limit of ${maxFiles}. ` +
        `v1 supports up to ${maxFiles} files. Use --skip to reduce scope or wait for v2.`,
    );
  }

  console.log(`  Found ${swiftFiles.length} Swift files`);

  // === Stage 2: Parse (AST) ===
  console.log("Stage 2: Parsing Swift files (color pass)...");

  const allFindings: RawFinding[] = [];

  for (const filePath of swiftFiles) {
    if (skipCategories.includes("color")) continue;

    let source: string;
    try {
      source = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    const relativePath = path.relative(repoPath, filePath);
    try {
      const findings = extractColors(source, relativePath);
      allFindings.push(...findings);
    } catch (error) {
      // Non-fatal: log and continue
      if (verbose) {
        console.warn(`  Warning: color parser failed on ${relativePath}: ${String(error)}`);
      }
    }
  }

  const declCount = allFindings.filter((f) => f.isDeclaration).length;
  const callSiteCount = allFindings.filter((f) => !f.isDeclaration).length;
  log(verbose, `  ${declCount} color declarations, ${callSiteCount} call-site references found`);

  // === Stage 2b: Asset Catalog ===
  if (!skipCategories.includes("color")) {
    console.log("Stage 2b: Loading Asset Catalog colors...");
    const catalog = await loadAssetCatalogColors(repoPath);
    log(verbose, `  ${catalog.size} color assets found`);

    // 2b.1: Emit one first-class declaration finding per Asset Catalog colorset.
    // Many SwiftUI codebases keep all colors in .xcassets without a mirroring
    // `extension Color`. Those are still tokens — they just live in JSON not Swift.
    for (const [assetName, variants] of catalog) {
      const relPath = path.relative(repoPath, variants.assetPath);
      const primary = variants.light ?? variants.dark ?? variants.highContrast;
      if (!primary) continue;
      allFindings.push({
        category: "color",
        sourcePath: relPath,
        line: 1,
        col: 0,
        declName: assetName,
        rawValue: `<asset-catalog:${assetName}>`,
        normalizedValue: primary,
        context: "Asset Catalog colorset",
        isDeclaration: true,
        assetName,
        hasDarkVariant: variants.dark !== null,
        severity: "info",
      });
    }

    // Build a case-insensitive lookup map: Apple's auto-generated ColorResource enum
    // lowercases the first letter of the asset name (e.g. "GraplaPrimary" in the
    // .xcassets folder is referenced as `Color(.graplaPrimary)` in Swift).
    const catalogLookup = new Map<string, string>(); // lowercase-first-letter → canonical
    for (const assetName of catalog.keys()) {
      catalogLookup.set(assetName, assetName);
      catalogLookup.set(lowercaseFirst(assetName), assetName);
    }

    // 2b.2: Enrich Color("Name") and Color(.name) call-site findings using the catalog
    // and a known-system-semantic name list.
    for (let i = 0; i < allFindings.length; i++) {
      const finding = allFindings[i];
      if (!finding || !finding.assetName || finding.isDeclaration) continue;

      // Known iOS system ColorResource semantics (Color(.label), Color(.tint), etc.)
      // These are Apple-defined and resolve at runtime via the system color set.
      if (SYSTEM_COLOR_RESOURCE_NAMES.has(finding.assetName)) {
        allFindings[i] = {
          ...finding,
          isSystemAlias: true,
          severity: "info",
          assetMissing: false,
        };
        continue;
      }

      const canonicalName = catalogLookup.get(finding.assetName);
      const resolved = canonicalName ? resolveAssetColor(canonicalName, catalog) : null;
      if (resolved && canonicalName) {
        const primary = resolved.light ?? resolved.dark ?? resolved.highContrast;
        allFindings[i] = {
          ...finding,
          assetName: canonicalName, // normalize to catalog's canonical PascalCase
          normalizedValue: primary,
          hasDarkVariant: resolved.dark !== null,
        };
      } else {
        allFindings[i] = {
          ...finding,
          assetMissing: true,
          severity: "error",
          normalizedValue: null,
        };
      }
    }
  }

  // === Stage 3: Side-channel regex pass ===
  console.log("Stage 3: Scanning for hex literals (usage side-channel)...");
  const { hexFindings } = scanHexLiterals(swiftFiles, repoPath);
  log(verbose, `  ${hexFindings.length} hex literals found at call sites`);

  // === Stage 4: Analyze (color clustering) ===
  console.log("Stage 4: Clustering colors by ΔE...");
  const declarationFindings = allFindings.filter((f) => f.isDeclaration);
  const clusterResult = clusterColors(declarationFindings, deltaEThreshold);
  log(verbose, `  ${clusterResult.clusters.length} near-duplicate clusters found`);
  log(verbose, `  ${clusterResult.singletons.length} singleton colors`);

  // === Stage 5a: Write findings.raw.json ===
  const extractokenStateDir = path.join(outputDir, ".extractoken");
  fs.mkdirSync(extractokenStateDir, { recursive: true });

  const findingsFile: FindingsFile = {
    extractokenVersion: EXTRACTOKEN_VERSION,
    targetRepo: repoPath,
    extractedAt: new Date().toISOString(),
    findings: [...allFindings, ...hexFindings],
  };

  const findingsPath = path.join(extractokenStateDir, "findings.raw.json");
  fs.writeFileSync(findingsPath, `${JSON.stringify(findingsFile, null, 2)}\n`, "utf-8");
  console.log(`  Wrote findings to ${findingsPath}`);

  // === Stage 5a: Write cluster analysis ===
  const clusterPath = path.join(extractokenStateDir, "clusters.json");
  fs.writeFileSync(
    clusterPath,
    `${JSON.stringify(
      { clusters: clusterResult.clusters, singletons: clusterResult.singletons },
      null,
      2,
    )}\n`,
    "utf-8",
  );

  // === Stage 5a: Write LLM prompts + manifest (if LLM mode) ===
  if (!noLlm) {
    console.log("Stage 5a: Writing LLM normalize prompts + manifest...");
    const manifestPath = writeNormalizeManifest(findingsFile, {
      outputDir,
      extractokenSkillDir: __dirname,
      modelNormalize,
      categories: skipCategories.includes("color") ? [] : ["color"],
    });
    console.log(`  Wrote manifest to ${manifestPath}`);
  }

  // Success summary
  console.log("\nParse complete.");
  console.log(`  ${allFindings.filter((f) => f.isDeclaration).length} color declarations`);
  console.log(`  ${hexFindings.length} hex call-site literals`);
  console.log(`  ${clusterResult.clusters.length} near-duplicate clusters`);
  if (!noLlm) {
    console.log("\nNext: read .extractoken/llm-tasks.json and run pending LLM tasks.");
    console.log(`Then: node extract.js emit --output ${outputDir}`);
  } else {
    console.log(`\nNext: node extract.js emit --output ${outputDir} --no-llm`);
  }
}

// === EMIT STAGE ===

interface EmitOptions {
  readonly outputDir: string;
  readonly noLlm: boolean;
  readonly verbose: boolean;
}

async function runEmit(options: EmitOptions): Promise<void> {
  const { outputDir, noLlm, verbose } = options;

  log(verbose, `Extractoken ${EXTRACTOKEN_VERSION} — emit`);
  log(verbose, `  output: ${outputDir}`);

  // Read findings
  const findingsPath = path.join(outputDir, ".extractoken", "findings.raw.json");
  if (!fs.existsSync(findingsPath)) {
    fatal(`findings.raw.json not found at ${findingsPath}. Run 'parse' first.`);
  }

  const findingsFile = JSON.parse(fs.readFileSync(findingsPath, "utf-8")) as FindingsFile;
  const allFindings = findingsFile.findings;

  // Read cluster analysis
  const clusterPath = path.join(outputDir, ".extractoken", "clusters.json");
  let clusterResult = { clusters: [], singletons: [] } as ReturnType<typeof clusterColors>;
  if (fs.existsSync(clusterPath)) {
    const raw = JSON.parse(fs.readFileSync(clusterPath, "utf-8")) as ReturnType<
      typeof clusterColors
    >;
    clusterResult = raw;
  }

  // === Stage 6b: Build candidate files ===
  console.log("Stage 6b: Building candidate tokens...");

  let candidateFiles: CandidateFile[];

  if (noLlm) {
    // Deterministic mechanical candidates
    const colorCandidates = buildMechanicalColorCandidates(allFindings);
    candidateFiles = [colorCandidates];
    log(verbose, `  ${colorCandidates.candidates.length} mechanical color candidates`);
    log(verbose, `  ${colorCandidates.unresolved.length} unresolved`);
  } else {
    // Merge LLM mapping outputs with findings
    const llmOutDir = path.join(outputDir, ".extractoken", "llm-out");
    const colorMerged = mergeMappings(findingsFile, "color", llmOutDir);
    if (colorMerged.candidates.length > 0) {
      candidateFiles = [colorMerged];
      log(
        verbose,
        `  ${colorMerged.candidates.length} merged candidates (${colorMerged.candidates.filter((c) => c._llmDerived).length} LLM-derived, ${colorMerged.candidates.filter((c) => !c._llmDerived).length} mechanical)`,
      );
    } else {
      console.warn(
        "  Warning: No LLM mapping outputs found. Falling back to mechanical candidates.",
      );
      const colorCandidates = buildMechanicalColorCandidates(allFindings);
      candidateFiles = [colorCandidates];
    }
  }

  // === Stage 7a: Emit tokens.json ===
  console.log("Stage 7a: Emitting tokens.json...");

  const schemaPath = path.join(__dirname, "schemas", "dtcg-2025.10.json");
  const emitResult = emitDtcg(candidateFiles, { outputDir, schemaPath });
  console.log(`  Wrote ${emitResult.tokenCount} tokens to ${emitResult.tokensPath}`);

  // === Stage 7a: Emit audit.md ===
  console.log("Stage 7a: Emitting audit.md...");

  const declarationFindings = allFindings.filter((f) => f.category === "color" && f.isDeclaration);
  const callSiteFindings = allFindings.filter((f) => f.category === "color" && !f.isDeclaration);

  const unresolvedTokens = candidateFiles.flatMap((cf) => cf.unresolved);

  const auditPath = emitAuditReport(
    {
      declarationFindings,
      callSiteFindings,
      colorClusters: clusterResult.clusters,
      unresolvedTokens,
    },
    {
      outputDir,
      repoPath: findingsFile.targetRepo,
      extractedAt: findingsFile.extractedAt,
    },
  );
  console.log(`  Wrote audit report to ${auditPath}`);

  // === Stage 7b: Emit DESIGN.md (stub) ===
  console.log("Stage 7b: Emitting DESIGN.md stub...");

  const colorCandidates = candidateFiles.find((cf) => cf.category === "color");
  const appName = path.basename(findingsFile.targetRepo);

  const designMdPath = emitDesignMd(
    { colorTokens: colorCandidates?.candidates ?? [] },
    {
      outputDir,
      appName,
      extractedAt: findingsFile.extractedAt,
      isStub: noLlm || !hasNarrateOutput(outputDir),
    },
  );
  console.log(`  Wrote DESIGN.md to ${designMdPath}`);

  // Snapshot tokens.json to previous/
  const previousDir = path.join(outputDir, ".extractoken", "previous");
  fs.mkdirSync(previousDir, { recursive: true });
  fs.copyFileSync(path.join(outputDir, "tokens.json"), path.join(previousDir, "tokens.json"));

  console.log("\nEmit complete.");
  console.log(`  tokens.json: ${emitResult.tokenCount} tokens (DTCG-valid)`);
  console.log(`\nNext: node extract.js finalize --output ${outputDir}${noLlm ? " --no-llm" : ""}`);
}

// === FINALIZE STAGE ===

interface FinalizeOptions {
  readonly outputDir: string;
  readonly noLlm: boolean;
  readonly verbose: boolean;
}

async function runFinalize(options: FinalizeOptions): Promise<void> {
  const { outputDir, noLlm, verbose } = options;

  log(verbose, `Extractoken ${EXTRACTOKEN_VERSION} — finalize`);

  // Read DESIGN.md
  const designMdPath = path.join(outputDir, "DESIGN.md");
  if (!fs.existsSync(designMdPath)) {
    fatal(`DESIGN.md not found at ${designMdPath}. Run 'emit' first.`);
  }

  const designMdContent = fs.readFileSync(designMdPath, "utf-8");

  // Read tokens.json
  const tokensPath = path.join(outputDir, "tokens.json");
  let tokensJson: Record<string, unknown> = {};
  if (fs.existsSync(tokensPath)) {
    tokensJson = JSON.parse(fs.readFileSync(tokensPath, "utf-8")) as Record<string, unknown>;
  }

  // Run lint
  console.log("Stage 8: Running DESIGN.md lint...");
  const lintResults = lintDesignMd(designMdContent, tokensJson, { isStub: noLlm });

  const failedRules = lintResults.filter((r) => r.failed);
  const passedRules = lintResults.filter((r) => !r.failed);

  if (verbose) {
    for (const result of lintResults) {
      const icon = result.failed ? "✗" : "✓";
      console.log(`  ${icon} [${result.rule}] ${result.message}`);
    }
  }

  if (failedRules.length > 0) {
    console.error(`\n${formatLintErrors(lintResults)}`);
    process.exit(1);
  }

  // Summary
  console.log(`\n✓ DESIGN.md lint passed (${passedRules.length}/${lintResults.length} rules)`);
  console.log("\nExtracktoken complete. Output:");
  console.log(`  ${path.join(outputDir, "tokens.json")}`);
  console.log(`  ${path.join(outputDir, "DESIGN.md")}`);
  console.log(`  ${path.join(outputDir, "audit.md")}`);
}

// === UTILITIES ===

function hasNarrateOutput(outputDir: string): boolean {
  return fs.existsSync(path.join(outputDir, ".extractoken", "llm-out", "narrate.md"));
}

function log(verbose: boolean, message: string): void {
  if (verbose) console.log(message);
}

/** Lowercase the first character — matches Apple's ColorResource codegen convention. */
function lowercaseFirst(s: string): string {
  if (s.length === 0) return s;
  return s[0]?.toLowerCase() + s.slice(1);
}

function fatal(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}
