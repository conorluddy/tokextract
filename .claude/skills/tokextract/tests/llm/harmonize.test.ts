/**
 * tests/llm/harmonize.test.ts
 *
 * Unit tests for llm/harmonize.ts — the harmonize prompt generator.
 *
 * Tests cover: task structure, prompt size, scaling, schema validation.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
// biome-ignore lint/suspicious/noExplicitAny: Ajv requires dynamic import via createRequire
const Ajv = require("ajv/dist/2020") as any; // biome-ignore lint/suspicious/noExplicitAny: Ajv require pattern
import { writeHarmonizeManifest } from "../../llm/harmonize.js";
import type { LlmTask } from "../../parsers/types.js";

// === FIXTURES ===

function makeCluster(id: string, memberCount: number) {
  return {
    id,
    members: Array.from({ length: memberCount }, (_, i) => ({
      sourcePath: "Sources/Colors.swift",
      line: 10 + i,
      rawValue: `#1A1C${(1 + i).toString(16).padStart(2, "0").toUpperCase()}`,
      normalizedValue: { r: 0.1, g: 0.11, b: 0.12 + i * 0.001, a: 1.0, colorSpace: "srgb" },
    })),
    deltaEMax: 1.8,
    proposed: `color.primitive.ink-${id}`,
  };
}

function makeTypicalClusters() {
  return {
    version: "1.0.0",
    generatedAt: "2026-05-08T00:00:00Z",
    clusters: [
      makeCluster("ink-dark", 3),
      makeCluster("brand-blue", 2),
      makeCluster("surface-bg", 4),
    ],
  };
}

function makeLargeClusters(clusterCount: number) {
  return {
    version: "1.0.0",
    generatedAt: "2026-05-08T00:00:00Z",
    clusters: Array.from({ length: clusterCount }, (_, i) =>
      makeCluster(`cluster-${i}`, Math.min(2 + (i % 5), 10)),
    ),
  };
}

// === HELPERS ===

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokextract-harmonize-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// === TESTS ===

describe("harmonize — manifest task structure", () => {
  it("appends a task with id 'harmonize' and correct paths", () => {
    const llmTasks: LlmTask[] = [];
    const clusters = makeTypicalClusters();

    writeHarmonizeManifest({ outputDir: tmpDir, model: "claude-sonnet-4-6", clusters, llmTasks });

    expect(llmTasks).toHaveLength(1);
    const task = llmTasks[0];
    expect(task?.id).toBe("harmonize");
    expect(task?.pass).toBe("harmonize");
    expect(task?.recommendedModel).toBe("claude-sonnet-4-6");
    expect(task?.status).toBe("pending");
    expect(task?.responseSchema).toBeTruthy();
    expect(task?.responseSchema).toContain("harmonize-recommendations.json");
  });

  it("sets responsePath under <outputDir>/.tokextract/llm-out/", () => {
    const llmTasks: LlmTask[] = [];

    writeHarmonizeManifest({
      outputDir: tmpDir,
      model: "claude-sonnet-4-6",
      clusters: makeTypicalClusters(),
      llmTasks,
    });

    const task = llmTasks[0];
    const expectedPrefix = path.join(tmpDir, ".tokextract", "llm-out");
    expect(task?.responsePath).toContain(expectedPrefix);
    expect(task?.responsePath).toContain("mapping.harmonize.json");
  });

  it("sets promptPath under <outputDir>/.tokextract/prompts/", () => {
    const llmTasks: LlmTask[] = [];

    writeHarmonizeManifest({
      outputDir: tmpDir,
      model: "claude-sonnet-4-6",
      clusters: makeTypicalClusters(),
      llmTasks,
    });

    const task = llmTasks[0];
    const expectedPrefix = path.join(tmpDir, ".tokextract", "prompts");
    expect(task?.promptPath).toContain(expectedPrefix);
    expect(task?.promptPath).toContain("harmonize.md");
  });

  it("marks task as done if mapping.harmonize.json already exists and is a valid array", () => {
    // Pre-write a valid response
    const llmOutDir = path.join(tmpDir, ".tokextract", "llm-out");
    fs.mkdirSync(llmOutDir, { recursive: true });
    const responsePath = path.join(llmOutDir, "mapping.harmonize.json");
    fs.writeFileSync(responsePath, JSON.stringify([{ clusterID: "ink-dark" }]), "utf-8");

    const llmTasks: LlmTask[] = [];
    writeHarmonizeManifest({
      outputDir: tmpDir,
      model: "claude-sonnet-4-6",
      clusters: makeTypicalClusters(),
      llmTasks,
    });

    expect(llmTasks[0]?.status).toBe("done");
  });
});

describe("harmonize — prompt size", () => {
  it("produces a prompt ≤5KB on typical input (3 clusters)", () => {
    const llmTasks: LlmTask[] = [];
    const promptPath = writeHarmonizeManifest({
      outputDir: tmpDir,
      model: "claude-sonnet-4-6",
      clusters: makeTypicalClusters(),
      llmTasks,
    });

    const content = fs.readFileSync(promptPath, "utf-8");
    const sizeBytes = Buffer.byteLength(content, "utf-8");

    expect(sizeBytes).toBeLessThanOrEqual(5 * 1024);
  });

  it("scales gracefully — stays ≤5KB on 10 clusters with ≤10 members each", () => {
    const llmTasks: LlmTask[] = [];
    const promptPath = writeHarmonizeManifest({
      outputDir: tmpDir,
      model: "claude-sonnet-4-6",
      clusters: makeLargeClusters(10),
      llmTasks,
    });

    const content = fs.readFileSync(promptPath, "utf-8");
    const sizeBytes = Buffer.byteLength(content, "utf-8");

    // 10 clusters × ~10 members — should still be comfortably under 5KB
    expect(sizeBytes).toBeLessThanOrEqual(5 * 1024);
  });

  it("prompt inlines cluster data (not a path reference)", () => {
    const llmTasks: LlmTask[] = [];
    const clusters = makeTypicalClusters();

    const promptPath = writeHarmonizeManifest({
      outputDir: tmpDir,
      model: "claude-sonnet-4-6",
      clusters,
      llmTasks,
    });

    const content = fs.readFileSync(promptPath, "utf-8");

    // Verify clusters are inlined — first cluster ID should appear in prompt body
    expect(content).toContain("ink-dark");
    // Should not tell subagent to Read a clusters.json file
    expect(content).not.toContain("clusters.json");
  });
});

describe("harmonize — prompt content and directives", () => {
  it("prompt contains imperative 'you MUST emit' phrasing", () => {
    const llmTasks: LlmTask[] = [];
    const promptPath = writeHarmonizeManifest({
      outputDir: tmpDir,
      model: "claude-sonnet-4-6",
      clusters: makeTypicalClusters(),
      llmTasks,
    });

    const content = fs.readFileSync(promptPath, "utf-8");
    expect(content).toMatch(/you MUST emit/i);
  });

  it("prompt contains the worked example marker 'near-black-ink'", () => {
    const llmTasks: LlmTask[] = [];
    const promptPath = writeHarmonizeManifest({
      outputDir: tmpDir,
      model: "claude-sonnet-4-6",
      clusters: makeTypicalClusters(),
      llmTasks,
    });

    const content = fs.readFileSync(promptPath, "utf-8");
    expect(content).toContain("near-black-ink");
  });

  it("prompt contains anti-pattern callout about empty array", () => {
    const llmTasks: LlmTask[] = [];
    const promptPath = writeHarmonizeManifest({
      outputDir: tmpDir,
      model: "claude-sonnet-4-6",
      clusters: makeTypicalClusters(),
      llmTasks,
    });

    const content = fs.readFileSync(promptPath, "utf-8");
    expect(content).toMatch(/\[\]\` is only correct when every cluster/i);
  });

  it("prompt contains parameterized expected recommendation count", () => {
    const llmTasks: LlmTask[] = [];
    const clusters = makeTypicalClusters(); // 3 clusters → expect 1-2 recommendations
    const promptPath = writeHarmonizeManifest({
      outputDir: tmpDir,
      model: "claude-sonnet-4-6",
      clusters,
      llmTasks,
    });

    const content = fs.readFileSync(promptPath, "utf-8");
    // Prompt should state the cluster count and expected range
    expect(content).toContain("3 clusters");
  });

  it("prompt still ≤5KB on typical (3 clusters) input after rewrite", () => {
    const llmTasks: LlmTask[] = [];
    const promptPath = writeHarmonizeManifest({
      outputDir: tmpDir,
      model: "claude-sonnet-4-6",
      clusters: makeTypicalClusters(),
      llmTasks,
    });

    const content = fs.readFileSync(promptPath, "utf-8");
    const sizeBytes = Buffer.byteLength(content, "utf-8");
    expect(sizeBytes).toBeLessThanOrEqual(5 * 1024);
  });

  it("handles combined wrapper { colorClusters, numericClusters } without returning empty summaries", () => {
    const llmTasks: LlmTask[] = [];
    const combinedClusters = {
      colorClusters: makeTypicalClusters(),
      numericClusters: {
        version: "1.0.0",
        clusters: [makeCluster("spacing-base", 2)],
      },
    };

    const promptPath = writeHarmonizeManifest({
      outputDir: tmpDir,
      model: "claude-sonnet-4-6",
      clusters: combinedClusters,
      llmTasks,
    });

    const content = fs.readFileSync(promptPath, "utf-8");
    // All 4 clusters (3 color + 1 numeric) should appear inlined
    expect(content).toContain("ink-dark");
    expect(content).toContain("spacing-base");
  });
});

describe("harmonize — output schema validates sample recommendations", () => {
  it("validates a well-formed HarmonizeRecommendation[] against the schema", async () => {
    const schemaPath = path.join(
      new URL(import.meta.url).pathname,
      "..",
      "..",
      "..",
      "schemas",
      "harmonize-recommendations.json",
    );

    const schema = JSON.parse(fs.readFileSync(schemaPath, "utf-8")) as object;

    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    const ajv = new Ajv({ strict: false });
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    const validate = ajv.compile(schema);

    const sampleOutput = [
      {
        clusterID: "ink-dark",
        recommendation:
          "Three near-identical dark values found across the codebase. Consolidate to a single ink primitive.",
        canonicalToken: {
          name: "color.primitive.ink-900",
          group: "primitive",
          description: "Darkest ink; used for primary text and icon fills",
        },
        confidence: "high",
        sourceRefs: ["Sources/Colors.swift:12", "Views/Dashboard.swift:67"],
      },
    ];

    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    const valid = validate(sampleOutput) as boolean;
    expect(valid).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(validate.errors).toBeNull();
  });

  it("rejects a recommendation with missing required fields", async () => {
    const schemaPath = path.join(
      new URL(import.meta.url).pathname,
      "..",
      "..",
      "..",
      "schemas",
      "harmonize-recommendations.json",
    );

    const schema = JSON.parse(fs.readFileSync(schemaPath, "utf-8")) as object;

    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    const ajv = new Ajv({ strict: false });
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    const validate = ajv.compile(schema);

    // Missing `sourceRefs` — required field
    const invalidOutput = [
      {
        clusterID: "ink-dark",
        recommendation: "Consolidate.",
        canonicalToken: {
          name: "color.primitive.ink-900",
          group: "primitive",
          description: "Darkest ink",
        },
        confidence: "high",
        // sourceRefs intentionally omitted
      },
    ];

    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    const valid = validate(invalidOutput) as boolean;
    expect(valid).toBe(false);
  });
});
