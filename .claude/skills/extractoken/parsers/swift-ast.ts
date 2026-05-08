/**
 * parsers/swift-ast.ts
 *
 * Tree-sitter-swift bootstrap. Exposes two public primitives used by all
 * category parsers:
 *   - parseSource(source): Tree
 *   - runQuery(tree, queryString): QueryMatch[]
 *
 * Design note: both functions are intentionally thin wrappers. Category parsers
 * own query strings; this module owns grammar loading and error handling only.
 *
 * The underlying tree-sitter grammar (alex-pinkus/tree-sitter-swift) parses
 * extensions as `class_declaration` nodes — not `extension_declaration`. All
 * queries must use the actual grammar node types, not Swift keyword names.
 */

// tree-sitter is a CommonJS module; we use createRequire for ESM compatibility.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const TreeSitter = require("tree-sitter");
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const SwiftGrammar = require("tree-sitter-swift");

// We keep one shared parser instance — tree-sitter parsers are not thread-safe,
// but Node is single-threaded so reuse is safe.
// eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment
const sharedParser = new TreeSitter();
// eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
sharedParser.setLanguage(SwiftGrammar);

// Re-export the Language object so callers can build Query objects directly.
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
export const SwiftLanguage: unknown = SwiftGrammar;

/** Opaque tree type from tree-sitter. Category parsers treat it as a black box. */
export type Tree = {
  readonly rootNode: SyntaxNode;
};

/** A tree-sitter syntax node */
export type SyntaxNode = {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  children: SyntaxNode[];
  childCount: number;
  parent: SyntaxNode | null;
  isNamed: boolean;
  toString(): string;
};

/** A named capture from a tree-sitter query match */
export interface Capture {
  readonly name: string;
  readonly node: SyntaxNode;
}

/** A single query match containing all its captures */
export interface QueryMatch {
  readonly pattern: number;
  readonly captures: readonly Capture[];
}

/**
 * Parse Swift source text into a tree-sitter Tree.
 * Throws if parsing fails entirely (should be rare; tree-sitter is error-tolerant
 * and will produce a partial tree even for malformed Swift).
 */
export function parseSource(source: string): Tree {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
  const tree = sharedParser.parse(source) as Tree;
  if (!tree?.rootNode) {
    throw new Error("tree-sitter failed to produce a parse tree — source may be empty");
  }
  return tree;
}

/**
 * Module-level query cache — reuses compiled Query objects across calls.
 *
 * tree-sitter Query compilation is expensive (~17ms per Query on apple silicon).
 * With 727 files × ~12 unique query strings, re-compiling every call cost
 * ~37 seconds on Grapla. This cache drops that to a one-time cost of <1s.
 *
 * The cache is keyed on the query string text. Since query strings are
 * compile-time constants in the parsers, the cache naturally stays bounded.
 */
/** Compiled tree-sitter Query — opaque object, only `.matches(node)` is called */
interface CompiledQuery {
  // biome-ignore lint/suspicious/noExplicitAny: tree-sitter Query has no exported TypeScript type
  matches(node: any): QueryMatch[];
}
const queryCache = new Map<string, CompiledQuery>();

/**
 * Run a tree-sitter S-expression query against a parsed tree.
 *
 * IMPORTANT: Query strings must use the grammar's internal node type names, which
 * differ from Swift keywords. Key mappings:
 *   - `extension Foo { ... }` → `class_declaration` (not extension_declaration)
 *   - Extension name          → `name: (user_type (type_identifier))`
 *   - Extension body          → `body: (class_body ...)`
 *   - `static let x = ...`   → `property_declaration` with `(modifiers (property_modifier))`
 *   - Property name           → `name: (pattern (simple_identifier))`
 *   - Init call               → `(call_expression (simple_identifier) (call_suffix ...))`
 *
 * Query objects are cached by their source string so compilation happens only once
 * per unique query string across the entire parse run. This is the primary S3.5
 * performance fix — compilation was ~17ms per call, now ~0ms for cached queries.
 *
 * Throws on query syntax error (always a code defect).
 */
export function runQuery(tree: Tree, queryString: string): QueryMatch[] {
  try {
    // Retrieve or compile the query — normalize whitespace so minor formatting
    // differences in the caller don't create duplicate cache entries.
    const cacheKey = queryString.trim().replace(/\s+/g, " ");
    const existing = queryCache.get(cacheKey);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    const query: CompiledQuery = existing ?? new TreeSitter.Query(SwiftGrammar, queryString);
    if (!existing) queryCache.set(cacheKey, query);
    return query.matches(tree.rootNode) as QueryMatch[];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Surface query syntax errors clearly — they're always a code defect, not
    // a runtime failure, so we include the full query for diagnosis.
    throw new Error(`tree-sitter query failed: ${message}\nQuery was:\n${queryString}`);
  }
}

/**
 * Convenience: find the first capture with a given name from a match's captures.
 * Returns null if the capture is absent (some patterns have optional captures).
 */
export function getCapture(match: QueryMatch, captureName: string): SyntaxNode | null {
  return match.captures.find((c) => c.name === captureName)?.node ?? null;
}

/**
 * Return 1-based line number from a tree-sitter node.
 * tree-sitter rows are 0-based; we expose 1-based for all public APIs.
 */
export function nodeLineNumber(node: SyntaxNode): number {
  return node.startPosition.row + 1;
}

/**
 * Return 0-based column from a tree-sitter node (column is already 0-based in tree-sitter).
 */
export function nodeColumn(node: SyntaxNode): number {
  return node.startPosition.column;
}
