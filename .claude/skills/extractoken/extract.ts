#!/usr/bin/env node
/**
 * extract.ts — Extractoken CLI entry point
 *
 * Subcommands:
 *   parse           Stages 1–5a: discover Swift files, run AST parsers + regex side-channel,
 *                   analyze (cluster-color, cluster-numeric, drift), write findings.raw.json,
 *                   write prompt files + manifest
 *   emit            Stages 6b–7a: read LLM outputs (or build mechanical candidates in --no-llm mode),
 *                   emit tokens.json (Ajv-validated), audit.md, DESIGN.md stub
 *   finalize        Stage 8: run DESIGN.md lint pass, print summary
 *   plan-harmonize  Reads clusters.json + numericClusters.json, appends harmonize task to manifest
 *   plan-narrate    Reads tokens.json + audit.md, appends narrate task to manifest
 *
 * See PRD §8.5 for full flag documentation.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import glob from "fast-glob";
import { clusterColors } from "./analyzers/cluster-color.js";
import { clusterNumeric } from "./analyzers/cluster-numeric.js";
import { diffTokens, formatDiffMarkdown } from "./analyzers/diff.js";
import { detectDrift } from "./analyzers/drift-detector.js";
import { scanHexLiterals } from "./analyzers/usage-scanner.js";
import { emitAuditReport } from "./emitters/audit-report.js";
import { formatLintErrors, lintDesignMd } from "./emitters/design-md-lint.js";
import { emitDesignMd } from "./emitters/design-md.js";
import { buildMechanicalCandidates, emitDtcg } from "./emitters/dtcg.js";
import { writeHarmonizeManifest } from "./llm/harmonize.js";
import { loadHarmonizeRecommendations, mergeMappings } from "./llm/merge.js";
import { writeNarrateManifest } from "./llm/narrate.js";
import { readManifest, writeNormalizeManifest } from "./llm/normalize.js";
import { extractAnimation } from "./parsers/animation.js";
import { loadAssetCatalogColors, resolveAssetColor } from "./parsers/asset-catalog.js";
import { extractColors } from "./parsers/color.js";
import { extractComponents } from "./parsers/component.js";
import { extractGlass } from "./parsers/glass.js";
import { extractBundleId } from "./parsers/info-plist.js";
import { extractShadow } from "./parsers/shadow.js";
import { extractShape } from "./parsers/shape.js";
import { extractSpacing } from "./parsers/spacing.js";
import { extractTheme } from "./parsers/theme.js";
import type {
  CandidateFile,
  FindingsFile,
  LlmTask,
  LlmTaskManifest,
  RawFinding,
  TokenCategory,
} from "./parsers/types.js";
import { extractTypography } from "./parsers/typography.js";

// === CLI SETUP ===

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTRACTOKEN_VERSION = "1.0.0-slice3";
const DEFAULT_MODEL_NORMALIZE = "claude-haiku-4-5-20251001";
const DEFAULT_MODEL_HARMONIZE = "claude-sonnet-4-6";
const DEFAULT_MODEL_NARRATE = "claude-sonnet-4-6";
const DEFAULT_MAX_FILES = 2000;
const DEFAULT_DELTA_E_THRESHOLD = 2.5;

/** All supported token categories in pipeline order */
const ALL_CATEGORIES: readonly TokenCategory[] = [
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
  .description(
    "Stage 1–5a: discover Swift files, parse all categories, analyze, write findings + manifest",
  )
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
  .option(
    "--force-color-space <space>",
    "Override color space for color emitter: srgb|display-p3|oklch",
  )
  .option("--target-os <ver>", "Target iOS version (gates Liquid Glass and @Entry extraction)")
  .option(
    "--vendor-namespace <s>",
    "Override vendor namespace (default: derived from Info.plist CFBundleIdentifier)",
  )
  .option("--self-critique", "Enable self-critique pass after narrate", false)
  .option("--model-harmonize <id>", "Model for harmonize pass", DEFAULT_MODEL_HARMONIZE)
  .option("--model-narrate <id>", "Model for narrate pass", DEFAULT_MODEL_NARRATE)
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
      forceColorSpace?: string;
      targetOs?: string;
      vendorNamespace?: string;
      selfCritique: boolean;
      modelHarmonize: string;
      modelNarrate: string;
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
        forceColorSpace: opts.forceColorSpace,
        targetOs: opts.targetOs,
        vendorNamespace: opts.vendorNamespace,
        selfCritique: opts.selfCritique,
        modelHarmonize: opts.modelHarmonize,
        modelNarrate: opts.modelNarrate,
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

// === plan-harmonize subcommand ===

program
  .command("plan-harmonize")
  .description("Read clusters.json + numericClusters.json, append harmonize task to llm-tasks.json")
  .requiredOption("--output <dir>", "Output directory")
  .option("--model-harmonize <id>", "Model for harmonize pass", DEFAULT_MODEL_HARMONIZE)
  .action(async (opts: { output: string; modelHarmonize: string }) => {
    await runPlanHarmonize({
      outputDir: path.resolve(opts.output),
      modelHarmonize: opts.modelHarmonize,
    });
  });

// === plan-narrate subcommand ===

program
  .command("plan-narrate")
  .description("Read tokens.json + audit.md, append narrate task to llm-tasks.json")
  .requiredOption("--output <dir>", "Output directory")
  .option("--model-narrate <id>", "Model for narrate pass", DEFAULT_MODEL_NARRATE)
  .action(async (opts: { output: string; modelNarrate: string }) => {
    await runPlanNarrate({
      outputDir: path.resolve(opts.output),
      modelNarrate: opts.modelNarrate,
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
  // Optional flags — undefined means "not specified"
  readonly forceColorSpace: string | undefined;
  readonly targetOs: string | undefined;
  readonly vendorNamespace: string | undefined;
  readonly selfCritique: boolean;
  readonly modelHarmonize: string;
  readonly modelNarrate: string;
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

  // === Derive vendor namespace ===
  const vendorNamespace =
    options.vendorNamespace ??
    extractBundleId(repoPath) ??
    `com.unknown.${path.basename(repoPath)}`;
  log(verbose, `  vendor namespace: ${vendorNamespace}`);

  // === Detect target OS ===
  const targetOs = options.targetOs ?? detectTargetOs(repoPath);
  log(verbose, `  target OS: iOS ${targetOs}`);

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

  // === Stage 2: Parse (all 9 categories) ===
  const activeCategories = ALL_CATEGORIES.filter((cat) => !skipCategories.includes(cat));
  console.log(`Stage 2: Parsing Swift files (${activeCategories.length} categories)...`);

  const allFindings: RawFinding[] = [];

  // Per-category finding accumulators for verbose logging
  const categoryFindings = new Map<TokenCategory, { decls: number; callSites: number }>();
  for (const cat of activeCategories) {
    categoryFindings.set(cat, { decls: 0, callSites: 0 });
  }

  for (const filePath of swiftFiles) {
    let source: string;
    try {
      source = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    const relativePath = path.relative(repoPath, filePath);

    // Run each active parser
    for (const category of activeCategories) {
      try {
        const findings = runParser(category, source, relativePath);
        allFindings.push(...findings);

        // Track per-category counts for verbose output
        const counts = categoryFindings.get(category);
        if (counts) {
          for (const f of findings) {
            if (f.isDeclaration) {
              counts.decls++;
            } else {
              counts.callSites++;
            }
          }
        }
      } catch (error) {
        if (verbose) {
          console.warn(`  Warning: ${category} parser failed on ${relativePath}: ${String(error)}`);
        }
      }
    }
  }

  // === Stage 2b: Asset Catalog (color only) ===
  if (!skipCategories.includes("color")) {
    console.log("Stage 2b: Loading Asset Catalog colors...");
    const catalog = await loadAssetCatalogColors(repoPath);
    log(verbose, `  ${catalog.size} color assets found`);

    // 2b.1: Emit one first-class declaration finding per Asset Catalog colorset.
    for (const [assetName, variants] of catalog) {
      const relPath = path.relative(repoPath, variants.assetPath);
      const primary = variants.light ?? variants.dark ?? variants.highContrast;
      if (!primary) continue;
      const catalogFinding: RawFinding = {
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
      };
      allFindings.push(catalogFinding);

      const counts = categoryFindings.get("color");
      if (counts) counts.decls++;
    }

    // Build a case-insensitive lookup map for ColorResource enum convention.
    const catalogLookup = new Map<string, string>();
    for (const assetName of catalog.keys()) {
      catalogLookup.set(assetName, assetName);
      catalogLookup.set(lowercaseFirst(assetName), assetName);
    }

    // 2b.2: Enrich Color("Name") and Color(.name) call-site findings.
    for (let i = 0; i < allFindings.length; i++) {
      const finding = allFindings[i];
      if (!finding || !finding.assetName || finding.isDeclaration || finding.category !== "color") {
        continue;
      }

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
          assetName: canonicalName,
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

  // Verbose per-category log
  if (verbose) {
    for (const [cat, counts] of categoryFindings) {
      console.log(`  ${cat}: ${counts.decls} declarations, ${counts.callSites} call-sites`);
    }
  }

  // === Stage 3: Side-channel regex pass ===
  console.log("Stage 3: Scanning for hex literals (usage side-channel)...");
  const { hexFindings } = scanHexLiterals(swiftFiles, repoPath);
  log(verbose, `  ${hexFindings.length} hex literals found at call sites`);

  // === Stage 4: Analyze ===
  console.log("Stage 4: Analyzing clusters and drift...");

  // Color clustering
  const declarationFindings = allFindings.filter((f) => f.isDeclaration);
  const colorDeclarations = declarationFindings.filter((f) => f.category === "color");
  const clusterResult = clusterColors(colorDeclarations, deltaEThreshold);
  log(
    verbose,
    `  Color: ${clusterResult.clusters.length} near-duplicate clusters, ${clusterResult.singletons.length} singletons`,
  );

  // Numeric clustering (spacing, cornerRadius, shadow)
  const numericClusterResult = clusterNumeric(allFindings);
  log(verbose, `  Numeric: ${numericClusterResult.clusters.length} numeric clusters`);

  // Drift detection
  const driftReport = detectDrift(allFindings);
  log(verbose, `  Drift: ${driftReport.findings.length} off-scale numeric values`);

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

  // Write numeric clusters
  const numericClusterPath = path.join(extractokenStateDir, "numericClusters.json");
  fs.writeFileSync(
    numericClusterPath,
    `${JSON.stringify(numericClusterResult, null, 2)}\n`,
    "utf-8",
  );

  // Write drift report
  const driftPath = path.join(extractokenStateDir, "drift.json");
  // DriftReport contains a ReadonlyMap — serialize it as a plain object
  const driftJson = {
    findings: driftReport.findings,
    byCategory: Object.fromEntries(driftReport.byCategory.entries()),
  };
  fs.writeFileSync(driftPath, `${JSON.stringify(driftJson, null, 2)}\n`, "utf-8");

  // Write vendor namespace + target OS for use by emit stage
  const metaPath = path.join(extractokenStateDir, "meta.json");
  fs.writeFileSync(
    metaPath,
    `${JSON.stringify({ vendorNamespace, targetOs }, null, 2)}\n`,
    "utf-8",
  );

  // === Stage 5a: Write LLM prompts + manifest (if LLM mode) ===
  if (!noLlm) {
    console.log("Stage 5a: Writing LLM normalize prompts + manifest...");

    // Write manifest for all active categories (excluding skipped)
    const categoriesForNormalize = activeCategories.filter((cat) => !skipCategories.includes(cat));

    const manifestPath = writeNormalizeManifest(findingsFile, {
      outputDir,
      extractokenSkillDir: __dirname,
      modelNormalize,
      categories: categoriesForNormalize,
    });
    console.log(`  Wrote manifest to ${manifestPath}`);
  }

  // Success summary
  const totalDecls = declarationFindings.length;
  const totalCallSites = allFindings.filter((f) => !f.isDeclaration).length;
  console.log("\nParse complete.");
  console.log(`  ${totalDecls} total declarations across ${activeCategories.length} categories`);
  console.log(`  ${totalCallSites} call-site references`);
  console.log(`  ${hexFindings.length} hex call-site literals`);
  console.log(`  ${clusterResult.clusters.length} color near-duplicate clusters`);
  console.log(`  ${numericClusterResult.clusters.length} numeric clusters`);
  console.log(`  ${driftReport.findings.length} off-scale values`);
  if (!noLlm) {
    console.log("\nNext: read .extractoken/llm-tasks.json and run pending LLM tasks.");
    console.log(`Then: node extract.js plan-harmonize --output ${outputDir}`);
    console.log(`Then: node extract.js emit --output ${outputDir}`);
  } else {
    console.log(`\nNext: node extract.js emit --output ${outputDir} --no-llm`);
  }
}

// === PLAN-HARMONIZE STAGE ===

interface PlanHarmonizeOptions {
  readonly outputDir: string;
  readonly modelHarmonize: string;
}

async function runPlanHarmonize(options: PlanHarmonizeOptions): Promise<void> {
  const { outputDir, modelHarmonize } = options;
  const stateDir = path.join(outputDir, ".extractoken");

  // Read clusters.json
  const clusterPath = path.join(stateDir, "clusters.json");
  let colorClusters: unknown = { clusters: [] };
  if (fs.existsSync(clusterPath)) {
    colorClusters = JSON.parse(fs.readFileSync(clusterPath, "utf-8")) as unknown;
  }

  // Read numericClusters.json
  const numericClusterPath = path.join(stateDir, "numericClusters.json");
  let numericClusters: unknown = { clusters: [] };
  if (fs.existsSync(numericClusterPath)) {
    numericClusters = JSON.parse(fs.readFileSync(numericClusterPath, "utf-8")) as unknown;
  }

  // Combine both cluster sources
  const combinedClusters = {
    colorClusters,
    numericClusters,
  };

  // Check if there are any clusters to harmonize
  const colorClusterArr = getClusterArray(colorClusters);
  const numericClusterArr = getClusterArray(numericClusters);

  if (colorClusterArr.length === 0 && numericClusterArr.length === 0) {
    console.log("plan-harmonize: no clusters to harmonize — skipping.");
    return;
  }

  // Load or create manifest
  const manifestPath = path.join(stateDir, "llm-tasks.json");
  let manifest: LlmTaskManifest;
  if (fs.existsSync(manifestPath)) {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as LlmTaskManifest;
  } else {
    manifest = {
      version: "1.0.0",
      outputDir,
      generatedAt: new Date().toISOString(),
      tasks: [],
    };
  }

  // Remove any existing harmonize task (idempotent)
  manifest.tasks = manifest.tasks.filter((t) => t.id !== "harmonize");

  // Write harmonize manifest entry
  writeHarmonizeManifest({
    outputDir,
    model: modelHarmonize,
    clusters: combinedClusters,
    llmTasks: manifest.tasks,
  });

  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
  console.log(`plan-harmonize: wrote harmonize task to ${manifestPath}`);
  console.log(
    `  ${colorClusterArr.length} color clusters + ${numericClusterArr.length} numeric clusters`,
  );
}

// === PLAN-NARRATE STAGE ===

interface PlanNarrateOptions {
  readonly outputDir: string;
  readonly modelNarrate: string;
}

async function runPlanNarrate(options: PlanNarrateOptions): Promise<void> {
  const { outputDir, modelNarrate } = options;

  // Verify prerequisites exist
  const tokensPath = path.join(outputDir, "tokens.json");
  const auditPath = path.join(outputDir, "audit.md");

  if (!fs.existsSync(tokensPath)) {
    fatal(`tokens.json not found at ${tokensPath}. Run 'emit' first.`);
  }
  if (!fs.existsSync(auditPath)) {
    fatal(`audit.md not found at ${auditPath}. Run 'emit' first.`);
  }

  // Load or create manifest
  const manifestPath = path.join(outputDir, ".extractoken", "llm-tasks.json");
  let manifest: LlmTaskManifest;
  if (fs.existsSync(manifestPath)) {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as LlmTaskManifest;
  } else {
    manifest = {
      version: "1.0.0",
      outputDir,
      generatedAt: new Date().toISOString(),
      tasks: [],
    };
  }

  // Remove any existing narrate task (idempotent)
  manifest.tasks = manifest.tasks.filter((t) => t.id !== "narrate");

  // Write narrate manifest entry
  writeNarrateManifest({
    outputDir,
    model: modelNarrate,
    llmTasks: manifest.tasks,
  });

  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
  console.log(`plan-narrate: wrote narrate task to ${manifestPath}`);
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

  // Read cluster analysis (color)
  const clusterPath = path.join(outputDir, ".extractoken", "clusters.json");
  let clusterResult = { clusters: [], singletons: [] } as ReturnType<typeof clusterColors>;
  if (fs.existsSync(clusterPath)) {
    clusterResult = JSON.parse(fs.readFileSync(clusterPath, "utf-8")) as ReturnType<
      typeof clusterColors
    >;
  }

  // Read numeric cluster + drift data for audit
  const numericClusterPath = path.join(outputDir, ".extractoken", "numericClusters.json");
  let numericClusterResult = { clusters: [], histogram: [] } as ReturnType<typeof clusterNumeric>;
  if (fs.existsSync(numericClusterPath)) {
    numericClusterResult = JSON.parse(fs.readFileSync(numericClusterPath, "utf-8")) as ReturnType<
      typeof clusterNumeric
    >;
  }

  const driftPath = path.join(outputDir, ".extractoken", "drift.json");
  let driftReport: { findings: unknown[]; byCategory: Record<string, unknown[]> } = {
    findings: [],
    byCategory: {},
  };
  if (fs.existsSync(driftPath)) {
    driftReport = JSON.parse(fs.readFileSync(driftPath, "utf-8")) as typeof driftReport;
  }

  // Read vendor namespace + target OS from meta.json
  const metaPath = path.join(outputDir, ".extractoken", "meta.json");
  let vendorNamespace = `com.unknown.${path.basename(findingsFile.targetRepo)}`;
  let targetOs = "17";
  if (fs.existsSync(metaPath)) {
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8")) as {
      vendorNamespace?: string;
      targetOs?: string;
    };
    if (meta.vendorNamespace) vendorNamespace = meta.vendorNamespace;
    if (meta.targetOs) targetOs = meta.targetOs;
  }

  // Read harmonize recommendations if present
  const llmOutDir = path.join(outputDir, ".extractoken", "llm-out");
  const harmonizeRecommendations = loadHarmonizeRecommendations(llmOutDir);

  // === Stage 6b: Diff against previous tokens.json ===
  const previousTokensPath = path.join(outputDir, ".extractoken", "previous", "tokens.json");
  let diffMarkdown: string | null = null;
  if (fs.existsSync(previousTokensPath)) {
    try {
      const previousTokens = JSON.parse(fs.readFileSync(previousTokensPath, "utf-8")) as unknown;
      // We'll compute diff after building current tokens; store previous for now
      log(verbose, "  Previous tokens.json found — diff will be computed");
      // Defer diff computation to after emit; store previousTokens in scope
      const previousTokensData = previousTokens;

      // We'll use a two-pass approach: compute mechanical candidates first,
      // emit to a temporary structure, then diff. For simplicity, diff the
      // final written tokens.json after emit.
      // Store it for use after tokens.json is written.
      void previousTokensData; // used below
    } catch {
      log(verbose, "  Warning: could not read previous tokens.json for diff");
    }
  }

  // === Stage 6b: Build candidate files ===
  console.log("Stage 6b: Building candidate tokens...");

  let candidateFiles: CandidateFile[];

  if (noLlm) {
    // Deterministic mechanical candidates for all categories
    candidateFiles = buildMechanicalCandidates(allFindings, vendorNamespace);
    let totalCandidates = 0;
    let totalUnresolved = 0;
    for (const cf of candidateFiles) {
      totalCandidates += cf.candidates.length;
      totalUnresolved += cf.unresolved.length;
    }
    log(
      verbose,
      `  ${totalCandidates} mechanical candidates across ${candidateFiles.length} categories`,
    );
    log(verbose, `  ${totalUnresolved} unresolved`);
  } else {
    // Merge LLM mapping outputs with findings for each category
    const categories = ALL_CATEGORIES.filter((cat) => {
      const hasFindings = allFindings.some((f) => f.category === cat && f.isDeclaration);
      return hasFindings;
    });

    candidateFiles = [];
    for (const category of categories) {
      const merged = mergeMappings(findingsFile, category, llmOutDir);
      if (merged.candidates.length > 0 || merged.unresolved.length > 0) {
        candidateFiles.push(merged);
        log(
          verbose,
          `  ${category}: ${merged.candidates.length} merged candidates (${merged.candidates.filter((c) => c._llmDerived).length} LLM-derived)`,
        );
      }
    }

    if (candidateFiles.length === 0) {
      console.warn(
        "  Warning: No LLM mapping outputs found. Falling back to mechanical candidates.",
      );
      candidateFiles = buildMechanicalCandidates(allFindings, vendorNamespace);
    }
  }

  // === Stage 7a: Emit tokens.json ===
  console.log("Stage 7a: Emitting tokens.json...");

  const schemaPath = path.join(__dirname, "schemas", "dtcg-2025.10.json");
  const emitResult = emitDtcg(candidateFiles, { outputDir, schemaPath, vendorNamespace });
  console.log(`  Wrote ${emitResult.tokenCount} tokens to ${emitResult.tokensPath}`);

  // === Stage 6b: Compute diff (now that tokens.json exists) ===
  if (fs.existsSync(previousTokensPath)) {
    try {
      const previousTokens = JSON.parse(fs.readFileSync(previousTokensPath, "utf-8")) as unknown;
      const currentTokens = JSON.parse(fs.readFileSync(emitResult.tokensPath, "utf-8")) as unknown;
      const diff = diffTokens(previousTokens, currentTokens);
      diffMarkdown = formatDiffMarkdown(diff);
      log(
        verbose,
        `  Diff: ${diff.totalCount} total changes (${diff.added.length} added, ${diff.removed.length} removed, ${diff.changed.length} changed)`,
      );
    } catch {
      log(verbose, "  Warning: diff computation failed");
    }
  }

  // === Stage 7a: Emit audit.md ===
  console.log("Stage 7a: Emitting audit.md...");

  const auditPath = emitAuditReport(
    {
      allFindings,
      colorClusters: clusterResult.clusters,
      numericClusters: numericClusterResult.clusters,
      driftFindings: driftReport.findings as import("./analyzers/drift-detector.js").DriftFinding[],
      driftByCategory: driftReport.byCategory as Record<
        string,
        import("./analyzers/drift-detector.js").DriftFinding[]
      >,
      unresolvedTokens: candidateFiles.flatMap((cf) => cf.unresolved),
      harmonizeRecommendations,
      diffMarkdown,
    },
    {
      outputDir,
      repoPath: findingsFile.targetRepo,
      extractedAt: findingsFile.extractedAt,
    },
  );
  console.log(`  Wrote audit report to ${auditPath}`);

  // === Stage 7b: Emit DESIGN.md ===
  console.log("Stage 7b: Emitting DESIGN.md stub...");

  const colorCandidateFile = candidateFiles.find((cf) => cf.category === "color");
  const typographyCandidateFile = candidateFiles.find((cf) => cf.category === "typography");
  const spacingCandidateFile = candidateFiles.find((cf) => cf.category === "spacing");
  const appName = path.basename(findingsFile.targetRepo);

  const designMdPath = emitDesignMd(
    {
      colorTokens: colorCandidateFile?.candidates ?? [],
      typographyTokens: typographyCandidateFile?.candidates ?? [],
      spacingTokens: spacingCandidateFile?.candidates ?? [],
      allCandidateFiles: candidateFiles,
    },
    {
      outputDir,
      appName,
      extractedAt: findingsFile.extractedAt,
      isStub: noLlm || !hasNarrateOutput(outputDir),
    },
  );
  console.log(`  Wrote DESIGN.md to ${designMdPath}`);

  // === Stage 7b: Snapshot tokens.json ===
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
  console.log("\nExtracttoken complete. Output:");
  console.log(`  ${path.join(outputDir, "tokens.json")}`);
  console.log(`  ${path.join(outputDir, "DESIGN.md")}`);
  console.log(`  ${path.join(outputDir, "audit.md")}`);
}

// === PARSER DISPATCH ===

/**
 * Run the appropriate parser for a given category.
 * Returns an empty array for unsupported categories (defensive).
 */
function runParser(category: TokenCategory, source: string, filePath: string): RawFinding[] {
  switch (category) {
    case "color":
      return extractColors(source, filePath);
    case "typography":
      return extractTypography(source, filePath);
    case "spacing":
      return extractSpacing(source, filePath);
    case "cornerRadius":
      return extractShape(source, filePath);
    case "shadow":
      return extractShadow(source, filePath);
    case "animation":
      return extractAnimation(source, filePath);
    case "component":
      return extractComponents(source, filePath);
    case "liquidGlass":
      return extractGlass(source, filePath);
    case "theme":
      return extractTheme(source, filePath);
    default:
      return [];
  }
}

// === UTILITIES ===

/**
 * Detect target OS from Package.swift or .xcodeproj settings.
 * Falls back to "17" if not detectable.
 */
function detectTargetOs(repoPath: string): string {
  const packageSwiftPath = path.join(repoPath, "Package.swift");
  if (fs.existsSync(packageSwiftPath)) {
    try {
      const content = fs.readFileSync(packageSwiftPath, "utf-8");
      // e.g. .iOS(.v18) or .iOS(.v26)
      const match = /\.iOS\(\.v(\d+)\)/.exec(content);
      if (match?.[1]) return match[1];
    } catch {
      // fall through
    }
  }
  return "17";
}

function hasNarrateOutput(outputDir: string): boolean {
  return fs.existsSync(path.join(outputDir, ".extractoken", "llm-out", "narrate.md"));
}

function getClusterArray(clusters: unknown): unknown[] {
  if (Array.isArray(clusters)) return clusters as unknown[];
  if (typeof clusters === "object" && clusters !== null) {
    const obj = clusters as Record<string, unknown>;
    const arr = obj.clusters ?? obj.colorClusters;
    if (Array.isArray(arr)) return arr as unknown[];
  }
  return [];
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
