import SwiftUI

// MARK: - Color Token Declarations

extension Color {
    // 1. sRGB component declarations
    static let brandPrimary = Color(.sRGB, red: 0.067, green: 0.537, blue: 1.0, opacity: 1)
    static let surfaceDark = Color(red: 0.102, green: 0.110, blue: 0.118)

    // 2. Hex literal declarations via custom init
    static let accent = Color(hex: "#1A88FF")

    // 3. Asset Catalog reference
    static let background = Color("AppBackground")

    // 4. UIColor semantic bridge
    static let tintMuted = Color(uiColor: UIColor.systemIndigo)

    // 5. System alias — must NOT be concretized
    static let interactive = Color.accentColor
}

// MARK: - Adaptive (light/dark) Color

extension Color {
    init(light: Color, dark: Color) {
        self = Color(UIColor { $0.userInterfaceStyle == .dark ? UIColor(dark) : UIColor(light) })
    }

    static let surface = Color(light: .white, dark: Color(hex: "#1A1C1E"))
}

// MARK: - Call Sites with Hex Literals (drift candidates)

struct FeedRow: View {
    var body: some View {
        HStack {
            Text("Title")
                .foregroundStyle(Color.brandPrimary)
            // Inline hex — magic number, should be replaced with a token
            Rectangle()
                .fill(Color(hex: "#1A1D1F"))  // Near-duplicate of surfaceDark
        }
    }
}

struct HeaderView: View {
    @Environment(\.colorScheme) var colorScheme

    var cardBg: Color {
        colorScheme == .dark ? Color.surfaceDark : Color.surfaceLight
    }

    var body: some View {
        ZStack {
            cardBg
            Text("Header")
        }
    }
}

// MARK: - Orphaned token (declared but never used at call sites in this file)
extension Color {
    static let deprecated = Color(red: 0.5, green: 0.5, blue: 0.5)
}
