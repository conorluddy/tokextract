/**
 * tests/analyzers/diff.test.ts
 *
 * Unit tests for analyzers/diff.ts
 */

import { describe, expect, it } from "vitest";
import { diffTokens, formatDiffMarkdown } from "../../analyzers/diff.js";
import type { TokenDiff } from "../../analyzers/diff.js";

// === FIXTURES ===

const brandToken = {
  $type: "color",
  $value: { colorSpace: "srgb", components: [0.067, 0.537, 1.0, 1.0] },
  $description: "Primary brand color",
};

const successToken = {
  $type: "color",
  $value: { colorSpace: "srgb", components: [0.0, 0.8, 0.2, 1.0] },
  $description: "Success state",
};

const bodyFont = {
  $type: "fontFamily",
  $value: "SF Pro",
  $description: "Body text font",
};

function makeTree(tokens: Record<string, unknown>): unknown {
  return tokens;
}

// === TESTS ===

describe("diffTokens", () => {
  it("returns empty diff for two identical trees", () => {
    const tree = {
      color: {
        semantic: {
          brand: brandToken,
          success: successToken,
        },
      },
    };

    const diff = diffTokens(tree, tree);

    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.changed).toHaveLength(0);
    expect(diff.totalCount).toBe(0);
  });

  it("detects all tokens as added when previous is empty", () => {
    const current = {
      color: {
        semantic: {
          brand: brandToken,
          success: successToken,
        },
      },
      typography: {
        body: bodyFont,
      },
    };

    const diff = diffTokens({}, current);

    expect(diff.added).toHaveLength(3);
    expect(diff.removed).toHaveLength(0);
    expect(diff.changed).toHaveLength(0);
    expect(diff.totalCount).toBe(3);

    const paths = diff.added.map((c) => c.path);
    expect(paths).toContain("color.semantic.brand");
    expect(paths).toContain("color.semantic.success");
    expect(paths).toContain("typography.body");
  });

  it("detects all tokens as removed when current is empty", () => {
    const previous = {
      color: {
        semantic: {
          brand: brandToken,
        },
      },
    };

    const diff = diffTokens(previous, {});

    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(1);
    expect(diff.changed).toHaveLength(0);
    expect(diff.totalCount).toBe(1);
    expect(diff.removed[0]?.path).toBe("color.semantic.brand");
    expect(diff.removed[0]?.kind).toBe("removed");
    // before should carry the prior $value
    expect(diff.removed[0]?.before).toEqual(brandToken.$value);
  });

  it("detects a pure value change on the same path", () => {
    const previous = {
      color: {
        semantic: {
          brand: {
            $type: "color",
            $value: { colorSpace: "srgb", components: [0.067, 0.537, 1.0, 1.0] },
          },
        },
      },
    };

    const current = {
      color: {
        semantic: {
          brand: {
            $type: "color",
            $value: { colorSpace: "srgb", components: [0.07, 0.54, 1.0, 1.0] }, // slightly adjusted
          },
        },
      },
    };

    const diff = diffTokens(previous, current);

    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.changed).toHaveLength(1);
    expect(diff.totalCount).toBe(1);

    const change = diff.changed[0];
    expect(change?.kind).toBe("value-changed");
    expect(change?.path).toBe("color.semantic.brand");
    expect(change?.before).toEqual({ colorSpace: "srgb", components: [0.067, 0.537, 1.0, 1.0] });
    expect(change?.after).toEqual({ colorSpace: "srgb", components: [0.07, 0.54, 1.0, 1.0] });
  });

  it("detects a description-only change without emitting a value-change entry", () => {
    const previous = {
      color: {
        semantic: {
          brand: {
            $type: "color",
            $value: { colorSpace: "srgb", components: [0.067, 0.537, 1.0, 1.0] },
            $description: "Old description",
          },
        },
      },
    };

    const current = {
      color: {
        semantic: {
          brand: {
            $type: "color",
            $value: { colorSpace: "srgb", components: [0.067, 0.537, 1.0, 1.0] },
            $description: "Updated description",
          },
        },
      },
    };

    const diff = diffTokens(previous, current);

    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.changed).toHaveLength(1);

    const change = diff.changed[0];
    expect(change?.kind).toBe("description-changed");
    expect(change?.before).toBe("Old description");
    expect(change?.after).toBe("Updated description");
  });

  it("detects a $type change (e.g. color reclassified as dimension)", () => {
    const previous = {
      spacing: {
        sm: {
          $type: "color", // wrong type in previous extraction
          $value: 8,
        },
      },
    };

    const current = {
      spacing: {
        sm: {
          $type: "dimension", // corrected
          $value: 8,
        },
      },
    };

    const diff = diffTokens(previous, current);

    expect(diff.changed).toHaveLength(1);
    const change = diff.changed[0];
    expect(change?.kind).toBe("type-changed");
    expect(change?.before).toBe("color");
    expect(change?.after).toBe("dimension");
  });

  it("handles deeply nested paths (3+ levels)", () => {
    const previous = {
      color: {
        semantic: {
          surface: {
            elevated: {
              $type: "color",
              $value: { colorSpace: "srgb", components: [0.1, 0.1, 0.1, 1.0] },
            },
          },
        },
      },
    };

    const current = {
      color: {
        semantic: {
          surface: {
            elevated: {
              $type: "color",
              $value: { colorSpace: "srgb", components: [0.12, 0.12, 0.12, 1.0] },
            },
          },
        },
      },
    };

    const diff = diffTokens(previous, current);

    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0]?.path).toBe("color.semantic.surface.elevated");
    expect(diff.changed[0]?.kind).toBe("value-changed");
  });

  it("emits multiple changed entries per path when both value and description differ", () => {
    const previous = {
      color: {
        brand: {
          $type: "color",
          $value: "#FF0000",
          $description: "Red",
        },
      },
    };

    const current = {
      color: {
        brand: {
          $type: "color",
          $value: "#EE0000",
          $description: "Slightly darker red",
        },
      },
    };

    const diff = diffTokens(previous, current);

    expect(diff.changed).toHaveLength(2);
    const kinds = diff.changed.map((c) => c.kind).sort();
    expect(kinds).toContain("value-changed");
    expect(kinds).toContain("description-changed");
  });

  it("output is deterministic — running twice on same input produces identical results", () => {
    const previous = {
      color: {
        semantic: {
          brand: brandToken,
          success: successToken,
        },
      },
    };
    const current = {
      color: {
        semantic: {
          brand: {
            ...brandToken,
            $value: { colorSpace: "srgb", components: [0.07, 0.54, 1.0, 1.0] },
          },
          warning: {
            $type: "color",
            $value: { colorSpace: "srgb", components: [1.0, 0.6, 0.0, 1.0] },
          },
        },
      },
    };

    const firstRun = diffTokens(previous, current);
    const secondRun = diffTokens(previous, current);

    expect(JSON.stringify(firstRun)).toBe(JSON.stringify(secondRun));
  });

  it("output is sorted by path (stable ordering across all change kinds)", () => {
    const previous = {
      color: {
        semantic: {
          brand: brandToken,
          deprecated: {
            $type: "color",
            $value: "#333333",
          },
        },
      },
      typography: {
        body: bodyFont,
      },
    };

    const current = {
      color: {
        semantic: {
          brand: {
            ...brandToken,
            $value: { colorSpace: "srgb", components: [0.07, 0.54, 1.0, 1.0] },
          },
          success: successToken, // added
          // deprecated removed
        },
      },
      typography: {
        body: bodyFont, // unchanged
      },
    };

    const diff = diffTokens(previous, current);

    // Added paths should be sorted
    for (let i = 1; i < diff.added.length; i++) {
      expect((diff.added[i - 1]?.path ?? "") <= (diff.added[i]?.path ?? "")).toBe(true);
    }
    // Removed paths should be sorted
    for (let i = 1; i < diff.removed.length; i++) {
      expect((diff.removed[i - 1]?.path ?? "") <= (diff.removed[i]?.path ?? "")).toBe(true);
    }
    // Changed paths should be sorted
    for (let i = 1; i < diff.changed.length; i++) {
      expect((diff.changed[i - 1]?.path ?? "") <= (diff.changed[i]?.path ?? "")).toBe(true);
    }

    expect(diff.removed[0]?.path).toBe("color.semantic.deprecated");
    expect(diff.added[0]?.path).toBe("color.semantic.success");
  });

  it("added change carries the new $value in the after field", () => {
    const diff = diffTokens({}, { spacing: { sm: { $type: "dimension", $value: 8 } } });

    expect(diff.added).toHaveLength(1);
    expect(diff.added[0]?.kind).toBe("added");
    expect(diff.added[0]?.after).toBe(8);
    expect(diff.added[0]?.before).toBeUndefined();
  });

  it("skips group-level $-keys and does not treat them as token paths", () => {
    // A DTCG group-level $description should not be treated as a token leaf
    const tree = {
      color: {
        $description: "Color group",
        semantic: {
          brand: brandToken,
        },
      },
    };

    const diff = diffTokens(tree, tree);

    expect(diff.totalCount).toBe(0);
    // Should only find one leaf — the actual token
    const added = diffTokens({}, tree);
    expect(added.added).toHaveLength(1);
    expect(added.added[0]?.path).toBe("color.semantic.brand");
  });
});

