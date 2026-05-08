/**
 * tests/emitters/design-md-lint.test.ts
 *
 * Unit tests for emitters/design-md-lint.ts — all 8 lint rules, positive + negative cases.
 */

import { describe, expect, it } from "vitest";
import {
  CANONICAL_SECTION_ORDER,
  formatLintErrors,
  lintDesignMd,
} from "../../emitters/design-md-lint.js";

// === Fixture: minimal valid stub DESIGN.md ===

const VALID_STUB = `---
name: "TestApp Design System"
version: "1.0.0"
extracted: "2026-05-08"
source: "SwiftUI — tree-sitter pass"
generated: "deterministic"
tokens:
  colors:
    brand-primary: "{color.brand-primary}"
    accent: "{color.accent}"
---

## Overview

_[Stub — LLM narration pass not run.]_

TestApp design system extracted by Extractoken.

## Colors

The palette contains 2 extracted color tokens.

Primary brand color: \`{{color.brand-primary}}\`.

- \`color.brand-primary\`: #1A88FF (srgb)
- \`color.accent\`: #FF8800 (srgb)

## Typography

_[Stub — typography extraction is Slice 2 scope.]_

At least one typography token is required.

## Layout

_[Stub — spacing extraction is Slice 2 scope.]_

## Elevation & Depth

_[Stub — shadow extraction is Slice 2 scope.]_

## Shapes

_[Stub — corner radius extraction is Slice 2 scope.]_

## Components

_[Stub — component extraction is Slice 2 scope.]_

## Do's and Don'ts

**Do** use defined color tokens instead of inline hex literals.
**Don't** introduce new hex values without a corresponding token declaration.
`;

const VALID_TOKENS_JSON = {
  color: {
    "brand-primary": {
      $type: "color",
      $value: { colorSpace: "srgb", components: [0.102, 0.533, 1.0, 1.0] },
    },
    accent: {
      $type: "color",
      $value: { colorSpace: "srgb", components: [1.0, 0.533, 0.0, 1.0] },
    },
  },
};

