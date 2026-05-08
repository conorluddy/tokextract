/**
 * parsers/info-plist.ts
 *
 * Extracts the target app's bundle identifier for use as the vendor namespace
 * in DTCG `$extensions.<vendor>.*` keys.
 *
 * Strategy (in order of preference):
 * 1. Info.plist `CFBundleIdentifier` — older Xcode projects store it here.
 * 2. `.xcodeproj/project.pbxproj` `PRODUCT_BUNDLE_IDENTIFIER` — modern Xcode
 *    (Xcode 13+) sets the bundle ID in build settings, not Info.plist. Multi-target
 *    projects have several entries (main / Watch / Widgets / Complications);
 *    we pick the shortest one without a target-extension suffix.
 * 3. Return null. Caller falls back to `com.unknown.<dirname>`.
 *
 * Both fallbacks use lightweight string parsing — no heavy plist/xcodeproj deps.
 */

import fs from "node:fs";
import path from "node:path";
import glob from "fast-glob";

// === PUBLIC API ===

/**
 * Extract a bundle identifier from the target repo to use as a vendor namespace.
 * Tries Info.plist `CFBundleIdentifier` first; falls back to `.xcodeproj/project.pbxproj`
 * `PRODUCT_BUNDLE_IDENTIFIER` (modern Xcode default).
 */
export function extractBundleId(repoPath: string): string | null {
  // Path 1: Info.plist CFBundleIdentifier
  const plistPath = findInfoPlist(repoPath);
  if (plistPath) {
    try {
      const content = fs.readFileSync(plistPath, "utf-8");
      const fromPlist = parseBundleId(content);
      if (fromPlist) return fromPlist;
    } catch {
      // fall through
    }
  }

  // Path 2: .xcodeproj/project.pbxproj PRODUCT_BUNDLE_IDENTIFIER
  return extractFromXcodeProject(repoPath);
}

// === PRIVATE HELPERS ===

/**
 * Find the first Info.plist in the repo.
 * Prefers non-DerivedData, non-Pods paths.
 * Uses fast-glob's sync API via the underlying glob.sync wrapper.
 */
function findInfoPlist(repoPath: string): string | null {
  // Priority: project root or immediate subdirectory Info.plist first
  const priorityPaths = [
    path.join(repoPath, "Info.plist"),
    // Common pattern: <AppName>/Info.plist
  ];

  for (const p of priorityPaths) {
    if (fs.existsSync(p)) return p;
  }

  // Broader search — but ignore common build/vendor dirs
  try {
    const found = glob.sync("**/Info.plist", {
      cwd: repoPath,
      absolute: true,
      followSymbolicLinks: false,
      ignore: [
        "**/DerivedData/**",
        "**/Pods/**",
        "**/node_modules/**",
        "**/.build/**",
        "**/build/**",
      ],
    });

    // Prefer shorter paths (closer to root) to avoid test-target plists
    if (found.length === 0) return null;

    const sorted = [...found].sort((a, b) => {
      const depthA = a.split(path.sep).length;
      const depthB = b.split(path.sep).length;
      return depthA - depthB;
    });

    return sorted[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Parse CFBundleIdentifier from an Info.plist XML string.
 *
 * Info.plist XML has the structure:
 *   <dict>
 *     ...
 *     <key>CFBundleIdentifier</key>
 *     <string>com.example.App</string>
 *     ...
 *   </dict>
 *
 * We use a simple regex rather than a full XML parser — the key is always
 * a top-level pair and the value is always a plain <string> element.
 */
function parseBundleId(content: string): string | null {
  // Match the CFBundleIdentifier key followed by a <string> value
  // Allow for optional whitespace/newlines between elements
  const match = /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/.exec(content);

  if (!match || !match[1]) return null;

  const bundleId = match[1].trim();

  // Validate that it looks like a bundle ID (at least one dot, no whitespace)
  if (!bundleId.includes(".") || /\s/.test(bundleId)) return null;

  return bundleId;
}

/**
 * Extract a PRODUCT_BUNDLE_IDENTIFIER from the target's `.xcodeproj/project.pbxproj`.
 * Multi-target projects list several IDs; we pick the shortest one without a known
 * extension-target suffix (`.watchkitapp`, `.widgets`, `.complications`, `.tests`,
 * `.uitests`, `.notification`, `.intent`, `.share`).
 */
function extractFromXcodeProject(repoPath: string): string | null {
  let pbxproj: string;
  try {
    const projects = glob.sync("**/*.xcodeproj/project.pbxproj", {
      cwd: repoPath,
      absolute: true,
      followSymbolicLinks: false,
      ignore: ["**/Pods/**", "**/.build/**", "**/DerivedData/**", "**/build/**"],
    });
    if (projects.length === 0) return null;
    // Prefer shorter paths (closer to root)
    const sorted = [...projects].sort(
      (a, b) => a.split(path.sep).length - b.split(path.sep).length,
    );
    const target = sorted[0];
    if (!target) return null;
    pbxproj = fs.readFileSync(target, "utf-8");
  } catch {
    return null;
  }

  const ids = new Set<string>();
  const pattern = /PRODUCT_BUNDLE_IDENTIFIER\s*=\s*([^\s;]+);/g;
  for (const match of pbxproj.matchAll(pattern)) {
    const id = match[1]?.trim().replace(/^["']|["']$/g, "");
    if (!id || !id.includes(".") || /\s/.test(id) || id.startsWith("$")) continue;
    ids.add(id);
  }
  if (ids.size === 0) return null;

  const EXTENSION_SUFFIXES = [
    ".watchkitapp",
    ".widgets",
    ".widget",
    ".complications",
    ".tests",
    ".uitests",
    ".notification",
    ".intent",
    ".share",
    ".extension",
  ];
  const candidates = [...ids].filter(
    (id) => !EXTENSION_SUFFIXES.some((suffix) => id.toLowerCase().includes(suffix)),
  );
  // Prefer non-extension; fall back to all if filter eliminates everything
  const pool = candidates.length > 0 ? candidates : [...ids];
  // Pick the shortest — main app IDs are typically the shortest in a multi-target
  pool.sort((a, b) => a.length - b.length);
  return pool[0] ?? null;
}
