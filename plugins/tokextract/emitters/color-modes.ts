/**
 * emitters/color-modes.ts
 *
 * Shared helper for building DTCG `$modes` blocks from a finding's color
 * variants. Currently emits only `dark` — high-contrast and gamut variants
 * land in a follow-up.
 */

import type { CandidateToken, RawFinding } from "../parsers/types.js";

/**
 * Build a DTCG `$modes` object from a finding's dark-mode color variant.
 * Returns `null` when the finding isn't a color or has no dark variant —
 * callers should spread conditionally so non-adaptive tokens don't gain
 * an empty `$modes` key.
 */
export function buildColorModes(finding: RawFinding): CandidateToken["$modes"] | null {
  if (finding.category !== "color") return null;
  const dark = finding.darkValue;
  if (!dark) return null;
  return {
    dark: {
      $value: {
        colorSpace: dark.colorSpace,
        components: [dark.r, dark.g, dark.b, dark.a],
      },
    },
  };
}
