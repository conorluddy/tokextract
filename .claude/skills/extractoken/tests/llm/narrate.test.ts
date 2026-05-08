/**
 * tests/llm/narrate.test.ts
 *
 * Unit tests for llm/narrate.ts — the narrate prompt generator.
 *
 * Tests cover: task structure, responsePath location, prompt size, mandatory sections.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeNarrateManifest } from "../../llm/narrate.js";
import type { LlmTask } from "../../parsers/types.js";

// === HELPERS ===

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "extractoken-narrate-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// === TESTS ===

describe("narrate — manifest task structure", () => {
  it("appends a task with id 'narrate' and correct model", () => {
    const llmTasks: LlmTask[] = [];

    writeNarrateManifest({ outputDir: tmpDir, model: "claude-sonnet-4-6", llmTasks });

    expect(llmTasks).toHaveLength(1);
    const task = llmTasks[0];
    expect(task?.id).toBe("narrate");
    expect(task?.pass).toBe("narrate");
    expect(task?.recommendedModel).toBe("claude-sonnet-4-6");
    expect(task?.status).toBe("pending");
  });

  it("sets responsePath to <outputDir>/DESIGN.md — NOT under .extractoken/llm-out/", () => {
    const llmTasks: LlmTask[] = [];

    writeNarrateManifest({ outputDir: tmpDir, model: "claude-sonnet-4-6", llmTasks });

    const task = llmTasks[0];
    expect(task?.responsePath).toBe(path.join(tmpDir, "DESIGN.md"));
    // Must not be buried in the internal .extractoken dir
    expect(task?.responsePath).not.toContain(".extractoken");
  });

  it("sets responseSchema to null (output is markdown, not JSON)", () => {
    const llmTasks: LlmTask[] = [];

    writeNarrateManifest({ outputDir: tmpDir, model: "claude-sonnet-4-6", llmTasks });

    expect(llmTasks[0]?.responseSchema).toBeNull();
  });

  it("marks task as done if DESIGN.md already exists with Overview section", () => {
    // Pre-write a minimal DESIGN.md
    fs.writeFileSync(
      path.join(tmpDir, "DESIGN.md"),
      `---\nname: "Test"\n---\n\n## Overview\n\nSome content.\n`,
      "utf-8",
    );

    const llmTasks: LlmTask[] = [];
    writeNarrateManifest({ outputDir: tmpDir, model: "claude-sonnet-4-6", llmTasks });

    expect(llmTasks[0]?.status).toBe("done");
  });
});

describe("narrate — prompt size", () => {
  it("produces a prompt ≤5KB", () => {
    const llmTasks: LlmTask[] = [];
    const promptPath = writeNarrateManifest({
      outputDir: tmpDir,
      model: "claude-sonnet-4-6",
      llmTasks,
    });

    const content = fs.readFileSync(promptPath, "utf-8");
    const sizeBytes = Buffer.byteLength(content, "utf-8");

    expect(sizeBytes).toBeLessThanOrEqual(5 * 1024);
  });

  it("does NOT inline tokens.json — gives the subagent a path to read", () => {
    const llmTasks: LlmTask[] = [];
    const promptPath = writeNarrateManifest({
      outputDir: tmpDir,
      model: "claude-sonnet-4-6",
      llmTasks,
    });

    const content = fs.readFileSync(promptPath, "utf-8");

    // Path to tokens.json is mentioned (subagent reads it), content is not inlined
    expect(content).toContain("tokens.json");
    // The prompt should NOT contain raw JSON (no curly-brace-heavy content)
    // We verify that no token data was inlined by checking size is well under 5KB
    // (inlining tokens.json could easily be 50KB+)
    expect(Buffer.byteLength(content, "utf-8")).toBeLessThan(5000);
  });
});

describe("narrate — prompt content completeness", () => {
  it("mentions all 8 mandatory section names", () => {
    const llmTasks: LlmTask[] = [];
    const promptPath = writeNarrateManifest({
      outputDir: tmpDir,
      model: "claude-sonnet-4-6",
      llmTasks,
    });

    const content = fs.readFileSync(promptPath, "utf-8");

    const mandatorySections = [
      "Overview",
      "Colors",
      "Typography",
      "Layout",
      "Elevation & Depth",
      "Shapes",
      "Components",
      "Do's and Don'ts",
    ];

    for (const section of mandatorySections) {
      expect(content, `Expected prompt to mention section: ${section}`).toContain(section);
    }
  });

  it("instructs subagent to use the Write tool and reply 'done'", () => {
    const llmTasks: LlmTask[] = [];
    const promptPath = writeNarrateManifest({
      outputDir: tmpDir,
      model: "claude-sonnet-4-6",
      llmTasks,
    });

    const content = fs.readFileSync(promptPath, "utf-8");

    expect(content).toContain("Write tool");
    expect(content.toLowerCase()).toContain("done");
  });

  it("embeds lint rule names in the prompt", () => {
    const llmTasks: LlmTask[] = [];
    const promptPath = writeNarrateManifest({
      outputDir: tmpDir,
      model: "claude-sonnet-4-6",
      llmTasks,
    });

    const content = fs.readFileSync(promptPath, "utf-8");

    // Key lint rules should be mentioned so the subagent knows the acceptance bar
    expect(content).toContain("missing-sections");
    expect(content).toContain("section-order");
    expect(content).toContain("broken-ref");
    expect(content).toContain("contrast-ratio");
  });
});
