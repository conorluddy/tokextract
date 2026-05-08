/**
 * tests/parsers/component.test.ts
 *
 * Unit tests for parsers/component.ts — the Slice 2 component extractor.
 * Covers all five detection patterns plus modifier chain accuracy and negative cases.
 */

import { describe, expect, it } from "vitest";
import { extractComponents } from "../../parsers/component.js";

const FIXTURE_PATH = "Sources/UI/Components/ButtonStyles.swift";

describe("component parser", () => {
  // === Test 1: ButtonStyle struct — pattern 1 ===
  it("extracts ButtonStyle struct with modifier chain from makeBody", () => {
    const source = `
struct PrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .padding(.horizontal, 24)
            .padding(.vertical, 12)
            .background(Color.brandPrimary)
            .foregroundStyle(Color.white)
            .clipShape(RoundedRectangle(cornerRadius: 12))
    }
}
`;
    const findings = extractComponents(source, FIXTURE_PATH);
    const finding = findings.find((f) => f.declName === "PrimaryButtonStyle");

    expect(finding).toBeDefined();
    expect(finding?.category).toBe("component");
    expect(finding?.isDeclaration).toBe(true);
    expect(finding?.context).toBe("struct ButtonStyle");
    expect(finding?.normalizedValue).toBeNull();
    expect(finding?.componentConfidence).toBe("high");

    const chain = finding?.modifierChain ?? [];
    expect(chain.length).toBeGreaterThanOrEqual(4);

    const padding = chain.find((m) => m.name === "padding" && m.args.includes(".horizontal"));
    expect(padding).toBeDefined();
    expect(padding?.args).toContain("24");

    const background = chain.find((m) => m.name === "background");
    expect(background).toBeDefined();
    expect(background?.args[0]).toBe("Color.brandPrimary");

    const clip = chain.find((m) => m.name === "clipShape");
    expect(clip).toBeDefined();
    expect(clip?.args[0]).toBe("RoundedRectangle(cornerRadius: 12)");
  });

  // === Test 2: ViewModifier struct — pattern 2 ===
  it("extracts ViewModifier struct with modifier chain from body(content:)", () => {
    const source = `
struct CardModifier: ViewModifier {
    func body(content: Content) -> some View {
        content
            .background(Color.surfaceCard)
            .clipShape(RoundedRectangle(cornerRadius: 16))
            .shadow(color: .black.opacity(0.1), radius: 8, y: 4)
    }
}
`;
    const findings = extractComponents(source, FIXTURE_PATH);
    const finding = findings.find((f) => f.declName === "CardModifier");

    expect(finding).toBeDefined();
    expect(finding?.context).toBe("struct ViewModifier");
    expect(finding?.componentConfidence).toBe("high");

    const chain = finding?.modifierChain ?? [];
    expect(chain.length).toBeGreaterThanOrEqual(2);

    const background = chain.find((m) => m.name === "background");
    expect(background).toBeDefined();
    expect(background?.args[0]).toBe("Color.surfaceCard");

    const clip = chain.find((m) => m.name === "clipShape");
    expect(clip).toBeDefined();
    expect(clip?.args[0]).toBe("RoundedRectangle(cornerRadius: 16)");
  });

  // === Test 3: PrimitiveButtonStyle struct — pattern 3 ===
  it("extracts PrimitiveButtonStyle struct with modifier chain", () => {
    const source = `
struct TappableButtonStyle: PrimitiveButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .padding(16)
            .background(.blue)
            .foregroundColor(.white)
    }
}
`;
    const findings = extractComponents(source, FIXTURE_PATH);
    const finding = findings.find((f) => f.declName === "TappableButtonStyle");

    expect(finding).toBeDefined();
    expect(finding?.context).toBe("struct PrimitiveButtonStyle");
    expect(finding?.isDeclaration).toBe(true);
    expect(finding?.componentConfidence).toBe("high");

    const chain = finding?.modifierChain ?? [];
    expect(chain.length).toBeGreaterThanOrEqual(2);

    const padding = chain.find((m) => m.name === "padding");
    expect(padding).toBeDefined();
    expect(padding?.args[0]).toBe("16");

    const bg = chain.find((m) => m.name === "background");
    expect(bg).toBeDefined();
    expect(bg?.args[0]).toBe(".blue");
  });

  // === Test 4: extension View convenience wrapper — pattern 4 ===
  it("extracts extension View convenience wrapper function", () => {
    const source = `
extension View {
    func cardStyle() -> some View { modifier(CardModifier()) }
}
`;
    const findings = extractComponents(source, FIXTURE_PATH);
    const finding = findings.find((f) => f.declName === "cardStyle");

    expect(finding).toBeDefined();
    expect(finding?.category).toBe("component");
    expect(finding?.isDeclaration).toBe(true);
    expect(finding?.context).toBe("extension View func");
    expect(finding?.normalizedValue).toBeNull();
    expect(finding?.componentConfidence).toBe("high");
    // rawValue captures the modifier(...) call
    expect(finding?.rawValue).toContain("modifier(CardModifier())");
  });

  // === Test 5: Custom View struct — single-rooted body — pattern 5 ===
  it("extracts custom View struct with modifier chain from single-rooted body", () => {
    const source = `
struct Pill: View {
    let label: String
    var body: some View {
        Text(label)
            .padding(.horizontal, 8)
            .background(Color.brand)
            .clipShape(Capsule())
    }
}
`;
    const findings = extractComponents(source, FIXTURE_PATH);
    const finding = findings.find((f) => f.declName === "Pill");

    expect(finding).toBeDefined();
    expect(finding?.context).toBe("struct View custom");
    expect(finding?.isDeclaration).toBe(true);
    expect(finding?.componentConfidence).toBe("medium");

    const chain = finding?.modifierChain ?? [];
    expect(chain.length).toBeGreaterThanOrEqual(2);

    const padding = chain.find((m) => m.name === "padding");
    expect(padding).toBeDefined();
    expect(padding?.args).toContain(".horizontal");
    expect(padding?.args).toContain("8");

    const background = chain.find((m) => m.name === "background");
    expect(background).toBeDefined();
    expect(background?.args[0]).toBe("Color.brand");
  });

  // === Test 6: Multi-view body — no name keyword, no init signal → not emitted ===
  // ProfileRow: "row" is excluded from keywords to avoid gallery/demo screen noise.
  // Without @Binding or typed init, it's low confidence → dropped in v1.
  it("does NOT emit ProfileRow: View without name keyword or init signal (row excluded)", () => {
    const source = `
struct ProfileRow: View {
    var body: some View {
        HStack {
            Image(systemName: "person")
            Text("Username")
            Spacer()
        }
    }
}
`;
    const findings = extractComponents(source, FIXTURE_PATH);
    const finding = findings.find((f) => f.declName === "ProfileRow");

    expect(finding).toBeUndefined();
  });

  // === Test 7: Modifier chain args — complex nested args ===
  it("captures modifier chain with complex nested argument expressions", () => {
    const source = `
struct BadgeModifier: ViewModifier {
    func body(content: Content) -> some View {
        content
            .overlay(alignment: .topTrailing) {
                Circle().frame(width: 8, height: 8).foregroundColor(.red)
            }
            .padding(.all, 4)
    }
}
`;
    const findings = extractComponents(source, FIXTURE_PATH);
    const finding = findings.find((f) => f.declName === "BadgeModifier");

    expect(finding).toBeDefined();

    const chain = finding?.modifierChain ?? [];
    const padding = chain.find((m) => m.name === "padding");
    expect(padding).toBeDefined();
    expect(padding?.args).toContain(".all");
    expect(padding?.args).toContain("4");
  });

  // === Test 8: Multiple functions in a style struct — only render fn captured ===
  it("captures only makeBody/body render functions, not helper functions", () => {
    const source = `
struct FancyButtonStyle: ButtonStyle {
    private func applyBackground(_ view: some View) -> some View {
        view.background(.red)
    }
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .padding(12)
            .background(.blue)
    }
}
`;
    const findings = extractComponents(source, FIXTURE_PATH);
    const styleFindings = findings.filter((f) => f.declName === "FancyButtonStyle");

    // Should produce exactly one finding (from makeBody, not the helper)
    expect(styleFindings.length).toBe(1);
    expect(styleFindings[0]?.modifierChain?.find((m) => m.name === "padding")).toBeDefined();
  });

  // === Test 9 (NEGATIVE): Low-confidence custom View struct — not emitted in v1 ===
  // LoginScreen has no component keyword, no @Binding, no typed init → low confidence → dropped
  it("does NOT emit LoginScreen: custom View struct without name match or init signal", () => {
    const source = `
struct LoginScreen: View {
    var body: some View {
        VStack(spacing: 16) {
            Text("Sign In")
            Button("Login") { }
        }
    }
}
`;
    const findings = extractComponents(source, FIXTURE_PATH);
    const finding = findings.find((f) => f.declName === "LoginScreen");

    expect(finding).toBeUndefined();
  });

  // === Test 10 (NEGATIVE): Unrelated type — struct conforming to non-component protocol ===
  it("does NOT extract structs conforming to non-component protocols like Codable", () => {
    const source = `
struct UserProfile: Codable {
    let name: String
    let age: Int
}
`;
    const findings = extractComponents(source, FIXTURE_PATH);
    expect(findings).toHaveLength(0);
  });

  // === Test 11 (NEGATIVE): Non-View extension should not be detected ===
  it("does NOT extract functions from extension Color or extension Font blocks", () => {
    const source = `
extension Color {
    static let brand = Color(.sRGB, red: 0.067, green: 0.537, blue: 1.0, opacity: 1)
}

extension Font {
    static let bodyMd = Font.custom("JetBrainsMono", size: 16)
}
`;
    const findings = extractComponents(source, FIXTURE_PATH);
    expect(findings).toHaveLength(0);
  });

  // === Test 12: Multiple extension View functions ===
  it("extracts multiple convenience wrapper functions from a single extension View block", () => {
    const source = `
extension View {
    func cardStyle() -> some View { modifier(CardModifier()) }
    func pillStyle() -> some View { modifier(PillModifier()) }
    func prominentShadow() -> some View {
        shadow(color: .black.opacity(0.2), radius: 12, y: 6)
    }
}
`;
    const findings = extractComponents(source, FIXTURE_PATH);
    const extensionFindings = findings.filter((f) => f.context === "extension View func");

    expect(extensionFindings.length).toBe(3);
    expect(extensionFindings.map((f) => f.declName)).toContain("cardStyle");
    expect(extensionFindings.map((f) => f.declName)).toContain("pillStyle");
    expect(extensionFindings.map((f) => f.declName)).toContain("prominentShadow");
  });

  // === Test 13: Line numbers are accurate ===
  it("reports accurate 1-based line numbers for extracted declarations", () => {
    const source = `import SwiftUI

struct TagLabel: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.padding(8)
    }
}
`;
    const findings = extractComponents(source, FIXTURE_PATH);
    const finding = findings.find((f) => f.declName === "TagLabel");

    expect(finding).toBeDefined();
    expect(finding?.line).toBe(3);
  });

  // === Test 14 (NEW): medium confidence — name keyword match "Button" ===
  it("emits medium-confidence finding for CustomButton: View (name keyword match)", () => {
    const source = `
struct CustomButton: View {
    let title: String
    var body: some View {
        Text(title)
            .padding(12)
            .background(Color.accentColor)
    }
}
`;
    const findings = extractComponents(source, FIXTURE_PATH);
    const finding = findings.find((f) => f.declName === "CustomButton");

    expect(finding).toBeDefined();
    expect(finding?.category).toBe("component");
    expect(finding?.componentConfidence).toBe("medium");
    expect(finding?.context).toBe("struct View custom");
  });

  // === Test 15 (NEW): medium confidence — name keyword match "Avatar" + "Badge" ===
  it("emits medium-confidence finding for AvatarBadge: View (compound name keyword match)", () => {
    const source = `
struct AvatarBadge: View {
    let count: Int
    var body: some View {
        Circle()
            .frame(width: 20, height: 20)
            .foregroundColor(.red)
    }
}
`;
    const findings = extractComponents(source, FIXTURE_PATH);
    const finding = findings.find((f) => f.declName === "AvatarBadge");

    expect(finding).toBeDefined();
    expect(finding?.componentConfidence).toBe("medium");
  });

  // === Test 16 (NEW): medium confidence — @Binding property signal (no name keyword needed) ===
  // LabeledRow has no component keyword (Row is excluded) but has @Binding → medium
  it("emits medium-confidence finding for LabeledRow: View with @Binding property", () => {
    const source = `
struct LabeledRow: View {
    @Binding var isExpanded: Bool
    let label: String
    var body: some View {
        HStack {
            Text(label)
            Spacer()
            Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
        }
    }
}
`;
    const findings = extractComponents(source, FIXTURE_PATH);
    const finding = findings.find((f) => f.declName === "LabeledRow");

    expect(finding).toBeDefined();
    expect(finding?.componentConfidence).toBe("medium");
  });

  // === Test 17 (NEW): medium confidence — @Binding init signal ===
  it("emits medium-confidence finding for custom View struct with @Binding property", () => {
    const source = `
struct ToggleField: View {
    @Binding var isOn: Bool
    var body: some View {
        Toggle("", isOn: $isOn)
            .padding(8)
    }
}
`;
    const findings = extractComponents(source, FIXTURE_PATH);
    const finding = findings.find((f) => f.declName === "ToggleField");

    expect(finding).toBeDefined();
    expect(finding?.componentConfidence).toBe("medium");
  });

  // === Test 18 (NEW NEGATIVE): ProfileScreen — no keyword, no binding, no typed init → not emitted ===
  it("does NOT emit ProfileScreen: custom View without name match or init signal", () => {
    const source = `
struct ProfileScreen: View {
    var body: some View {
        Text("Profile")
            .font(.title)
    }
}
`;
    const findings = extractComponents(source, FIXTURE_PATH);
    expect(findings.find((f) => f.declName === "ProfileScreen")).toBeUndefined();
  });

  // === Test 19 (NEW NEGATIVE): DashboardView — VStack body, no name match → not emitted ===
  it("does NOT emit DashboardView: View with VStack body and no component keyword", () => {
    const source = `
struct DashboardView: View {
    var body: some View {
        VStack {
            Text("Dashboard")
        }
    }
}
`;
    const findings = extractComponents(source, FIXTURE_PATH);
    expect(findings.find((f) => f.declName === "DashboardView")).toBeUndefined();
  });

  // === Test 20 (NEW NEGATIVE): AppEntry — no keyword, no signal → not emitted ===
  it("does NOT emit AppEntry: View without name match or init signal", () => {
    const source = `
struct AppEntry: View {
    var body: some View {
        ContentView()
    }
}
`;
    const findings = extractComponents(source, FIXTURE_PATH);
    expect(findings.find((f) => f.declName === "AppEntry")).toBeUndefined();
  });

  // === Test 21 (NEW): medium confidence — configuration.label body signal ===
  it("emits medium-confidence finding for custom View using configuration.label in body", () => {
    const source = `
struct HighlightWrapper: View {
    let configuration: ButtonStyleConfiguration
    var body: some View {
        configuration.label
            .padding(16)
            .background(Color.yellow)
    }
}
`;
    const findings = extractComponents(source, FIXTURE_PATH);
    const finding = findings.find((f) => f.declName === "HighlightWrapper");

    expect(finding).toBeDefined();
    expect(finding?.componentConfidence).toBe("medium");
  });
});
