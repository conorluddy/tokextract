/**
 * tests/parsers/theme.test.ts
 *
 * Unit tests for parsers/theme.ts — theme injection infrastructure extraction.
 * Covers all five detection patterns per PRD §6.9.
 */

import { describe, expect, it } from "vitest";
import { extractTheme } from "../../parsers/theme.js";

const FIXTURE_PATH = "Sources/UI/Theme/ThemeProvider.swift";

// === Pattern 1: Custom EnvironmentKey struct ===

describe("theme parser — EnvironmentKey struct", () => {
  it("extracts a basic EnvironmentKey struct with keyName, valueType, defaultValue", () => {
    const source = `
private struct ThemeKey: EnvironmentKey {
    static let defaultValue: Theme = .default
}
`;
    const findings = extractTheme(source, FIXTURE_PATH);
    const finding = findings.find((f) => f.declName === "ThemeKey");

    expect(finding).toBeDefined();
    expect(finding?.category).toBe("theme");
    expect(finding?.isDeclaration).toBe(true);
    expect(finding?.context).toBe("struct EnvironmentKey");

    const nv = finding?.normalizedValue as {
      pattern: string;
      keyName: string;
      valueType: string;
      defaultValue: string;
    } | null;
    expect(nv?.pattern).toBe("EnvironmentKey");
    expect(nv?.keyName).toBe("ThemeKey");
    expect(nv?.valueType).toBe("Theme");
    expect(nv?.defaultValue).toBe(".default");
  });

  it("extracts an internal (no visibility modifier) EnvironmentKey struct", () => {
    const source = `
struct AppThemeKey: EnvironmentKey {
    static let defaultValue: AppTheme = AppTheme()
}
`;
    const findings = extractTheme(source, FIXTURE_PATH);
    const finding = findings.find((f) => f.declName === "AppThemeKey");

    expect(finding).toBeDefined();
    const nv = finding?.normalizedValue as { keyName: string; valueType: string } | null;
    expect(nv?.keyName).toBe("AppThemeKey");
    expect(nv?.valueType).toBe("AppTheme");
  });

  it("does NOT extract a struct that does not conform to EnvironmentKey", () => {
    const source = `
private struct NotAKey: Hashable {
    static let defaultValue: Theme = .default
}
`;
    const findings = extractTheme(source, FIXTURE_PATH);
    const finding = findings.find((f) => f.declName === "NotAKey");
    expect(finding).toBeUndefined();
  });
});

// === Pattern 2: EnvironmentValues extension computed property ===

describe("theme parser — EnvironmentValues extension (computed property)", () => {
  it("extracts computed property with get/set accessors and keyName from self[Key.self]", () => {
    const source = `
extension EnvironmentValues {
    var theme: Theme {
        get { self[ThemeKey.self] }
        set { self[ThemeKey.self] = newValue }
    }
}
`;
    const findings = extractTheme(source, FIXTURE_PATH);
    const finding = findings.find((f) => f.declName === "theme");

    expect(finding).toBeDefined();
    expect(finding?.category).toBe("theme");
    expect(finding?.context).toBe("extension EnvironmentValues");
    expect(finding?.isDeclaration).toBe(true);

    const nv = finding?.normalizedValue as {
      pattern: string;
      keyName: string | undefined;
      propertyName: string;
      valueType: string;
    } | null;
    expect(nv?.pattern).toBe("EnvironmentValues-extension");
    expect(nv?.propertyName).toBe("theme");
    expect(nv?.valueType).toBe("Theme");
    expect(nv?.keyName).toBe("ThemeKey");
  });

  it("captures multiple computed properties in one EnvironmentValues extension", () => {
    const source = `
extension EnvironmentValues {
    var theme: Theme {
        get { self[ThemeKey.self] }
        set { self[ThemeKey.self] = newValue }
    }
    var typography: TypographyScale {
        get { self[TypographyKey.self] }
        set { self[TypographyKey.self] = newValue }
    }
}
`;
    const findings = extractTheme(source, FIXTURE_PATH);
    const themeFind = findings.find((f) => f.declName === "theme");
    const typoFind = findings.find((f) => f.declName === "typography");

    expect(themeFind).toBeDefined();
    expect(typoFind).toBeDefined();

    const typoNv = typoFind?.normalizedValue as {
      keyName: string | undefined;
      valueType: string;
    } | null;
    expect(typoNv?.valueType).toBe("TypographyScale");
    expect(typoNv?.keyName).toBe("TypographyKey");
  });
});

