/**
 * tests/emitters/preview-html.test.ts
 *
 * Unit tests for emitters/preview-html.ts — verifies the JSON payload is injected
 * into the static shell, malicious script tags in DESIGN.md are escaped, and
 * cluster members are flattened with a CSS color string.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ColorCluster } from "../../analyzers/cluster-color.js";
import { emitPreviewHtml } from "../../emitters/preview-html.js";
import type { RawFinding } from "../../parsers/types.js";

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokextract-preview-test-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const meta = {
  appName: "TestApp",
  vendorNamespace: "com.example.test",
  extractedAt: "2026-05-08T12:00:00Z",
  repoPath: "/tmp/test-app",
};

function readPayload(htmlPath: string): unknown {
  const html = fs.readFileSync(htmlPath, "utf-8");
  const match = html.match(
    /<script id="tokextract-data" type="application\/json">\s*([\s\S]*?)\s*<\/script>/,
  );
  if (!match) throw new Error("data script tag not found in preview.html");
  return JSON.parse(match[1] ?? "");
}

describe("preview-html emitter", () => {
  it("writes preview.html with the injected JSON payload", () => {
    const tokens = {
      color: {
        semantic: {
          accent: {
            $value: { colorSpace: "srgb", components: [0.1, 0.2, 0.3, 1] },
            $type: "color",
            $description: "Accent",
          },
        },
      },
    };
    const outPath = emitPreviewHtml(
      { tokens, designMd: "# TestApp\n\nHello world.", clusters: [], meta },
      { outputDir: tempDir },
    );
    expect(outPath).toBe(path.join(tempDir, "preview.html"));
    expect(fs.existsSync(outPath)).toBe(true);

    const payload = readPayload(outPath) as {
      meta: typeof meta;
      tokens: typeof tokens;
      designMd: string;
      clusters: unknown[];
    };
    expect(payload.meta).toEqual(meta);
    expect(payload.tokens).toEqual(tokens);
    expect(payload.designMd).toContain("# TestApp");
    expect(payload.clusters).toEqual([]);
  });

  it("flattens cluster members with a cssColor and source location", () => {
    const sample: RawFinding = {
      category: "color",
      sourcePath: "/repo/Sources/Theme.swift",
      line: 42,
      col: 8,
      declName: "brandPrimary",
      rawValue: "Color(.sRGB, red: 0.1, green: 0.2, blue: 0.3)",
      normalizedValue: { r: 0.1, g: 0.2, b: 0.3, a: 1, colorSpace: "srgb" },
      context: "",
      isDeclaration: true,
    };
    const cluster: ColorCluster = {
      clusterId: 0,
      members: [sample, { ...sample, declName: "brandSecondary", line: 43 }],
      proposedCanonical: sample,
      deltaEMax: 1.42,
      deltaEThreshold: 2.5,
    };

    const outPath = emitPreviewHtml(
      { tokens: {}, designMd: "", clusters: [cluster], meta },
      { outputDir: tempDir },
    );
    const payload = readPayload(outPath) as {
      clusters: Array<{
        clusterId: number;
        deltaEMax: number;
        proposedCanonical: { cssColor: string; declName: string };
        members: Array<{ cssColor: string; declName: string | null; line: number }>;
      }>;
    };
    expect(payload.clusters).toHaveLength(1);
    const flattened = payload.clusters[0];
    expect(flattened?.deltaEMax).toBe(1.42);
    expect(flattened?.proposedCanonical.cssColor).toBe("rgba(26, 51, 77, 1)");
    expect(flattened?.proposedCanonical.declName).toBe("brandPrimary");
    expect(flattened?.members).toHaveLength(2);
    expect(flattened?.members[1]?.declName).toBe("brandSecondary");
    expect(flattened?.members[1]?.line).toBe(43);
  });

  it("escapes nested </script> sequences in injected JSON", () => {
    const designMd = 'Hostile content </script><script>alert("xss")</script>';
    const outPath = emitPreviewHtml(
      { tokens: {}, designMd, clusters: [], meta },
      { outputDir: tempDir },
    );
    const html = fs.readFileSync(outPath, "utf-8");
    const closingScripts = html.match(/<\/script>/gi) ?? [];
    expect(closingScripts.length).toBe(2);
    expect(html).toContain("<\\/script>");
    const payload = readPayload(outPath) as { designMd: string };
    expect(payload.designMd).toBe(designMd);
  });
});
