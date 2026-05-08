/**
 * tests/parsers/glass.test.ts
 *
 * Unit tests for parsers/glass.ts — iOS 26 Liquid Glass usage extraction.
 * Covers all 6 detection patterns and the content-layer audit flag.
 */

import { describe, expect, it } from "vitest";
import { extractGlass } from "../../parsers/glass.js";
import type { GlassNormalizedValue } from "../../parsers/glass.js";

const FIXTURE_PATH = "Sources/UI/Views/HomeView.swift";

describe("glass parser", () => {
  // === Pattern 1: bare .glassEffect() ===
  it("extracts bare .glassEffect() with variant 'regular' (default)", () => {
    const source = `
struct NavBar: View {
    var body: some View {
        TabView()
            .glassEffect()
    }
}
`;
    const findings = extractGlass(source, FIXTURE_PATH);
    const finding = findings.find((f) => f.context === ".glassEffect()");

    expect(finding).toBeDefined();
    expect(finding?.category).toBe("liquidGlass");
    expect(finding?.isDeclaration).toBe(false);
    expect(finding?.severity).toBe("info");
    expect(finding?.declName).toBeNull();

    const normalized = finding?.normalizedValue as GlassNormalizedValue | null;
    expect(normalized?.variant).toBe("regular");
  });

  // === Pattern 2: .glassEffect(.clear) and .glassEffect(.identity) ===
  it("extracts .glassEffect(.regular), .glassEffect(.clear), .glassEffect(.identity) with correct variant", () => {
    const source = `
struct NavBar: View {
    var body: some View {
        TabView()
            .glassEffect(.regular)
        TabView()
            .glassEffect(.clear)
        TabView()
            .glassEffect(.identity)
    }
}
`;
    const findings = extractGlass(source, FIXTURE_PATH);
    const glassFindings = findings.filter((f) => f.context === ".glassEffect()");

    const variants = glassFindings.map((f) => (f.normalizedValue as GlassNormalizedValue)?.variant);
    expect(variants).toContain("regular");
    expect(variants).toContain("clear");
    expect(variants).toContain("identity");
  });

  // === Pattern 3: chained style modifiers ===
  it("extracts .glassEffect(.regular.tint(Color.brandPrimary).interactive()) with full chain", () => {
    const source = `
struct Toolbar: View {
    var body: some View {
        toolbarBackground(.glassEffect(.regular.tint(Color.brandPrimary).interactive()))
    }
}
`;
    const findings = extractGlass(source, FIXTURE_PATH);
    const finding = findings.find((f) => f.context === ".glassEffect()");

    expect(finding).toBeDefined();

    const normalized = finding?.normalizedValue as GlassNormalizedValue | null;
    expect(normalized?.variant).toBe("regular");
    expect(normalized?.tint).toBe("Color.brandPrimary");
    expect(normalized?.interactive).toBe(true);
  });

  // === Pattern 3b: .tint without .interactive ===
  it("extracts .glassEffect(.clear.tint(Color.accent)) without interactive flag", () => {
    const source = `
struct Bar: View {
    var body: some View {
        NavigationBar().glassEffect(.clear.tint(Color.accent))
    }
}
`;
    const findings = extractGlass(source, FIXTURE_PATH);
    const finding = findings.find((f) => f.context === ".glassEffect()");

    expect(finding).toBeDefined();
    const normalized = finding?.normalizedValue as GlassNormalizedValue | null;
    expect(normalized?.variant).toBe("clear");
    expect(normalized?.tint).toBe("Color.accent");
    expect(normalized?.interactive).toBeUndefined();
  });

  // === Pattern 4: GlassEffectContainer without spacing ===
  it("extracts GlassEffectContainer { } with no spacing", () => {
    const source = `
struct CardStack: View {
    var body: some View {
        GlassEffectContainer {
            Text("Hello")
        }
    }
}
`;
    const findings = extractGlass(source, FIXTURE_PATH);
    const finding = findings.find((f) => f.context === "GlassEffectContainer");

    expect(finding).toBeDefined();
    expect(finding?.category).toBe("liquidGlass");
    expect(finding?.severity).toBe("info");

    const normalized = finding?.normalizedValue as GlassNormalizedValue | null;
    expect(normalized?.spacing).toBeUndefined();
  });

  // === Pattern 4b: GlassEffectContainer(spacing: 8) ===
  it("extracts GlassEffectContainer(spacing: 8) with spacing captured", () => {
    const source = `
struct CardStack: View {
    var body: some View {
        GlassEffectContainer(spacing: 8) {
            Card()
            Card()
        }
    }
}
`;
    const findings = extractGlass(source, FIXTURE_PATH);
    const finding = findings.find((f) => f.context === "GlassEffectContainer");

    expect(finding).toBeDefined();
    const normalized = finding?.normalizedValue as GlassNormalizedValue | null;
    expect(normalized?.spacing).toBe(8);
  });

  // === Pattern 5: .glassEffectID ===
  it("extracts .glassEffectID with id and namespace captured", () => {
    const source = `
struct CardView: View {
    @Namespace var glassNamespace: Namespace.ID

    var body: some View {
        RoundedRectangle(cornerRadius: 16)
            .glassEffectID("card", in: glassNamespace)
    }
}
`;
    const findings = extractGlass(source, FIXTURE_PATH);
    const finding = findings.find((f) => f.context === ".glassEffectID");

    expect(finding).toBeDefined();
    expect(finding?.category).toBe("liquidGlass");
    expect(finding?.severity).toBe("info");

    const normalized = finding?.normalizedValue as GlassNormalizedValue | null;
    expect(normalized?.id).toBe("card");
    expect(normalized?.namespace).toBe("glassNamespace");
  });

  // === Pattern 6: .buttonStyle(.glass) ===
  it("extracts .buttonStyle(.glass) with buttonStyle: 'glass'", () => {
    const source = `
struct ActionButton: View {
    var body: some View {
        Button("Tap me") { }
            .buttonStyle(.glass)
    }
}
`;
    const findings = extractGlass(source, FIXTURE_PATH);
    const finding = findings.find((f) => f.context === ".buttonStyle(.glass)");

    expect(finding).toBeDefined();
    expect(finding?.category).toBe("liquidGlass");
    expect(finding?.severity).toBe("info");

    const normalized = finding?.normalizedValue as GlassNormalizedValue | null;
    expect(normalized?.buttonStyle).toBe("glass");
  });

  // === Pattern 6b: .buttonStyle(.glassProminent) ===
  it("extracts .buttonStyle(.glassProminent) with buttonStyle: 'glassProminent'", () => {
    const source = `
struct ActionButton: View {
    var body: some View {
        Button("Confirm") { }
            .buttonStyle(.glassProminent)
    }
}
`;
    const findings = extractGlass(source, FIXTURE_PATH);
    const finding = findings.find((f) => f.context === ".buttonStyle(.glassProminent)");

    expect(finding).toBeDefined();
    const normalized = finding?.normalizedValue as GlassNormalizedValue | null;
    expect(normalized?.buttonStyle).toBe("glassProminent");
  });

  // === Audit flag: glass on content layer — warning ===
  it("sets severity 'warning' when .glassEffect() is on a List (content layer)", () => {
    const source = `
struct ContentView: View {
    var body: some View {
        List(items) { item in
            Text(item.title)
        }
        .glassEffect()
    }
}
`;
    const findings = extractGlass(source, FIXTURE_PATH);
    // Should have both the main .glassEffect() finding AND the audit finding
    const warningFindings = findings.filter((f) => f.severity === "warning");

    expect(warningFindings.length).toBeGreaterThanOrEqual(1);

    const auditFinding = warningFindings.find((f) => f.context === "glass on content layer");
    expect(auditFinding).toBeDefined();
    expect(auditFinding?.category).toBe("liquidGlass");
  });

  // === Audit flag: glass on ScrollView — warning ===
  it("sets severity 'warning' when .glassEffect() is on a ScrollView", () => {
    const source = `
struct FeedView: View {
    var body: some View {
        ScrollView {
            LazyVStack { /* items */ }
        }.glassEffect(.regular)
    }
}
`;
    const findings = extractGlass(source, FIXTURE_PATH);
    const warningFindings = findings.filter((f) => f.severity === "warning");

    expect(warningFindings.length).toBeGreaterThanOrEqual(1);
  });

  // === Audit flag: navigation layer — stays info ===
  it("keeps severity 'info' when .glassEffect() is on a TabView (navigation layer)", () => {
    const source = `
struct RootView: View {
    var body: some View {
        TabView {
            HomeTab()
        }
        .glassEffect()
    }
}
`;
    const findings = extractGlass(source, FIXTURE_PATH);
    const glassFindings = findings.filter((f) => f.context === ".glassEffect()");

    expect(glassFindings.length).toBeGreaterThanOrEqual(1);
    expect(glassFindings.every((f) => f.severity === "info")).toBe(true);

    // No audit warning finding
    const auditFindings = findings.filter((f) => f.context === "glass on content layer");
    expect(auditFindings).toHaveLength(0);
  });

  // === Audit flag: RoundedRectangle — warning ===
  it("sets severity 'warning' when .glassEffect() is applied to a RoundedRectangle (card background)", () => {
    const source = `
struct CardView: View {
    var body: some View {
        RoundedRectangle(cornerRadius: 16)
            .fill(.white)
            .glassEffect(.regular)
    }
}
`;
    const findings = extractGlass(source, FIXTURE_PATH);
    const warningFindings = findings.filter((f) => f.severity === "warning");

    expect(warningFindings.length).toBeGreaterThanOrEqual(1);
  });

  // === Multiple patterns in one file ===
  it("extracts multiple glass patterns from a single file", () => {
    const source = `
struct ComplexView: View {
    @Namespace var glass: Namespace.ID

    var body: some View {
        GlassEffectContainer(spacing: 12) {
            Button("Action") { }
                .buttonStyle(.glass)
                .glassEffectID("btn", in: glass)

            Button("Primary") { }
                .buttonStyle(.glassProminent)
        }

        TabView { HomeView() }
            .glassEffect(.regular.tint(Color.tintBlue))
    }
}
`;
    const findings = extractGlass(source, FIXTURE_PATH);

    const containerFinding = findings.find((f) => f.context === "GlassEffectContainer");
    const buttonGlass = findings.find((f) => f.context === ".buttonStyle(.glass)");
    const buttonProminent = findings.find((f) => f.context === ".buttonStyle(.glassProminent)");
    const idFinding = findings.find((f) => f.context === ".glassEffectID");
    const effectFinding = findings.find((f) => f.context === ".glassEffect()");

    expect(containerFinding).toBeDefined();
    expect((containerFinding?.normalizedValue as GlassNormalizedValue)?.spacing).toBe(12);

    expect(buttonGlass).toBeDefined();
    expect(buttonProminent).toBeDefined();

    expect(idFinding).toBeDefined();
    expect((idFinding?.normalizedValue as GlassNormalizedValue)?.id).toBe("btn");

    expect(effectFinding).toBeDefined();
    expect((effectFinding?.normalizedValue as GlassNormalizedValue)?.tint).toBe("Color.tintBlue");
  });

  // === isDeclaration is always false ===
  it("always sets isDeclaration: false for all glass findings", () => {
    const source = `
struct Foo: View {
    var body: some View {
        TabView { HomeView() }
            .glassEffect()
        GlassEffectContainer { Text("x") }
        Button("ok") { }.buttonStyle(.glass)
    }
}
`;
    const findings = extractGlass(source, FIXTURE_PATH);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((f) => f.isDeclaration === false)).toBe(true);
  });

  // === Line numbers are accurate ===
  it("reports accurate 1-based line numbers", () => {
    const source = `import SwiftUI

struct NavView: View {
    var body: some View {
        TabView { MainView() }
            .glassEffect(.clear)
    }
}
`;
    const findings = extractGlass(source, FIXTURE_PATH);
    const effectFinding = findings.find((f) => f.context === ".glassEffect()");

    expect(effectFinding).toBeDefined();
    // .glassEffect(.clear) is on line 6
    expect(effectFinding?.line).toBe(6);
  });
});