describe("formatDiffMarkdown", () => {
  it("returns a no-change message when diff is empty", () => {
    const emptyDiff: TokenDiff = { added: [], removed: [], changed: [], totalCount: 0 };
    const output = formatDiffMarkdown(emptyDiff);

    expect(output).toContain("## Changes since last extraction");
    expect(output).toContain("No changes detected");
  });

  it("includes summary line with counts", () => {
    const diff = diffTokens(
      {},
      {
        color: { semantic: { brand: brandToken, success: successToken } },
      },
    );

    const output = formatDiffMarkdown(diff);

    expect(output).toContain("**2 tokens added**");
    expect(output).toContain("**0 removed**");
    expect(output).toContain("**0 changed**");
  });

  it("lists added, removed, and changed tokens in the output", () => {
    const previous = {
      color: {
        semantic: {
          brand: brandToken,
          deprecated: { $type: "color", $value: "#333" },
        },
      },
    };
    const current = {
      color: {
        semantic: {
          brand: {
            ...brandToken,
            $value: { colorSpace: "srgb", components: [0.07, 0.54, 1.0, 1.0] },
          },
          success: successToken,
        },
      },
    };

    const diff = diffTokens(previous, current);
    const output = formatDiffMarkdown(diff);

    expect(output).toContain("### Added");
    expect(output).toContain("`color.semantic.success`");
    expect(output).toContain("### Removed");
    expect(output).toContain("`color.semantic.deprecated`");
    expect(output).toContain("### Changed");
    expect(output).toContain("`color.semantic.brand`");
  });

  it("uses singular 'token' when only 1 added", () => {
    const diff = diffTokens({}, { color: { brand: brandToken } });
    const output = formatDiffMarkdown(diff);

    expect(output).toContain("**1 token added**");
  });
});
