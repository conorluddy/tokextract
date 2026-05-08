/**
 * tests/parsers/spacing.test.ts
 *
 * Unit tests for parsers/spacing.ts — Slice 2 spacing extraction.
 * Covers all 8 detection patterns plus edge cases.
 */

import { describe, expect, it } from "vitest";
import { extractSpacing } from "../../parsers/spacing.js";

const FIXTURE_PATH = "Sources/UI/Components/CardView.swift";

describe("spacing parser", () => {
  // === Test 1: Simple padding literal ===
  it("extracts .padding(N) single literal", () => {
    const source = `
struct CardView: View {
    var body: some View {
        VStack {
            Text("Hello")
        }
        .padding(16)
    }
}
`;
    const findings = extractSpacing(source, FIXTURE_PATH);
    const padding = findings.find((f) => f.context === "padding(N)" && f.normalizedValue === 16);

    expect(padding).toBeDefined();
    expect(padding?.category).toBe("spacing");
    expect(padding?.isDeclaration).toBe(false);
    expect(padding?.normalizedValue).toBe(16);
    expect(padding?.declName).toBeNull();
    expect(padding?.rawValue).toBe(".padding(16)");
  });

  // === Test 2: Labeled edge padding ===
  it("extracts .padding(.horizontal, N) and .padding(.vertical, N)", () => {
    const source = `
struct MyView: View {
    var body: some View {
        Text("Label")
            .padding(.horizontal, 24)
            .padding(.vertical, 12)
            .padding(.top, 8)
    }
}
`;
    const findings = extractSpacing(source, FIXTURE_PATH);

    const horizontal = findings.find((f) => f.context === "padding(.horizontal, N)");
    expect(horizontal).toBeDefined();
    expect(horizontal?.normalizedValue).toBe(24);

    const vertical = findings.find((f) => f.context === "padding(.vertical, N)");
    expect(vertical).toBeDefined();
    expect(vertical?.normalizedValue).toBe(12);

    const top = findings.find((f) => f.context === "padding(.top, N)");
    expect(top).toBeDefined();
    expect(top?.normalizedValue).toBe(8);
  });

  // === Test 3: EdgeInsets literal ===
  it("extracts EdgeInsets literal as four separate findings", () => {
    const source = `
struct Row: View {
    var body: some View {
        Text("Item")
            .padding(EdgeInsets(top: 8, leading: 12, bottom: 8, trailing: 12))
    }
}
`;
    const findings = extractSpacing(source, FIXTURE_PATH);
    const edgeFindings = findings.filter((f) => f.context.startsWith("EdgeInsets"));

    expect(edgeFindings).toHaveLength(4);

    const topFinding = edgeFindings.find((f) => f.context === "EdgeInsets top");
    const leadingFinding = edgeFindings.find((f) => f.context === "EdgeInsets leading");
    const bottomFinding = edgeFindings.find((f) => f.context === "EdgeInsets bottom");
    const trailingFinding = edgeFindings.find((f) => f.context === "EdgeInsets trailing");

    expect(topFinding?.normalizedValue).toBe(8);
    expect(leadingFinding?.normalizedValue).toBe(12);
    expect(bottomFinding?.normalizedValue).toBe(8);
    expect(trailingFinding?.normalizedValue).toBe(12);
  });

  // === Test 4: Stack spacing ===
  it("extracts VStack(spacing:) and HStack(spacing:) numeric literals", () => {
    const source = `
struct Layout: View {
    var body: some View {
        VStack(spacing: 12) {
            HStack(spacing: 8) {
                Text("A")
                Text("B")
            }
        }
    }
}
`;
    const findings = extractSpacing(source, FIXTURE_PATH);

    const vstack = findings.find((f) => f.context === "VStack(spacing:)");
    expect(vstack).toBeDefined();
    expect(vstack?.normalizedValue).toBe(12);
    expect(vstack?.isDeclaration).toBe(false);

    const hstack = findings.find((f) => f.context === "HStack(spacing:)");
    expect(hstack).toBeDefined();
    expect(hstack?.normalizedValue).toBe(8);
  });

  // === Test 5: frame dimension extraction ===
  it("extracts .frame(minHeight:) and .frame(width:height:) literals", () => {
    const source = `
struct Divider: View {
    var body: some View {
        Spacer()
            .frame(minHeight: 32)
        Rectangle()
            .frame(width: 48, height: 2)
    }
}
`;
    const findings = extractSpacing(source, FIXTURE_PATH);

    const minHeight = findings.find(
      (f) => f.context === "frame(minHeight:)" && f.normalizedValue === 32,
    );
    expect(minHeight).toBeDefined();
    expect(minHeight?.isDeclaration).toBe(false);

    const width = findings.find((f) => f.context === "frame(width:)" && f.normalizedValue === 48);
    expect(width).toBeDefined();

    const height = findings.find((f) => f.context === "frame(height:)" && f.normalizedValue === 2);
    expect(height).toBeDefined();
  });

  // === Test 6: enum Spacing declarations ===
  it("extracts enum Spacing static let declarations with isDeclaration=true", () => {
    const source = `
enum Spacing {
    static let xs: CGFloat = 4
    static let sm: CGFloat = 8
    static let md: CGFloat = 16
    static let lg: CGFloat = 24
    static let xl: CGFloat = 32
}
`;
    const findings = extractSpacing(source, FIXTURE_PATH);
    const declarations = findings.filter((f) => f.isDeclaration);

    expect(declarations.length).toBeGreaterThanOrEqual(5);

    const xs = declarations.find((f) => f.declName === "xs");
    expect(xs).toBeDefined();
    expect(xs?.normalizedValue).toBe(4);
    expect(xs?.context).toBe("enum Spacing static let");
    expect(xs?.category).toBe("spacing");

    const md = declarations.find((f) => f.declName === "md");
    expect(md).toBeDefined();
    expect(md?.normalizedValue).toBe(16);

    const xl = declarations.find((f) => f.declName === "xl");
    expect(xl).toBeDefined();
    expect(xl?.normalizedValue).toBe(32);
  });

  // === Test 7: Named reference shorthands ===
  it("extracts .padding(Spacing.md) and .padding(.md) as named refs with null normalizedValue", () => {
    const source = `
struct TokenizedView: View {
    var body: some View {
        VStack {
            Text("Hello")
                .padding(Spacing.md)
            Text("World")
                .padding(.sm)
        }
    }
}
`;
    const findings = extractSpacing(source, FIXTURE_PATH);

    const qualifiedRef = findings.find((f) => f.context === "padding(NamedRef)");
    expect(qualifiedRef).toBeDefined();
    expect(qualifiedRef?.normalizedValue).toBeNull();
    expect(qualifiedRef?.rawValue).toBe(".padding(Spacing.md)");

    const implicitRef = findings.find((f) => f.context === "padding(.namedRef)");
    expect(implicitRef).toBeDefined();
    expect(implicitRef?.normalizedValue).toBeNull();
    expect(implicitRef?.rawValue).toBe(".padding(.sm)");
  });

  // === Test 8: Conditional spacing — both branches captured ===
  it("extracts both branches of .padding(condition ? N : N) with conditional context", () => {
    const source = `
struct AdaptiveView: View {
    var isCompact: Bool = false
    var body: some View {
        Text("Adaptive")
            .padding(isCompact ? 8 : 16)
    }
}
`;
    const findings = extractSpacing(source, FIXTURE_PATH);
    const conditional = findings.filter((f) => f.context === "conditional spacing");

    expect(conditional).toHaveLength(2);
    const values = conditional.map((f) => f.normalizedValue as number).sort((a, b) => a - b);
    expect(values).toEqual([8, 16]);
    expect(conditional.every((f) => !f.isDeclaration)).toBe(true);
  });

  // === Test 9: Conditional stack spacing ===
  it("extracts both branches of VStack(spacing: condition ? N : N)", () => {
    const source = `
struct ResponsiveStack: View {
    var isCompact: Bool = false
    var body: some View {
        VStack(spacing: isCompact ? 4 : 12) {
            Text("A")
            Text("B")
        }
    }
}
`;
    const findings = extractSpacing(source, FIXTURE_PATH);
    const conditional = findings.filter((f) => f.context === "conditional spacing");

    expect(conditional).toHaveLength(2);
    const values = conditional.map((f) => f.normalizedValue as number).sort((a, b) => a - b);
    expect(values).toEqual([4, 12]);
  });

  // === Test 10: Negative — does not extract edge-label-only .padding(.horizontal) ===
  it("does NOT emit a named-ref finding for .padding(.horizontal) edge-only shorthand", () => {
    const source = `
struct EdgeOnly: View {
    var body: some View {
        Text("Label").padding(.horizontal)
    }
}
`;
    const findings = extractSpacing(source, FIXTURE_PATH);

    // .padding(.horizontal) with no value should not create any spacing finding
    // (it uses the system default — no numeric literal to capture)
    const namedRefs = findings.filter((f) => f.context === "padding(.namedRef)");
    const horizontalRef = namedRefs.find((f) => f.rawValue?.includes("horizontal"));
    expect(horizontalRef).toBeUndefined();
  });

  // === Test 11: Multiple patterns in one file ===
  it("extracts multiple pattern types from a realistic SwiftUI view", () => {
    const source = `
enum Spacing {
    static let sm: CGFloat = 8
    static let md: CGFloat = 16
}

struct ProfileCard: View {
    var body: some View {
        VStack(spacing: 12) {
            HStack(spacing: 8) {
                Image("avatar").frame(width: 40, height: 40)
                Text("Name").padding(.horizontal, 16)
            }
            .padding(EdgeInsets(top: 8, leading: 12, bottom: 8, trailing: 12))
        }
        .padding(Spacing.md)
    }
}
`;
    const findings = extractSpacing(source, FIXTURE_PATH);

    // Declarations
    const declarations = findings.filter((f) => f.isDeclaration);
    expect(declarations.length).toBeGreaterThanOrEqual(2);
    expect(declarations.map((d) => d.declName)).toContain("sm");
    expect(declarations.map((d) => d.declName)).toContain("md");

    // Stack spacings
    const vstack = findings.find((f) => f.context === "VStack(spacing:)");
    expect(vstack?.normalizedValue).toBe(12);

    // EdgeInsets
    const edgeFindings = findings.filter((f) => f.context.startsWith("EdgeInsets"));
    expect(edgeFindings).toHaveLength(4);

    // Named ref
    const namedRef = findings.find((f) => f.context === "padding(NamedRef)");
    expect(namedRef).toBeDefined();
    expect(namedRef?.normalizedValue).toBeNull();
  });

  // === Test 12: Negative — does not extract non-spacing content ===
  it("does not extract color or font declarations as spacing", () => {
    const source = `
extension Color {
    static let brand = Color(hex: "#1A88FF")
}

extension Font {
    static let body = Font.custom("Inter", size: 16)
}

struct Unrelated: View {
    var body: some View {
        Text("Hello").foregroundColor(.brand)
    }
}
`;
    const findings = extractSpacing(source, FIXTURE_PATH);

    // No declarations (enum Spacing not present)
    const declarations = findings.filter((f) => f.isDeclaration);
    expect(declarations).toHaveLength(0);

    // No spacing findings at all — nothing matches
    expect(findings).toHaveLength(0);
  });

  // === Test 13: Accurate line numbers ===
  it("reports accurate 1-based line numbers", () => {
    const source = `import SwiftUI

struct LineTest: View {
    var body: some View {
        Text("Hello")
            .padding(24)
    }
}
`;
    const findings = extractSpacing(source, FIXTURE_PATH);
    const padding = findings.find((f) => f.normalizedValue === 24);

    expect(padding).toBeDefined();
    expect(padding?.line).toBe(6);
  });
});