// === Pattern 3: @Entry macro (iOS 18+) ===

describe("theme parser — @Entry macro", () => {
  it("extracts @Entry var with propertyName, valueType, and defaultValue", () => {
    const source = `
extension EnvironmentValues {
    @Entry var theme: Theme = .default
}
`;
    const findings = extractTheme(source, FIXTURE_PATH);
    const finding = findings.find((f) => f.declName === "theme");

    expect(finding).toBeDefined();
    expect(finding?.category).toBe("theme");
    expect(finding?.context).toBe("@Entry macro");
    expect(finding?.isDeclaration).toBe(true);

    const nv = finding?.normalizedValue as {
      pattern: string;
      propertyName: string;
      valueType: string;
      defaultValue: string;
    } | null;
    expect(nv?.pattern).toBe("Entry-macro");
    expect(nv?.propertyName).toBe("theme");
    expect(nv?.valueType).toBe("Theme");
    expect(nv?.defaultValue).toBe(".default");
  });

  it("extracts multiple @Entry properties from one extension block", () => {
    const source = `
extension EnvironmentValues {
    @Entry var colorScheme: AppColorScheme = .brand
    @Entry var spacing: SpacingScale = .regular
}
`;
    const findings = extractTheme(source, FIXTURE_PATH);
    const csFind = findings.find((f) => f.declName === "colorScheme");
    const spFind = findings.find((f) => f.declName === "spacing");

    expect(csFind).toBeDefined();
    expect(spFind).toBeDefined();

    const csNv = csFind?.normalizedValue as { defaultValue: string } | null;
    expect(csNv?.defaultValue).toBe(".brand");

    const spNv = spFind?.normalizedValue as { defaultValue: string } | null;
    expect(spNv?.defaultValue).toBe(".regular");
  });

  it("does NOT confuse @Entry properties with plain computed properties", () => {
    const source = `
extension EnvironmentValues {
    @Entry var theme: Theme = .default
    var legacyTheme: Theme {
        get { self[LegacyThemeKey.self] }
        set { self[LegacyThemeKey.self] = newValue }
    }
}
`;
    const findings = extractTheme(source, FIXTURE_PATH);
    const entryFind = findings.find((f) => f.context === "@Entry macro");
    const extensionFind = findings.find((f) => f.context === "extension EnvironmentValues");

    expect(entryFind).toBeDefined();
    expect(extensionFind).toBeDefined();
    // They must refer to different property names
    expect(entryFind?.declName).toBe("theme");
    expect(extensionFind?.declName).toBe("legacyTheme");
  });
});

// === Pattern 4: @Observable theme provider class ===

describe("theme parser — @Observable provider class", () => {
  it("extracts an @Observable class with its var properties", () => {
    const source = `
@Observable final class ThemeProvider {
    var colorScheme: AppColorScheme = .brand
    var radiusScale: RadiusScale = .rounded
}
`;
    const findings = extractTheme(source, FIXTURE_PATH);
    const finding = findings.find((f) => f.declName === "ThemeProvider");

    expect(finding).toBeDefined();
    expect(finding?.category).toBe("theme");
    expect(finding?.context).toBe("@Observable class");
    expect(finding?.isDeclaration).toBe(true);

    const nv = finding?.normalizedValue as {
      pattern: string;
      properties: Array<{ name: string; type: string }>;
      tier?: string;
    } | null;
    expect(nv?.pattern).toBe("Observable-provider");
    expect(nv?.properties).toHaveLength(2);
    expect(nv?.properties.map((p) => p.name)).toContain("colorScheme");
    expect(nv?.properties.map((p) => p.name)).toContain("radiusScale");

    const csEntry = nv?.properties.find((p) => p.name === "colorScheme");
    expect(csEntry?.type).toBe("AppColorScheme");
  });

  it("does NOT extract a class missing the @Observable attribute", () => {
    const source = `
final class PlainClass {
    var colorScheme: AppColorScheme = .brand
}
`;
    const findings = extractTheme(source, FIXTURE_PATH);
    const finding = findings.find((f) => f.declName === "PlainClass");
    expect(finding).toBeUndefined();
  });
});

