/**
 * tests/parsers/typography.test.ts
 *
 * Unit tests for parsers/typography.ts — Slice 2 typography extraction.
 * Covers all 7 source patterns from PRD §6.2 and inference rules from §6.10.
 */

import { describe, expect, it } from "vitest";
import { extractTypography, inferFontWeight } from "../../parsers/typography.js";

const FIXTURE_PATH = "Sources/UI/Tokens/Font+App.swift";

describe("typography parser", () => {
  // === Pass 1: extension Font static let declarations ===

  it("extracts Font.custom with relativeTo — hasDynamicType true", () => {
    const source = `
extension Font {
    static let bodyMd = Font.custom("JetBrainsMono-Regular", size: 16, relativeTo: .body)
}
`;
    const findings = extractTypography(source, FIXTURE_PATH);
    const decl = findings.find((f) => f.declName === "bodyMd");

    expect(decl).toBeDefined();
    expect(decl?.isDeclaration).toBe(true);
    expect(decl?.category).toBe("typography");
    expect(decl?.context).toBe("extension Font static let");
    expect(decl?.hasDynamicType).toBe(true);

    const normalized = decl?.normalizedValue as {
      fontFamily: string;
      fontSize: number;
      fontWeight: number;
      lineHeight: number;
      letterSpacing: string;
      textStyle: string;
    } | null;

    expect(normalized).not.toBeNull();
    expect(normalized?.fontFamily).toBe("JetBrainsMono-Regular");
    expect(normalized?.fontSize).toBe(16);
    expect(normalized?.fontWeight).toBe(400); // -Regular → 400
    expect(normalized?.lineHeight).toBe(1.5);
    expect(normalized?.letterSpacing).toBe("0px");
    expect(normalized?.textStyle).toBe("body");
  });

  it("extracts Font.custom without relativeTo — hasDynamicType false", () => {
    const source = `
extension Font {
    static let labelSm = Font.custom("JetBrainsMono-Bold", size: 11)
}
`;
    const findings = extractTypography(source, FIXTURE_PATH);
    const decl = findings.find((f) => f.declName === "labelSm");

    expect(decl).toBeDefined();
    expect(decl?.hasDynamicType).toBe(false);
    expect(decl?.isDeclaration).toBe(true);

    const normalized = decl?.normalizedValue as {
      fontFamily: string;
      fontSize: number;
      fontWeight: number;
      textStyle?: string;
    } | null;

    expect(normalized?.fontFamily).toBe("JetBrainsMono-Bold");
    expect(normalized?.fontSize).toBe(11);
    expect(normalized?.fontWeight).toBe(700); // -Bold → 700
    expect(normalized?.textStyle).toBeUndefined();
  });

  it("extracts multiple declarations from a single extension Font block", () => {
    const source = `
extension Font {
    static let bodyMd  = Font.custom("JetBrainsMono-Regular", size: 16, relativeTo: .body)
    static let labelSm = Font.custom("JetBrainsMono-Regular", size: 11, relativeTo: .caption)
    static let heading = Font.custom("JetBrainsMono-SemiBold", size: 24, relativeTo: .title)
}
`;
    const findings = extractTypography(source, FIXTURE_PATH);
    const declarations = findings.filter(
      (f) => f.isDeclaration && f.context === "extension Font static let",
    );

    expect(declarations.length).toBeGreaterThanOrEqual(3);

    const names = declarations.map((d) => d.declName);
    expect(names).toContain("bodyMd");
    expect(names).toContain("labelSm");
    expect(names).toContain("heading");

    const heading = declarations.find((d) => d.declName === "heading");
    const headingNorm = heading?.normalizedValue as {
      fontWeight: number;
      textStyle: string;
    } | null;
    expect(headingNorm?.fontWeight).toBe(600); // -SemiBold → 600
    expect(headingNorm?.textStyle).toBe("title");
  });

  // === Pass 2: extension Text style modifiers ===

  it("extracts extension Text text-style modifier functions", () => {
    const source = `
extension Text {
    func textStyleUi11Regular() -> some View {
        self.font(Font.custom("PoppinsRegular", size: 11))
    }
}
`;
    const findings = extractTypography(source, FIXTURE_PATH);
    const decl = findings.find((f) => f.declName === "textStyleUi11Regular");

    expect(decl).toBeDefined();
    expect(decl?.isDeclaration).toBe(true);
    expect(decl?.context).toBe("extension Text style modifier");

    const normalized = decl?.normalizedValue as { fontFamily: string; fontSize: number } | null;
    expect(normalized?.fontFamily).toBe("PoppinsRegular");
    expect(normalized?.fontSize).toBe(11);
  });

  // === Pass 3: custom font enums ===

  it("extracts font enum case → PostScript name mappings", () => {
    const source = `
enum JetBrainsMono: String {
    case regular = "JetBrainsMono-Regular"
    case bold    = "JetBrainsMono-Bold"
    var font: Font { Font.custom(rawValue, size: 16) }
}
`;
    const findings = extractTypography(source, FIXTURE_PATH);
    const regularCase = findings.find((f) => f.declName === "JetBrainsMono.regular");
    const boldCase = findings.find((f) => f.declName === "JetBrainsMono.bold");

    expect(regularCase).toBeDefined();
    expect(regularCase?.isDeclaration).toBe(true);
    expect(regularCase?.context).toBe("font enum JetBrainsMono");

    const regularNorm = regularCase?.normalizedValue as {
      fontFamily: string;
      fontWeight: number;
    } | null;
    expect(regularNorm?.fontFamily).toBe("JetBrainsMono-Regular");
    expect(regularNorm?.fontWeight).toBe(400);

    expect(boldCase).toBeDefined();
    const boldNorm = boldCase?.normalizedValue as { fontWeight: number } | null;
    expect(boldNorm?.fontWeight).toBe(700);
  });

  // === Pass 4: Font.system call sites ===

  it("extracts Font.system(size:weight:design:) call sites", () => {
    const source = `
struct MyView: View {
    var body: some View {
        Text("Hello").font(Font.system(size: 16, weight: .medium, design: .rounded))
    }
}
`;
    const findings = extractTypography(source, FIXTURE_PATH);
    const systemFont = findings.find((f) => f.context === "Font.system call site");

    expect(systemFont).toBeDefined();
    expect(systemFont?.isDeclaration).toBe(false);
    expect(systemFont?.declName).toBeNull();

    const normalized = systemFont?.normalizedValue as {
      fontFamily: string;
      fontSize: number;
      fontWeight: number;
    } | null;

    expect(normalized?.fontFamily).toBe("system-rounded");
    expect(normalized?.fontSize).toBe(16);
    expect(normalized?.fontWeight).toBe(500); // .medium → 500
  });

  // === Pass 5: implicit .font(.identifier) call sites ===

  it("extracts .font(.identifier) shorthand call sites", () => {
    const source = `
struct MyView: View {
    var body: some View {
        Text("Hello").font(.bodyMd)
        Text("Label").font(.labelSm)
    }
}
`;
    const findings = extractTypography(source, FIXTURE_PATH);
    const callSites = findings.filter((f) => !f.isDeclaration);

    expect(callSites.length).toBeGreaterThanOrEqual(2);

    const bodyMdRef = findings.find((f) => f.context?.includes("bodyMd"));
    expect(bodyMdRef).toBeDefined();
    expect(bodyMdRef?.isDeclaration).toBe(false);
    expect(bodyMdRef?.normalizedValue).toBeNull(); // resolved by joining with declaration findings
  });

  it("does NOT extract .font(.headline) — system text style, not a custom token", () => {
    const source = `
struct MyView: View {
    var body: some View {
        Text("Title").font(.headline)
        Text("Body").font(.body)
        Text("Caption").font(.caption)
    }
}
`;
    const findings = extractTypography(source, FIXTURE_PATH);
    const systemRefs = findings.filter(
      (f) =>
        !f.isDeclaration &&
        (f.rawValue.includes(".headline") ||
          f.rawValue.includes(".body)") ||
          f.rawValue.includes(".caption)")),
    );

    // System text styles should not produce typography findings
    expect(systemRefs).toHaveLength(0);
  });

  // === extension Font does not contaminate color parser ===

  it("does not extract Color declarations from extension Font blocks", () => {
    const source = `
extension Font {
    static let bodyMd = Font.custom("JetBrainsMono-Regular", size: 16, relativeTo: .body)
}

extension Color {
    static let accent = Color(hex: "#1A88FF")
}
`;
    const findings = extractTypography(source, FIXTURE_PATH);
    const colorFindings = findings.filter((f) => f.rawValue.includes("Color(hex:"));
    expect(colorFindings).toHaveLength(0);

    const fontFindings = findings.filter((f) => f.isDeclaration);
    expect(fontFindings.length).toBeGreaterThanOrEqual(1);
  });

  // === Inference rules ===

  describe("inferFontWeight", () => {
    it("maps all PostScript suffixes to correct weights", () => {
      expect(inferFontWeight("MyFont-Thin")).toBe(100);
      expect(inferFontWeight("MyFont-ExtraLight")).toBe(200);
      expect(inferFontWeight("MyFont-UltraLight")).toBe(200);
      expect(inferFontWeight("MyFont-Light")).toBe(300);
      expect(inferFontWeight("MyFont-Regular")).toBe(400);
      expect(inferFontWeight("MyFont-Book")).toBe(400);
      expect(inferFontWeight("MyFont-Medium")).toBe(500);
      expect(inferFontWeight("MyFont-SemiBold")).toBe(600);
      expect(inferFontWeight("MyFont-DemiBold")).toBe(600);
      expect(inferFontWeight("MyFont-Bold")).toBe(700);
      expect(inferFontWeight("MyFont-ExtraBold")).toBe(800);
      expect(inferFontWeight("MyFont-Heavy")).toBe(800);
      expect(inferFontWeight("MyFont-Black")).toBe(900);
    });

    it("falls back to 400 for unrecognised suffixes", () => {
      expect(inferFontWeight("JetBrainsMono")).toBe(400); // no suffix
      expect(inferFontWeight("PoppinsRegular")).toBe(400); // no hyphen — no suffix match
      expect(inferFontWeight("Unknown-Weird")).toBe(400);
    });
  });

  // === Line numbers ===

  it("reports accurate 1-based line numbers", () => {
    const source = `import SwiftUI

extension Font {
    static let line4Font = Font.custom("JetBrainsMono-Regular", size: 16, relativeTo: .body)
}
`;
    const findings = extractTypography(source, FIXTURE_PATH);
    const decl = findings.find((f) => f.declName === "line4Font");

    expect(decl).toBeDefined();
    expect(decl?.line).toBe(4);
  });

  // === hasDynamicType inference ===

  it("sets hasDynamicType true only when relativeTo is present", () => {
    const source = `
extension Font {
    static let withDT  = Font.custom("Inter-Regular", size: 16, relativeTo: .body)
    static let withoutDT = Font.custom("Inter-Regular", size: 14)
}
`;
    const findings = extractTypography(source, FIXTURE_PATH);
    const withDT = findings.find((f) => f.declName === "withDT");
    const withoutDT = findings.find((f) => f.declName === "withoutDT");

    expect(withDT?.hasDynamicType).toBe(true);
    expect(withoutDT?.hasDynamicType).toBe(false);
  });
});
