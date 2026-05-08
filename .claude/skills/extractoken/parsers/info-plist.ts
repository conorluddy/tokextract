/**
 * parsers/info-plist.ts
 *
 * Extracts CFBundleIdentifier from an Info.plist file in the target repo.
 * Used by T3.5 to derive a vendor namespace for $extensions.<vendor>.*
 * DTCG extension keys.
 *
 * Strategy:
 * 1. Walk the repo for Info.plist files (depth-first, stop at first found)
 * 2. Parse the XML plist format hand-written (avoids a heavy plist npm dep)
 * 3. Return CFBundleIdentifier string, or null if not found
 *
 * Caller falls back to `com.unknown.<dirname>` when null is returned.
 *
 * Hand-parsing is safe here: Info.plist CFBundleIdentifier is always a
 * top-level <key>CFBundleIdentifier</key><string>...</string> pair — no
 * nesting required.
 */

import fs from "node:fs";
import path from "node:path";
import glob from "fast-glob";

// === PUBLIC API ===

/**
 * Walk repoPath for an Info.plist file and extract CFBundleIdentifier.
 * Returns the bundle ID string (e.g. "com.example.MyApp"), or null.
 */
export function extractBundleId(repoPath: string): string | null {
  const plistPath = findInfoPlist(repoPath);
  if (!plistPath) return null;

  try {
    const content = fs.readFileSync(plistPath, "utf-8");
    return parseBundleId(content);
  } catch {
    return null;
  }
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
