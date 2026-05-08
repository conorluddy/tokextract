/**
 * tests/parsers/shadow.test.ts
 *
 * Unit tests for parsers/shadow.ts — the shadow / elevation extractor.
 *
 * Covers all five patterns specified in PRD §6.5:
 *   1. Full form:    .shadow(color: .black.opacity(0.12), radius: 8, x: 0, y: 4)
 *   2. Minimal form: .shadow(radius: 4)
 *   3. No-opacity:   .shadow(color: .black, radius: 6, x: 0, y: 2)
 *   4. Wrapper decl: extension View { func cardShadow() -> ... { shadow(...) } }
 *   5. Chained:      .shadow(...).shadow(...) — one finding per call
 */

import { describe, expect, it } from "vitest";
import { extractShadow } from "../../parsers/shadow.js";
import type { NormalizedShadow } from "../../parsers/shadow.js";

const FIXTURE_PATH = "Sources/UI/Components/CardView.swift";

describe("shadow parser", () => {
  // === Test 1: Full form with color + opacity ===
  it("extracts full .shadow(color:radius:x:y:) with .opacity() on color", () => {
    const source = `
struct CardView: View {
    var body: some View {
        RoundedRectangle(cornerRadius: 12)
            .shadow(color: .black.opacity(0.12), radius: 8, x: 0, y: 4)
    }
}
`;
    const findings = extractShadow(source, FIXTURE_PATH);

    expect(findings).toHaveLength(1);
    const finding = findings[0];
    expect(finding).toBeDefined();
    expect(finding?.category).toBe("shadow");
    expect(finding?.isDeclaration).toBe(false);
    expect(finding?.context).toBe(".shadow() call");
    expect(finding?.declName).toBeNull();
    expect(finding?.rawValue).toBe(".shadow(color: .black.opacity(0.12), radius: 8, x: 0, y: 4)");

    const shadow = finding?.normalizedValue as NormalizedShadow | null;
    expect(shadow).not.toBeNull();
    expect(shadow?.color).toBe(".black");
    expect(shadow?.radius).toBe(8);
    expect(shadow?.x).toBe(0);
    expect(shadow?.y).toBe(4);
    expect(shadow?.opacity).toBeCloseTo(0.12);
  });

  // === Test 2: Minimal form — radius only ===
  it("extracts minimal .shadow(radius:) with default color/x/y", () => {
    const source = `
struct FocusRing: View {
    var body: some View {
        Circle().shadow(radius: 4)
    }
}
`;
    const findings = extractShadow(source, FIXTURE_PATH);

    expect(findings).toHaveLength(1);
    const shadow = findings[0]?.normalizedValue as NormalizedShadow | null;
    expect(shadow).not.toBeNull();
    expect(shadow?.radius).toBe(4);
    expect(shadow?.x).toBe(0);
    expect(shadow?.y).toBe(0);
    // Default color when omitted
    expect(shadow?.color).toBe(".black");
    expect(shadow?.opacity).toBeNull();
  });

  // === Test 3: Color without .opacity() chain ===
  it("extracts .shadow(color:radius:x:y:) without .opacity() — opacity should be null", () => {
    const source = `
struct TooltipView: View {
    var body: some View {
        Text("Tip")
            .shadow(color: .black, radius: 6, x: 0, y: 2)
    }
}
`;
    const findings = extractShadow(source, FIXTURE_PATH);

    expect(findings).toHaveLength(1);
    const shadow = findings[0]?.normalizedValue as NormalizedShadow | null;
    expect(shadow?.color).toBe(".black");
    expect(shadow?.radius).toBe(6);
    expect(shadow?.x).toBe(0);
    expect(shadow?.y).toBe(2);
    expect(shadow?.opacity).toBeNull();
  });

  // === Test 4: extension View wrapper declaration ===
  it("extracts extension View func wrapper as isDeclaration:true with declName", () => {
    const source = `
extension View {
    func cardShadow() -> some View {
        shadow(color: .black.opacity(0.08), radius: 4, x: 0, y: 2)
    }
}
`;
    const findings = extractShadow(source, FIXTURE_PATH);

    // Should have exactly one finding — the wrapper declaration
    // (no call-site match because bare `shadow(` has no leading dot)
    const declarations = findings.filter((f) => f.isDeclaration);
    expect(declarations).toHaveLength(1);

    const decl = declarations[0];
    expect(decl?.category).toBe("shadow");
    expect(decl?.isDeclaration).toBe(true);
    expect(decl?.declName).toBe("cardShadow");
    expect(decl?.context).toBe("extension View func wrapper");

    const shadow = decl?.normalizedValue as NormalizedShadow | null;
    expect(shadow).not.toBeNull();
    expect(shadow?.color).toBe(".black");
    expect(shadow?.radius).toBe(4);
    expect(shadow?.x).toBe(0);
    expect(shadow?.y).toBe(2);
    expect(shadow?.opacity).toBeCloseTo(0.08);
  });

  // === Test 5: Chained .shadow().shadow() — one finding per call ===
  it("emits one finding per call in a chained .shadow().shadow()", () => {
    const source = `
struct LayeredCard: View {
    var body: some View {
        RoundedRectangle(cornerRadius: 16)
            .shadow(color: .black.opacity(0.06), radius: 2, x: 0, y: 1)
            .shadow(color: .black.opacity(0.15), radius: 12, x: 0, y: 6)
    }
}
`;
    const findings = extractShadow(source, FIXTURE_PATH);

    expect(findings).toHaveLength(2);
    const shadowValues = findings.map((f) => f.normalizedValue as NormalizedShadow | null);

    const first = shadowValues[0];
    expect(first?.radius).toBe(2);
    expect(first?.y).toBe(1);
    expect(first?.opacity).toBeCloseTo(0.06);

    const second = shadowValues[1];
    expect(second?.radius).toBe(12);
    expect(second?.y).toBe(6);
    expect(second?.opacity).toBeCloseTo(0.15);
  });

  // === Test 6: Color.black (qualified) color expression ===
  it("handles Color.black qualified color expression without opacity", () => {
    const source = `
Image("hero")
    .shadow(color: Color.black, radius: 8, x: 0, y: 4)
`;
    const findings = extractShadow(source, FIXTURE_PATH);

    expect(findings).toHaveLength(1);
    const shadow = findings[0]?.normalizedValue as NormalizedShadow | null;
    expect(shadow?.color).toBe("Color.black");
    expect(shadow?.opacity).toBeNull();
  });

  // === Test 7: Color with opacity and qualified prefix ===
  it("strips .opacity() from a qualified Color.black.opacity() expression", () => {
    const source = `
VStack {
    content.shadow(color: Color.black.opacity(0.2), radius: 10, x: 0, y: 5)
}
`;
    const findings = extractShadow(source, FIXTURE_PATH);

    expect(findings).toHaveLength(1);
    const shadow = findings[0]?.normalizedValue as NormalizedShadow | null;
    expect(shadow?.color).toBe("Color.black");
    expect(shadow?.opacity).toBeCloseTo(0.2);
    expect(shadow?.radius).toBe(10);
  });

  // === Test 8: Negative x offset ===
  it("extracts negative x/y offsets correctly", () => {
    const source = `
Button("Submit") {}.shadow(color: .black.opacity(0.1), radius: 4, x: -2, y: -2)
`;
    const findings = extractShadow(source, FIXTURE_PATH);

    expect(findings).toHaveLength(1);
    const shadow = findings[0]?.normalizedValue as NormalizedShadow | null;
    expect(shadow?.x).toBe(-2);
    expect(shadow?.y).toBe(-2);
  });

  // === Test 9: No shadow calls — returns empty array ===
  it("returns empty array when no shadow calls are present", () => {
    const source = `
struct EmptyView: View {
    var body: some View {
        Text("Hello")
            .foregroundStyle(.primary)
            .padding(16)
    }
}
`;
    const findings = extractShadow(source, FIXTURE_PATH);
    expect(findings).toHaveLength(0);
  });

  // === Test 10: Multiple extension View wrapper functions ===
  it("extracts multiple named shadow wrappers from a single extension View block", () => {
    const source = `
extension View {
    func cardShadow() -> some View {
        shadow(color: .black.opacity(0.08), radius: 4, x: 0, y: 2)
    }

    func modalShadow() -> some View {
        shadow(color: .black.opacity(0.2), radius: 16, x: 0, y: 8)
    }
}
`;
    const findings = extractShadow(source, FIXTURE_PATH);
    const declarations = findings.filter((f) => f.isDeclaration);

    expect(declarations.length).toBeGreaterThanOrEqual(2);
    const names = declarations.map((f) => f.declName);
    expect(names).toContain("cardShadow");
    expect(names).toContain("modalShadow");

    const modal = declarations.find((f) => f.declName === "modalShadow");
    const shadow = modal?.normalizedValue as NormalizedShadow | null;
    expect(shadow?.radius).toBe(16);
    expect(shadow?.y).toBe(8);
  });

  // === Test 11: sourcePath is stored correctly ===
  it("stores the provided filePath in sourcePath", () => {
    const source = `Text("x").shadow(radius: 2)`;
    const findings = extractShadow(source, FIXTURE_PATH);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.sourcePath).toBe(FIXTURE_PATH);
  });

  // === Test 12: Call-site with semantic color reference ===
  it("captures semantic token color reference as raw text in color field", () => {
    const source = `
Card()
    .shadow(color: .cardShadow.opacity(0.15), radius: 6, x: 0, y: 3)
`;
    const findings = extractShadow(source, FIXTURE_PATH);

    expect(findings).toHaveLength(1);
    const shadow = findings[0]?.normalizedValue as NormalizedShadow | null;
    // Semantic reference preserved verbatim — resolution is downstream
    expect(shadow?.color).toBe(".cardShadow");
    expect(shadow?.opacity).toBeCloseTo(0.15);
  });
});