// === Pattern 5: FluentUI tier hints ===

describe("theme parser — FluentUI tier hints", () => {
  it("adds tier 'global' when a property is named globalTokens", () => {
    const source = `
@Observable final class FluentTheme {
    var globalTokens: GlobalTokens = GlobalTokens()
    var aliasTokens: AliasTokens = AliasTokens()
}
`;
    const findings = extractTheme(source, FIXTURE_PATH);
    const finding = findings.find((f) => f.declName === "FluentTheme");

    expect(finding).toBeDefined();
    const nv = finding?.normalizedValue as { tier?: string } | null;
    // tier is set to the first matching property — "global" from globalTokens
    expect(nv?.tier).toBe("global");
  });

  it("adds tier 'alias' when property is aliasTokens (and no global tokens present)", () => {
    const source = `
@Observable final class AliasTheme {
    var aliasTokens: AliasTokens = AliasTokens()
    var controlTokens: ControlTokens = ControlTokens()
}
`;
    const findings = extractTheme(source, FIXTURE_PATH);
    const finding = findings.find((f) => f.declName === "AliasTheme");

    expect(finding).toBeDefined();
    const nv = finding?.normalizedValue as { tier?: string } | null;
    expect(nv?.tier).toBe("alias");
  });

  it("adds tier 'control' when property is controlTokens (no global/alias present)", () => {
    const source = `
@Observable final class ButtonTheme {
    var controlTokens: ButtonTokens = ButtonTokens()
}
`;
    const findings = extractTheme(source, FIXTURE_PATH);
    const finding = findings.find((f) => f.declName === "ButtonTheme");

    expect(finding).toBeDefined();
    const nv = finding?.normalizedValue as { tier?: string } | null;
    expect(nv?.tier).toBe("control");
  });

  it("does NOT add tier when no tier-hinting property names are present", () => {
    const source = `
@Observable final class SimpleTheme {
    var primaryColor: Color = .blue
    var cornerRadius: CGFloat = 8
}
`;
    const findings = extractTheme(source, FIXTURE_PATH);
    const finding = findings.find((f) => f.declName === "SimpleTheme");

    expect(finding).toBeDefined();
    const nv = finding?.normalizedValue as { tier?: string } | null;
    expect(nv?.tier).toBeUndefined();
  });
});

// === Integration: multiple patterns coexisting in one file ===

describe("theme parser — integration (full theme file)", () => {
  it("extracts all pattern types from a realistic ThemeProvider.swift", () => {
    const source = `
import SwiftUI

private struct ThemeKey: EnvironmentKey {
    static let defaultValue: Theme = .default
}

extension EnvironmentValues {
    var theme: Theme {
        get { self[ThemeKey.self] }
        set { self[ThemeKey.self] = newValue }
    }
}

extension EnvironmentValues {
    @Entry var accentScale: AccentScale = .standard
}

@Observable final class ThemeProvider {
    var colorScheme: AppColorScheme = .brand
    var radiusScale: RadiusScale = .rounded
}
`;
    const findings = extractTheme(source, FIXTURE_PATH);

    // All four patterns should produce findings
    const envKeyFind = findings.find((f) => f.context === "struct EnvironmentKey");
    const extFind = findings.find((f) => f.context === "extension EnvironmentValues");
    const entryFind = findings.find((f) => f.context === "@Entry macro");
    const observableFind = findings.find((f) => f.context === "@Observable class");

    expect(envKeyFind).toBeDefined();
    expect(extFind).toBeDefined();
    expect(entryFind).toBeDefined();
    expect(observableFind).toBeDefined();

    // All are isDeclaration: true
    for (const f of findings) {
      expect(f.isDeclaration).toBe(true);
      expect(f.category).toBe("theme");
      expect(f.sourcePath).toBe(FIXTURE_PATH);
    }
  });

  it("returns empty array for a file with no theme infrastructure", () => {
    const source = `
import SwiftUI

struct MyView: View {
    var body: some View {
        Text("Hello, World!")
    }
}
`;
    const findings = extractTheme(source, FIXTURE_PATH);
    expect(findings).toHaveLength(0);
  });
});
