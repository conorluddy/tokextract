/**
 * analyzers/diff.ts
 *
 * Structural diff between two DTCG tokens.json objects.
 * Compares leaves (any object with a $value field) by dot-path, detecting
 * additions, removals, and per-field changes to $value, $description, $type.
 *
 * Output is stable and deterministic (sorted by path). Designed to be consumed
 * by the audit.md emitter (T3.4) via formatDiffMarkdown.
 */

// === PUBLIC API ===

export interface TokenChange {
  readonly path: string;
  readonly kind: "added" | "removed" | "value-changed" | "description-changed" | "type-changed";
  readonly before?: unknown;
  readonly after?: unknown;
}

export interface TokenDiff {
  readonly added: readonly TokenChange[];
  readonly removed: readonly TokenChange[];
  readonly changed: readonly TokenChange[];
  readonly totalCount: number;
}

/**
 * Diff two DTCG tokens.json structures.
 *
 * Walks both trees recursively, collecting leaves (objects with $value) by
 * dot-path. Set-differences the paths to find additions and removals; for
 * shared paths, compares $value, $description, and $type field by field.
 *
 * Output is deterministically sorted by path.
 */
export function diffTokens(previous: unknown, current: unknown): TokenDiff {
  const previousLeaves = collectLeaves(previous, "");
  const currentLeaves = collectLeaves(current, "");

  const previousPaths = new Set(previousLeaves.keys());
  const currentPaths = new Set(currentLeaves.keys());

  const added: TokenChange[] = [];
  const removed: TokenChange[] = [];
  const changed: TokenChange[] = [];

  // Additions: paths in current but not previous
  for (const path of currentPaths) {
    if (!previousPaths.has(path)) {
      const leaf = currentLeaves.get(path) as Record<string, unknown>;
      added.push({ path, kind: "added", after: leaf.$value });
    }
  }

  // Removals: paths in previous but not current
  for (const path of previousPaths) {
    if (!currentPaths.has(path)) {
      const leaf = previousLeaves.get(path) as Record<string, unknown>;
      removed.push({ path, kind: "removed", before: leaf.$value });
    }
  }

  // Changes: paths in both — compare $value, $description, $type
  for (const path of previousPaths) {
    if (!currentPaths.has(path)) continue;

    const beforeLeaf = previousLeaves.get(path) as Record<string, unknown>;
    const afterLeaf = currentLeaves.get(path) as Record<string, unknown>;

    const valueChange = compareField("$value", beforeLeaf, afterLeaf);
    if (valueChange !== null) {
      changed.push({ path, kind: "value-changed", ...valueChange });
    }

    const descriptionChange = compareField("$description", beforeLeaf, afterLeaf);
    if (descriptionChange !== null) {
      changed.push({ path, kind: "description-changed", ...descriptionChange });
    }

    const typeChange = compareField("$type", beforeLeaf, afterLeaf);
    if (typeChange !== null) {
      changed.push({ path, kind: "type-changed", ...typeChange });
    }
  }

  // Stable, deterministic sort by path
  added.sort(byPath);
  removed.sort(byPath);
  changed.sort(byPath);

  return {
    added,
    removed,
    changed,
    totalCount: added.length + removed.length + changed.length,
  };
}

/**
 * Format a TokenDiff as a markdown section suitable for inclusion in audit.md.
 *
 * Produces a "## Changes since last extraction" block summarising additions,
 * removals, and changed values. T3.4 imports and calls this during audit emit.
 */
export function formatDiffMarkdown(diff: TokenDiff): string {
  if (diff.totalCount === 0) {
    return "## Changes since last extraction\n\nNo changes detected.\n";
  }

  const lines: string[] = [
    "## Changes since last extraction",
    "",
    `**${diff.added.length} token${diff.added.length === 1 ? "" : "s"} added** · **${diff.removed.length} removed** · **${diff.changed.length} changed**`,
  ];

  if (diff.added.length > 0) {
    lines.push("", "### Added");
    for (const change of diff.added) {
      lines.push(`- \`${change.path}\` — new \`$value\`: ${formatValue(change.after)}`);
    }
  }

  if (diff.removed.length > 0) {
    lines.push("", "### Removed");
    for (const change of diff.removed) {
      lines.push(`- \`${change.path}\``);
    }
  }

  if (diff.changed.length > 0) {
    lines.push("", "### Changed");
    for (const change of diff.changed) {
      const fieldLabel =
        change.kind === "value-changed"
          ? "$value"
          : change.kind === "description-changed"
            ? "$description"
            : "$type";
      lines.push(
        `- \`${change.path}\` — \`${fieldLabel}\`: ${formatValue(change.before)} → ${formatValue(change.after)}`,
      );
    }
  }

  lines.push("");
  return lines.join("\n");
}

// === PRIVATE HELPERS ===

type DtcgLeafMap = Map<string, Record<string, unknown>>;

/**
 * Walk a DTCG token tree recursively, collecting leaf nodes (objects with
 * a $value field) keyed by their dot-path.
 *
 * Non-object values and null are skipped. Paths starting with "$" are DTCG
 * fields on a token — they are not recursed into.
 */
function collectLeaves(node: unknown, prefix: string): DtcgLeafMap {
  const result: DtcgLeafMap = new Map();

  if (typeof node !== "object" || node === null) return result;

  const record = node as Record<string, unknown>;

  // This node is a DTCG token leaf if it has a $value field
  if ("$value" in record) {
    result.set(prefix, record);
    return result;
  }

  // Otherwise recurse into non-$ keys ($ keys are group-level DTCG metadata)
  for (const [key, value] of Object.entries(record)) {
    if (key.startsWith("$")) continue;

    const childPath = prefix.length > 0 ? `${prefix}.${key}` : key;
    const childLeaves = collectLeaves(value, childPath);
    for (const [leafPath, leaf] of childLeaves) {
      result.set(leafPath, leaf);
    }
  }

  return result;
}

interface FieldDiff {
  readonly before: unknown;
  readonly after: unknown;
}

/**
 * Compare a single DTCG field between two leaf objects.
 * Returns null if the values are deeply equal (or both absent).
 */
function compareField(
  field: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): FieldDiff | null {
  const beforeValue = field in before ? before[field] : undefined;
  const afterValue = field in after ? after[field] : undefined;

  if (deepEqual(beforeValue, afterValue)) return null;

  return { before: beforeValue, after: afterValue };
}

/**
 * Deep equality check for JSON-compatible values.
 * Uses JSON serialisation for structural comparison — sufficient for DTCG
 * token values (color objects, strings, numbers) with no circular references.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object" || a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function byPath(a: TokenChange, b: TokenChange): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

function formatValue(value: unknown): string {
  if (value === undefined) return "(absent)";
  if (typeof value === "string") return `"${value}"`;
  return JSON.stringify(value);
}
