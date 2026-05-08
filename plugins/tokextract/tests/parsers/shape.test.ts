/**
 * tests/parsers/shape.test.ts
 *
 * Unit tests for parsers/shape.ts — the corner radius / shape extractor.
 * Covers all 8 patterns from PRD §6.4 plus edge cases and negative cases.
 */

import { describe, expect, it } from "vitest";
import { extractShape } from "../../parsers/shape.js";

const FIXTURE_PATH = "Sources/UI/Components/CardView.swift";

describe("shape parser", () => {
  // === Pattern 1: .cornerRadius(n) view modifier ===
  it("extracts .cornerRadius(n) with correct normalizedValue and shapeType", () => {
    const source = `
struct CardView: View {
    var body: some View {
        RoundedRectangle(cornerRadius: 0)
            .fill(.surfaceCard)
            .cornerRadius(12)
    }
}
`;
    const findings = extractShape(source, FIXTURE_PATH);
    const cr = findings.find((f) => f.context === ".cornerRadius()");

    expect(cr).toBeDefined();
    expect(cr?.normalizedValue).toBe(12);
    expect(cr?.shapeType).toBe("rounded");
    expect(cr?.isDeclaration).toBe(false);
    expect(cr?.category).toBe("cornerRadius");
  });

  // === Pattern 2: RoundedRectangle(cornerRadius: n) — no style ===
  it("extracts RoundedRectangle(cornerRadius:) without style", () => {
    const source = `
struct ButtonStyle: View {
    var body: some View {
        RoundedRectangle(cornerRadius: 16)
            .fill(.brandPrimary)
    }
}
`;
    const findings = extractShape(source, FIXTURE_PATH);
    const rr = findings.find((f) => f.context === "RoundedRectangle(cornerRadius:)");

    expect(rr).toBeDefined();
    expect(rr?.normalizedValue).toBe(16);
    expect(rr?.shapeType).toBe("rounded");
    expect(rr?.isDeclaration).toBe(false);
  });

  // === Pattern 3: RoundedRectangle(cornerRadius: n, style: .continuous) ===
  it("extracts RoundedRectangle(cornerRadius:style:) with continuous style encoded in context", () => {
    const source = `
struct PillShape: View {
    var body: some View {
        RoundedRectangle(cornerRadius: 16, style: .continuous)
    }
}
`;
    const findings = extractShape(source, FIXTURE_PATH);
    const rr = findings.find((f) => f.context?.includes(".continuous"));

    expect(rr).toBeDefined();
    expect(rr?.normalizedValue).toBe(16);
    expect(rr?.shapeType).toBe("rounded");
    expect(rr?.context).toBe("RoundedRectangle(cornerRadius:style:.continuous)");
  });

  // === Pattern 3b: RoundedRectangle with style: .circular ===
  it("extracts RoundedRectangle(cornerRadius:style:.circular)", () => {
    const source = "RoundedRectangle(cornerRadius: 8, style: .circular)";
    const findings = extractShape(source, FIXTURE_PATH);
    const rr = findings.find((f) => f.context?.includes(".circular"));

    expect(rr).toBeDefined();
    expect(rr?.normalizedValue).toBe(8);
    expect(rr?.context).toBe("RoundedRectangle(cornerRadius:style:.circular)");
  });

  // === Pattern 4: .clipShape(RoundedRectangle(cornerRadius: n)) ===
  it("extracts .clipShape(RoundedRectangle(cornerRadius:)) call", () => {
    const source = `
struct TagView: View {
    var body: some View {
        Text("Tag")
            .clipShape(RoundedRectangle(cornerRadius: 8))
    }
}
`;
    const findings = extractShape(source, FIXTURE_PATH);
    const cs = findings.find((f) => f.context === ".clipShape(RoundedRectangle(cornerRadius:))");

    expect(cs).toBeDefined();
    expect(cs?.normalizedValue).toBe(8);
    expect(cs?.shapeType).toBe("rounded");
    expect(cs?.isDeclaration).toBe(false);
  });

  // === Pattern 4b: .clipShape with style ===
  it("extracts .clipShape(RoundedRectangle(cornerRadius:style:.continuous))", () => {
    const source = `
content.clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
`;
    const findings = extractShape(source, FIXTURE_PATH);
    const cs = findings.find((f) => f.context?.includes(".clipShape(RoundedRectangle"));

    expect(cs).toBeDefined();
    expect(cs?.normalizedValue).toBe(12);
    expect(cs?.context).toBe(".clipShape(RoundedRectangle(cornerRadius:style:.continuous))");
  });

  // === Pattern 5a: .clipShape(Circle()) ===
  it("extracts .clipShape(Circle()) with shapeType=circle and normalizedValue=null", () => {
    const source = `
Image("avatar")
    .clipShape(Circle())
`;
    const findings = extractShape(source, FIXTURE_PATH);
    const circle = findings.find((f) => f.shapeType === "circle");

    expect(circle).toBeDefined();
    expect(circle?.normalizedValue).toBeNull();
    expect(circle?.context).toBe(".clipShape(Circle())");
    expect(circle?.isDeclaration).toBe(false);
  });

  // === Pattern 5b: .clipShape(Capsule()) ===
  it("extracts .clipShape(Capsule()) with shapeType=capsule", () => {
    const source = `Button("Save") {}.clipShape(Capsule())`;
    const findings = extractShape(source, FIXTURE_PATH);
    const capsule = findings.find((f) => f.shapeType === "capsule");

    expect(capsule).toBeDefined();
    expect(capsule?.normalizedValue).toBeNull();
    expect(capsule?.context).toBe(".clipShape(Capsule())");
  });

  // === Pattern 5c: .clipShape(Ellipse()) ===
  it("extracts .clipShape(Ellipse()) with shapeType=ellipse", () => {
    const source = "Shape().clipShape(Ellipse())";
    const findings = extractShape(source, FIXTURE_PATH);
    const ellipse = findings.find((f) => f.shapeType === "ellipse");

    expect(ellipse).toBeDefined();
    expect(ellipse?.normalizedValue).toBeNull();
    expect(ellipse?.context).toBe(".clipShape(Ellipse())");
  });

  // === Pattern 6: extension View { func cardShape() → declaration form ===
  it("extracts extension View func as isDeclaration=true with declName", () => {
    const source = `
extension View {
    func cardShape() -> some View {
        clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
}
`;
    const findings = extractShape(source, FIXTURE_PATH);
    const decl = findings.find((f) => f.isDeclaration && f.declName === "cardShape");

    expect(decl).toBeDefined();
    expect(decl?.isDeclaration).toBe(true);
    expect(decl?.declName).toBe("cardShape");
    expect(decl?.normalizedValue).toBe(16);
    expect(decl?.shapeType).toBe("rounded");
    expect(decl?.context).toBe("extension View func");
  });

  // === Pattern 6b: extension View with plain .cornerRadius ===
  it("extracts extension View func using .cornerRadius in body", () => {
    const source = `
extension View {
    func pillShape() -> some View {
        self.cornerRadius(24)
    }
}
`;
    const findings = extractShape(source, FIXTURE_PATH);
    const decl = findings.find((f) => f.isDeclaration && f.declName === "pillShape");

    expect(decl).toBeDefined();
    expect(decl?.normalizedValue).toBe(24);
  });

  // === Pattern 7: UnevenRoundedRectangle ===
  it("extracts UnevenRoundedRectangle with four-corner normalizedValue object", () => {
    const source = `
UnevenRoundedRectangle(cornerRadii: .init(topLeading: 8, bottomLeading: 0, bottomTrailing: 0, topTrailing: 8))
`;
    const findings = extractShape(source, FIXTURE_PATH);
    const uneven = findings.find((f) => f.context === "UnevenRoundedRectangle");

    expect(uneven).toBeDefined();
    expect(uneven?.shapeType).toBe("rounded");
    expect(uneven?.isDeclaration).toBe(false);

    const normalized = uneven?.normalizedValue as {
      topLeading: number;
      topTrailing: number;
      bottomLeading: number;
      bottomTrailing: number;
    } | null;
    expect(normalized).not.toBeNull();
    expect(normalized?.topLeading).toBe(8);
    expect(normalized?.topTrailing).toBe(8);
    expect(normalized?.bottomLeading).toBe(0);
    expect(normalized?.bottomTrailing).toBe(0);
  });

  // === Pattern 7b: UnevenRoundedRectangle with partial args → normalizedValue null ===
  it("emits UnevenRoundedRectangle with normalizedValue=null when not all corners are numeric literals", () => {
    const source = `
UnevenRoundedRectangle(cornerRadii: .init(topLeading: cornerValue, bottomLeading: 0, bottomTrailing: 0, topTrailing: 8))
`;
    const findings = extractShape(source, FIXTURE_PATH);
    const uneven = findings.find((f) => f.context === "UnevenRoundedRectangle");

    expect(uneven).toBeDefined();
    expect(uneven?.normalizedValue).toBeNull();
    expect(uneven?.rawValue).toContain("UnevenRoundedRectangle");
  });

  // === Pattern 8: .clipShape(ContainerRelativeShape()) — adaptive ===
  it("extracts .clipShape(ContainerRelativeShape()) with shapeType=adaptive", () => {
    const source = `
struct Widget: View {
    var body: some View {
        content.clipShape(ContainerRelativeShape())
    }
}
`;
    const findings = extractShape(source, FIXTURE_PATH);
    const adaptive = findings.find((f) => f.shapeType === "adaptive");

    expect(adaptive).toBeDefined();
    expect(adaptive?.normalizedValue).toBeNull();
    expect(adaptive?.context).toBe(".clipShape(ContainerRelativeShape())");
    expect(adaptive?.isDeclaration).toBe(false);
  });

  // === Multiple findings from a single file ===
  it("extracts multiple shape findings from a single source file", () => {
    const source = `
struct PrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .padding(.horizontal, 24)
            .clipShape(RoundedRectangle(cornerRadius: 12))
    }
}

struct CardModifier: ViewModifier {
    func body(content: Content) -> some View {
        content.clipShape(RoundedRectangle(cornerRadius: 16))
    }
}

Image("avatar").clipShape(Circle())
`;
    const findings = extractShape(source, FIXTURE_PATH);

    expect(findings.length).toBeGreaterThanOrEqual(3);
    const radii = findings
      .filter((f) => typeof f.normalizedValue === "number")
      .map((f) => f.normalizedValue);
    expect(radii).toContain(12);
    expect(radii).toContain(16);

    const hasCircle = findings.some((f) => f.shapeType === "circle");
    expect(hasCircle).toBe(true);
  });

  // === Accurate line numbers ===
  it("reports accurate 1-based line numbers", () => {
    const source = `import SwiftUI

struct Foo: View {
    var body: some View {
        Text("hi").cornerRadius(20)
    }
}
`;
    const findings = extractShape(source, FIXTURE_PATH);
    const cr = findings.find((f) => f.context === ".cornerRadius()");

    expect(cr).toBeDefined();
    expect(cr?.line).toBe(5);
  });

  // === Negative: non-numeric .cornerRadius calls are not extracted ===
  it("does NOT extract .cornerRadius(TokenConstants.sm) — non-numeric literal", () => {
    const source = `Text("x").cornerRadius(TokenConstants.sm)`;
    const findings = extractShape(source, FIXTURE_PATH);
    const cr = findings.find((f) => f.context === ".cornerRadius()");

    expect(cr).toBeUndefined();
  });

  // === Deduplication: declaration findings win over call-site duplicates ===
  it("does not emit duplicate findings for the same source position", () => {
    const source = `
extension View {
    func cardShape() -> some View {
        clipShape(RoundedRectangle(cornerRadius: 16))
    }
}
`;
    const findings = extractShape(source, FIXTURE_PATH);

    // There should be exactly one finding for this position (the declaration form wins)
    const declarations = findings.filter((f) => f.isDeclaration);
    expect(declarations.length).toBe(1);
  });

  // === Decimal corner radius values ===
  it("handles decimal corner radius values", () => {
    const source = ".cornerRadius(4.5)";
    const findings = extractShape(source, FIXTURE_PATH);
    const cr = findings.find((f) => f.context === ".cornerRadius()");

    expect(cr).toBeDefined();
    expect(cr?.normalizedValue).toBeCloseTo(4.5);
  });
});
