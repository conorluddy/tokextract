/**
 * tests/parsers/animation.test.ts
 *
 * Unit tests for parsers/animation.ts
 * Covers all 6 patterns from PRD §6.6.
 */

import { describe, expect, it } from "vitest";
import { extractAnimation } from "../../parsers/animation.js";

const FIXTURE_PATH = "Sources/UI/Transitions/AnimationTokens.swift";

// Convenience type alias for normalizedValue assertions
type NV = {
  type: string;
  duration?: number;
  response?: number;
  dampingFraction?: number;
  blendDuration?: number;
  namedRef?: string;
} | null;

describe("animation parser", () => {
  // === Pattern 1: .animation() with named curve + duration ===
  it("extracts .animation(.easeInOut(duration:), value:) modifier call sites", () => {
    const source = `
struct MyView: View {
    var body: some View {
        content
            .animation(.easeInOut(duration: 0.3), value: isVisible)
    }
}
`;
    const findings = extractAnimation(source, FIXTURE_PATH);
    const finding = findings.find((f) => f.context === ".animation()");

    expect(finding).toBeDefined();
    expect(finding?.isDeclaration).toBe(false);
    expect(finding?.category).toBe("animation");

    const nv = finding?.normalizedValue as NV;
    expect(nv?.type).toBe("easeInOut");
    expect(nv?.duration).toBeCloseTo(0.3, 4);
  });

  // === Pattern 2: .animation() with spring params ===
  it("extracts .animation(.spring(response:dampingFraction:), value:) modifier", () => {
    const source = `
struct CardView: View {
    var body: some View {
        card
            .animation(.spring(response: 0.5, dampingFraction: 0.75), value: offset)
    }
}
`;
    const findings = extractAnimation(source, FIXTURE_PATH);
    const springFinding = findings.find((f) => {
      const nv = f.normalizedValue as NV;
      return nv?.type === "spring";
    });

    expect(springFinding).toBeDefined();
    expect(springFinding?.isDeclaration).toBe(false);
    expect(springFinding?.context).toBe(".animation()");

    const nv = springFinding?.normalizedValue as NV;
    expect(nv?.response).toBeCloseTo(0.5, 4);
    expect(nv?.dampingFraction).toBeCloseTo(0.75, 4);
  });

  // === Pattern 3: bare named curves (no duration arg) ===
  it("extracts bare .animation(.easeIn), .animation(.easeOut), .animation(.linear), .animation(.default)", () => {
    const source = `
struct AnimatedView: View {
    var body: some View {
        a.animation(.easeIn)
        b.animation(.easeOut)
        c.animation(.linear)
        d.animation(.default)
    }
}
`;
    const findings = extractAnimation(source, FIXTURE_PATH);
    const types = findings
      .filter((f) => f.context === ".animation()")
      .map((f) => (f.normalizedValue as NV)?.type);

    expect(types).toContain("easeIn");
    expect(types).toContain("easeOut");
    expect(types).toContain("linear");
    expect(types).toContain("default");
  });

  // === Pattern 4: withAnimation() global function form ===
  it("extracts withAnimation(.easeOut(duration:)) { } call sites", () => {
    const source = `
func toggleMenu() {
    withAnimation(.easeOut(duration: 0.2)) {
        isMenuVisible.toggle()
    }
}
`;
    const findings = extractAnimation(source, FIXTURE_PATH);
    const finding = findings.find((f) => f.context === "withAnimation()");

    expect(finding).toBeDefined();
    expect(finding?.isDeclaration).toBe(false);
    expect(finding?.category).toBe("animation");

    const nv = finding?.normalizedValue as NV;
    expect(nv?.type).toBe("easeOut");
    expect(nv?.duration).toBeCloseTo(0.2, 4);
  });

  // === Pattern 5: extension Animation static let declaration ===
  it("extracts extension Animation static let declarations", () => {
    const source = `
extension Animation {
    static let standard = Animation.spring(response: 0.4, dampingFraction: 0.8)
    static let quick = Animation.easeOut(duration: 0.15)
}
`;
    const findings = extractAnimation(source, FIXTURE_PATH);
    const declarations = findings.filter((f) => f.isDeclaration);

    expect(declarations.length).toBeGreaterThanOrEqual(2);

    const standard = declarations.find((f) => f.declName === "standard");
    expect(standard).toBeDefined();
    expect(standard?.context).toBe("extension Animation static let");

    const standardNv = standard?.normalizedValue as NV;
    expect(standardNv?.type).toBe("spring");
    expect(standardNv?.response).toBeCloseTo(0.4, 4);
    expect(standardNv?.dampingFraction).toBeCloseTo(0.8, 4);

    const quick = declarations.find((f) => f.declName === "quick");
    expect(quick).toBeDefined();

    const quickNv = quick?.normalizedValue as NV;
    expect(quickNv?.type).toBe("easeOut");
    expect(quickNv?.duration).toBeCloseTo(0.15, 4);
  });

  // === Pattern 6: named-ref call site (.standard resolves to declared constant) ===
  it("extracts .animation(.standard, value:) as named-ref call site", () => {
    const source = `
struct TokenisedView: View {
    var body: some View {
        content.animation(.standard, value: isExpanded)
    }
}
`;
    const findings = extractAnimation(source, FIXTURE_PATH);
    const finding = findings.find((f) => f.context === ".animation()");

    expect(finding).toBeDefined();
    expect(finding?.isDeclaration).toBe(false);

    const nv = finding?.normalizedValue as NV;
    expect(nv?.type).toBe("named-ref");
    expect(nv?.namedRef).toBe("standard");
  });

  // === Multiple findings from a mixed file ===
  it("extracts multiple findings from a file with both declarations and call sites", () => {
    const source = `
extension Animation {
    static let snappy = Animation.spring(response: 0.35, dampingFraction: 0.7)
}

struct MyView: View {
    var body: some View {
        card
            .animation(.snappy, value: isExpanded)
            .animation(.easeInOut(duration: 0.25), value: opacity)
        withAnimation(.spring(response: 0.6, dampingFraction: 0.9)) {
            showModal = true
        }
    }
}
`;
    const findings = extractAnimation(source, FIXTURE_PATH);

    const declarations = findings.filter((f) => f.isDeclaration);
    const callSites = findings.filter((f) => !f.isDeclaration);

    expect(declarations.length).toBeGreaterThanOrEqual(1);
    expect(callSites.length).toBeGreaterThanOrEqual(3);

    const decl = declarations.find((f) => f.declName === "snappy");
    expect(decl?.normalizedValue).not.toBeNull();

    const namedRef = callSites.find((f) => (f.normalizedValue as NV)?.namedRef === "snappy");
    expect(namedRef).toBeDefined();

    const withAnim = callSites.find((f) => f.context === "withAnimation()");
    expect(withAnim).toBeDefined();
    expect((withAnim?.normalizedValue as NV)?.type).toBe("spring");
  });

  // === spring with blendDuration (optional 3rd param) ===
  it("captures blendDuration from spring(response:dampingFraction:blendDuration:)", () => {
    const source = `
extension Animation {
    static let smooth = Animation.spring(response: 0.5, dampingFraction: 0.8, blendDuration: 0.1)
}
`;
    const findings = extractAnimation(source, FIXTURE_PATH);
    const decl = findings.find((f) => f.declName === "smooth");

    expect(decl).toBeDefined();
    const nv = decl?.normalizedValue as NV;
    expect(nv?.type).toBe("spring");
    expect(nv?.blendDuration).toBeCloseTo(0.1, 4);
  });

  // === withAnimation bare curve (no duration) ===
  it("extracts withAnimation(.linear) with no duration arg", () => {
    const source = `
func animate() {
    withAnimation(.linear) { state = true }
}
`;
    const findings = extractAnimation(source, FIXTURE_PATH);
    const finding = findings.find((f) => f.context === "withAnimation()");

    expect(finding).toBeDefined();
    const nv = finding?.normalizedValue as NV;
    expect(nv?.type).toBe("linear");
    expect(nv?.duration).toBeUndefined();
  });

  // === Non-Animation extensions are not mistaken for Animation ===
  it("does not extract declarations from extension Color or extension View blocks", () => {
    const source = `
extension Color {
    static let brand = Color(red: 0.1, green: 0.2, blue: 0.9)
}

extension View {
    func cardStyle() -> some View { self }
}

extension Animation {
    static let gentle = Animation.easeInOut(duration: 0.4)
}
`;
    const findings = extractAnimation(source, FIXTURE_PATH);
    const declarations = findings.filter((f) => f.isDeclaration);

    // Only the Animation extension should produce a declaration
    expect(declarations.length).toBe(1);
    expect(declarations[0]?.declName).toBe("gentle");
  });

  // === Line numbers are 1-based and accurate ===
  it("reports accurate 1-based line numbers", () => {
    const source = `import SwiftUI

extension Animation {
    static let branded = Animation.spring(response: 0.45, dampingFraction: 0.7)
}
`;
    const findings = extractAnimation(source, FIXTURE_PATH);
    const decl = findings.find((f) => f.declName === "branded");

    expect(decl).toBeDefined();
    expect(decl?.line).toBe(4);
  });
});
