import SwiftUI

// Pattern 1 + 2: extension Color aliasing an Asset Catalog entry, with bundle: .module
public extension Color {
    static let ocrasFasting = Color("OcrasFasting", bundle: .module)
    static let ocrasEating = Color("OcrasEating", bundle: .module)
    static let ocrasBackground = Color("OcrasBackground", bundle: .module)
}

// Pattern 3: hex-byte arithmetic in Color(.sRGB,...)
public extension Color {
    static let ocrasInkDark = Color(.sRGB, red: 0xF3 / 255, green: 0xEE / 255, blue: 0xE4 / 255, opacity: 1)
    static let ocrasSurfaceDark = Color(.sRGB, red: 0x1A / 255, green: 0x1A / 255, blue: 0x1C / 255, opacity: 1)
}

// Pattern 4: enum X { static let *Name = "FontName" } typography abstraction
public enum WidgetFont {
    public static let heroDisplayName = "SpaceGrotesk-Bold"
    public static let bodyName = "SpaceGrotesk-Medium"
    public static let monoName = "AzeretMono-Medium"
}