describe("design-md-lint", () => {
  // === Test 1: Positive — valid stub passes all rules ===
  it("passes all lint rules on a well-formed stub DESIGN.md", () => {
    const results = lintDesignMd(VALID_STUB, VALID_TOKENS_JSON, { isStub: true });
    const failures = results.filter((r) => r.failed);
    expect(failures.length).toBe(0);
  });

  // === Test 2: missing-sections rule ===
  it("[missing-sections] fails when a mandatory section is absent", () => {
    const missingTypography = VALID_STUB.replace(
      "## Typography\n\n_[Stub — typography extraction is Slice 2 scope.]_\n\nAt least one typography token is required.",
      "",
    );
    const results = lintDesignMd(missingTypography, VALID_TOKENS_JSON, { isStub: true });
    const missingSections = results.find((r) => r.rule === "missing-sections");
    expect(missingSections?.failed).toBe(true);
    expect(missingSections?.message).toContain("Typography");
  });

  it("[missing-sections] passes when all 8 sections are present", () => {
    const results = lintDesignMd(VALID_STUB, VALID_TOKENS_JSON, { isStub: true });
    const rule = results.find((r) => r.rule === "missing-sections");
    expect(rule?.failed).toBe(false);
  });

  // === Test 3: section-order rule ===
  it("[section-order] fails when sections are in the wrong order", () => {
    // Swap Colors and Typography sections
    const swapped = VALID_STUB.replace("## Colors", "## COLORS_PLACEHOLDER")
      .replace("## Typography", "## Colors")
      .replace("## COLORS_PLACEHOLDER", "## Typography");

    const results = lintDesignMd(swapped, VALID_TOKENS_JSON, { isStub: true });
    const rule = results.find((r) => r.rule === "section-order");
    expect(rule?.failed).toBe(true);
  });

  it("[section-order] passes when sections are in canonical order", () => {
    const results = lintDesignMd(VALID_STUB, VALID_TOKENS_JSON, { isStub: true });
    const rule = results.find((r) => r.rule === "section-order");
    expect(rule?.failed).toBe(false);
  });

  // === Test 4: missing-primary rule ===
  it("[missing-primary] fails when no color token matches the core-keyword list", () => {
    // The rule recognizes: primary | brand | accent | background | foreground |
    // surface | body | text | main. Use names entirely outside that set.
    const noPrimary = VALID_STUB.replace(
      '  colors:\n    brand-primary: "{color.brand-primary}"\n    accent: "{color.accent}"',
      '  colors:\n    moss: "{color.moss}"\n    subtle: "{color.subtle}"',
    );

    const results = lintDesignMd(noPrimary, VALID_TOKENS_JSON, { isStub: true });
    const rule = results.find((r) => r.rule === "missing-primary");
    expect(rule?.failed).toBe(true);
  });

  it("[missing-primary] passes when a brand/primary/accent token is in front-matter", () => {
    const results = lintDesignMd(VALID_STUB, VALID_TOKENS_JSON, { isStub: true });
    const rule = results.find((r) => r.rule === "missing-primary");
    expect(rule?.failed).toBe(false);
  });

  // === Test 5: broken-ref rule ===
  it("[broken-ref] fails when prose contains {{token}} that doesn't resolve", () => {
    const brokenRef = VALID_STUB.replace(
      "Primary brand color: `{{color.brand-primary}}`.",
      "Primary brand color: `{{color.non-existent-token}}`.",
    );

    const results = lintDesignMd(brokenRef, VALID_TOKENS_JSON, { isStub: true });
    const rule = results.find((r) => r.rule === "broken-ref");
    expect(rule?.failed).toBe(true);
    expect(rule?.message).toContain("non-existent-token");
  });

  it("[broken-ref] passes when all {{token}} references resolve", () => {
    const results = lintDesignMd(VALID_STUB, VALID_TOKENS_JSON, { isStub: true });
    const rule = results.find((r) => r.rule === "broken-ref");
    expect(rule?.failed).toBe(false);
  });

  // === Test 6: Stub mode relaxes orphaned-tokens, token-summary, contrast-ratio ===
  it("stub mode skips orphaned-tokens, token-summary, and contrast-ratio checks", () => {
    const results = lintDesignMd(VALID_STUB, VALID_TOKENS_JSON, { isStub: true });

    const orphaned = results.find((r) => r.rule === "orphaned-tokens");
    const summary = results.find((r) => r.rule === "token-summary");
    const contrast = results.find((r) => r.rule === "contrast-ratio");

    expect(orphaned?.failed).toBe(false);
    expect(summary?.failed).toBe(false);
    expect(contrast?.failed).toBe(false);
  });

  // === Test 7: missing-typography stub mode ===
  it("[missing-typography] passes in stub mode even with placeholder Typography section", () => {
    const results = lintDesignMd(VALID_STUB, VALID_TOKENS_JSON, { isStub: true });
    const rule = results.find((r) => r.rule === "missing-typography");
    expect(rule?.failed).toBe(false);
  });

  // === Test 8: CANONICAL_SECTION_ORDER has exactly 8 entries ===
  it("canonical section order contains exactly 8 sections", () => {
    expect(CANONICAL_SECTION_ORDER.length).toBe(8);
    expect(CANONICAL_SECTION_ORDER[0]).toBe("Overview");
    expect(CANONICAL_SECTION_ORDER[7]).toBe("Do's and Don'ts");
  });

  // === Test 9: formatLintErrors ===
  it("formatLintErrors returns empty string when no failures", () => {
    const results = [
      { rule: "missing-sections", failed: false, message: "ok" },
      { rule: "section-order", failed: false, message: "ok" },
    ];
    expect(formatLintErrors(results)).toBe("");
  });

  it("formatLintErrors includes rule names and messages on failure", () => {
    const results = [
      { rule: "missing-sections", failed: true, message: "Missing: Typography" },
      { rule: "section-order", failed: false, message: "ok" },
    ];
    const formatted = formatLintErrors(results);
    expect(formatted).toContain("missing-sections");
    expect(formatted).toContain("Missing: Typography");
  });
});
