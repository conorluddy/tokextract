/**
 * parsers/component.ts
 *
 * Component token extractor for SwiftUI design system extraction.
 *
 * === WHAT THIS PARSER HANDLES ===
 *
 * 1. `struct Foo: ButtonStyle { func makeBody(...) -> some View { ... } }`
 *    — Records protocol conformance + walks makeBody modifier chain.
 *
 * 2. `struct Foo: ViewModifier { func body(content:) -> some View { ... } }`
 *    — Same: records protocol conformance + walks body modifier chain.
 *
 * 3. `struct Foo: PrimitiveButtonStyle { func makeBody(...) -> some View { ... } }`
 *    — Same pattern as ButtonStyle.
 *
 * 4. `extension View { func someStyle() -> some View { modifier(...) } }`
 *    — Convenience wrappers. Emits with declName = function name, protocol = "View",
 *      and captures the inner modifier(...) call.
 *
 * 5. Custom `View` structs wrapping a single primary native view call.
 *    — Captures modifier chain from `var body: some View { ... }` when the body
 *      is single-rooted (one outermost view call). Multi-view roots (HStack/VStack)
 *      emit with modifierChain: [].
 *
 * === WHAT THIS PARSER DOES NOT HANDLE ===
 *
 * - Conditional modifiers like `.if(condition) { ... }` — recorded in rawValue only.
 * - LLM normalization — that's llm/normalize.ts.
 * - Component round-trip verification — that's the emitter layer.
 *
 * === NODE TYPE NOTES ===
 *
 * tree-sitter-swift parses both `extension Foo { }` and `struct Foo: Protocol { }`
 * as `class_declaration`. They differ in name node type:
 *   - `struct Foo: Protocol` → `name: (type_identifier)`   (plain identifier)
 *   - `extension View`       → `name: (user_type (type_identifier))`
 *
 * Inheritance/conformance appears under `(inheritance_specifier inherits_from: ...)`.
 */

import path from "node:path";
import { getCapture, nodeColumn, nodeLineNumber, parseSource, runQuery } from "./swift-ast.js";
import type { RawFinding } from "./types.js";

// Protocols that signal component-level token declarations
const COMPONENT_PROTOCOLS = new Set(["ButtonStyle", "ViewModifier", "PrimitiveButtonStyle"]);

// Layout container view types — bodies rooted in these are multi-view (no single chain)
const LAYOUT_CONTAINERS = new Set([
  "HStack",
  "VStack",
  "ZStack",
  "LazyHStack",
  "LazyVStack",
  "LazyHGrid",
  "LazyVGrid",
  "Grid",
  "List",
  "ScrollView",
  "Form",
  "Group",
  "Section",
  "GeometryReader",
  "NavigationStack",
  "NavigationSplitView",
  "TabView",
]);

// === PUBLIC API ===

/**
 * Extract component findings from a single Swift source file.
 *
 * @param source   Raw Swift source text
 * @param filePath Absolute path to the source file — used for provenance in findings
 * @returns        Array of RawFinding objects (may be empty)
 */
export function extractComponents(source: string, filePath: string): RawFinding[] {
  const relativePath = normalizeFilePath(filePath);
  const findings: RawFinding[] = [];

  // Pass 1: ButtonStyle / ViewModifier / PrimitiveButtonStyle structs
  const styleStructFindings = extractStyleProtocolStructs(source, relativePath);
  findings.push(...styleStructFindings);

  // Pass 2: extension View convenience wrapper functions
  const extensionViewFindings = extractExtensionViewWrappers(source, relativePath);
  findings.push(...extensionViewFindings);

  // Pass 3: Custom View structs wrapping a single primary native view
  const customViewFindings = extractCustomViewStructs(source, relativePath);
  findings.push(...customViewFindings);

  return findings;
}

// === PRIVATE HELPERS ===

/**
 * Extract ButtonStyle / ViewModifier / PrimitiveButtonStyle struct declarations.
 * Walks makeBody / body function to collect the modifier chain.
 */
function extractStyleProtocolStructs(source: string, filePath: string): RawFinding[] {
  const tree = parseSource(source);
  const findings: RawFinding[] = [];

  // Query: struct conforming to a known component protocol with a function body
  // Note: struct name = type_identifier (not user_type), protocol in inheritance_specifier
  const query = `
    (class_declaration
      name: (type_identifier) @struct_name
      (inheritance_specifier
        inherits_from: (user_type (type_identifier) @protocol))
      body: (class_body
        (function_declaration
          name: (simple_identifier) @fn_name
          body: (function_body) @fn_body
        )
      )
    )
  `;

  let matches: ReturnType<typeof runQuery>;
  try {
    matches = runQuery(tree, query);
  } catch {
    return [];
  }

  for (const match of matches) {
    const structNameNode = getCapture(match, "struct_name");
    const protocolNode = getCapture(match, "protocol");
    const fnNameNode = getCapture(match, "fn_name");
    const fnBodyNode = getCapture(match, "fn_body");

    if (!structNameNode || !protocolNode || !fnNameNode || !fnBodyNode) continue;

    const protocolName = protocolNode.text;
    if (!COMPONENT_PROTOCOLS.has(protocolName)) continue;

    // Only capture the primary rendering function
    const fnName = fnNameNode.text;
    const isRenderFn = fnName === "makeBody" || fnName === "body";
    if (!isRenderFn) continue;

    const declName = structNameNode.text;
    const bodyText = fnBodyNode.text;
    const modifierChain = extractModifierChain(bodyText);

    findings.push({
      category: "component",
      sourcePath: filePath,
      line: nodeLineNumber(structNameNode),
      col: nodeColumn(structNameNode),
      declName,
      rawValue: bodyText,
      normalizedValue: null,
      context: `struct ${protocolName}`,
      isDeclaration: true,
      modifierChain,
    });
  }

  return findings;
}

/**
 * Extract `extension View { func someStyle() -> some View { ... } }` convenience wrappers.
 * These are identified by the extension name being "View" (user_type node, not type_identifier).
 */
function extractExtensionViewWrappers(source: string, filePath: string): RawFinding[] {
  const tree = parseSource(source);
  const findings: RawFinding[] = [];

  // Query: extension View (name is user_type, not type_identifier) with function declarations
  const query = `
    (class_declaration
      name: (user_type (type_identifier) @ext_name)
      body: (class_body
        (function_declaration
          name: (simple_identifier) @fn_name
          body: (function_body) @fn_body
        )
      )
    )
  `;

  let matches: ReturnType<typeof runQuery>;
  try {
    matches = runQuery(tree, query);
  } catch {
    return [];
  }

  for (const match of matches) {
    const extNameNode = getCapture(match, "ext_name");
    const fnNameNode = getCapture(match, "fn_name");
    const fnBodyNode = getCapture(match, "fn_body");

    if (!extNameNode || !fnNameNode || !fnBodyNode) continue;
    if (extNameNode.text !== "View") continue;

    const fnName = fnNameNode.text;
    const bodyText = fnBodyNode.text;

    // Capture the inner modifier(...) call text as rawValue — use balanced paren
    // extraction to correctly handle nested calls like modifier(CardModifier()).
    const rawValue = extractModifierCallText(bodyText) ?? bodyText;

    // Build modifier chain from the function body (may call modifier() or chain directly)
    const modifierChain = extractModifierChain(bodyText);

    findings.push({
      category: "component",
      sourcePath: filePath,
      line: nodeLineNumber(fnNameNode),
      col: nodeColumn(fnNameNode),
      declName: fnName,
      rawValue,
      normalizedValue: null,
      context: "extension View func",
      isDeclaration: true,
      modifierChain,
    });
  }

  return findings;
}

/**
 * Extract custom View structs that wrap a single primary native view call.
 *
 * Heuristic: a `struct Foo: View` with a `var body: some View { ... }` that contains
 * exactly one outermost view call expression (not a layout container root). Multi-view
 * bodies (HStack/VStack root) emit with modifierChain: [].
 */
function extractCustomViewStructs(source: string, filePath: string): RawFinding[] {
  const tree = parseSource(source);
  const findings: RawFinding[] = [];

  // Query: struct conforming to View with a computed body property
  // Excludes extension View (those have name: user_type, not type_identifier)
  const query = `
    (class_declaration
      name: (type_identifier) @struct_name
      (inheritance_specifier
        inherits_from: (user_type (type_identifier) @protocol))
      body: (class_body
        (property_declaration
          name: (pattern bound_identifier: (simple_identifier) @prop_name)
          computed_value: (computed_property) @body_content
        )
      )
    )
  `;

  let matches: ReturnType<typeof runQuery>;
  try {
    matches = runQuery(tree, query);
  } catch {
    return [];
  }

  for (const match of matches) {
    const structNameNode = getCapture(match, "struct_name");
    const protocolNode = getCapture(match, "protocol");
    const propNameNode = getCapture(match, "prop_name");
    const bodyContentNode = getCapture(match, "body_content");

    if (!structNameNode || !protocolNode || !propNameNode || !bodyContentNode) continue;
    if (protocolNode.text !== "View") continue;
    if (propNameNode.text !== "body") continue;

    const declName = structNameNode.text;
    const bodyText = bodyContentNode.text;

    // Determine if body is single-rooted: detect the first view call in the body
    const modifierChain = isSingleRootedBody(bodyText) ? extractModifierChain(bodyText) : [];

    findings.push({
      category: "component",
      sourcePath: filePath,
      line: nodeLineNumber(structNameNode),
      col: nodeColumn(structNameNode),
      declName,
      rawValue: bodyText,
      normalizedValue: null,
      context: "struct View custom",
      isDeclaration: true,
      modifierChain,
    });
  }

  return findings;
}

// === MODIFIER CALL EXTRACTION ===

/**
 * Find and return the full text of a `modifier(...)` call in a function body,
 * using balanced parenthesis tracking to handle nested calls like `modifier(CardModifier())`.
 * Returns null if no `modifier(` call is found.
 */
function extractModifierCallText(bodyText: string): string | null {
  const startPattern = /\bmodifier\s*\(/g;
  const match = startPattern.exec(bodyText);
  if (!match) return null;

  const openPos = match.index + match[0].length - 1;
  const closePos = findMatchingParen(bodyText, openPos);
  if (closePos === -1) return null;

  return bodyText.slice(match.index, closePos + 1);
}

// === MODIFIER CHAIN EXTRACTION ===

/**
 * Extract a modifier chain from a Swift function body text.
 *
 * Walks all `.modifierName(args)` calls in the body, with balanced parenthesis
 * tracking to correctly capture nested calls.
 *
 * Conditional modifiers (`.if(condition) { ... }`) are out of scope for v1.
 * They are detected by the presence of a trailing closure `{ ... }` following
 * the call and are excluded from the returned chain (their text is preserved
 * in the parent finding's rawValue).
 *
 * @param bodyText The text content of a function body or computed property
 */
function extractModifierChain(
  bodyText: string,
): ReadonlyArray<{ readonly name: string; readonly args: readonly string[] }> {
  const chain: Array<{ readonly name: string; readonly args: readonly string[] }> = [];

  // Regex: finds .identifierName( at any position
  const modifierMatches = [...bodyText.matchAll(/\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)];

  for (const match of modifierMatches) {
    const name = match[1];
    if (!name || match.index === undefined) continue;

    // Position of the opening paren
    const openPos = match.index + match[0].length - 1;

    // Walk to find the balanced closing paren
    const closingPos = findMatchingParen(bodyText, openPos);
    if (closingPos === -1) continue;

    const innerContent = bodyText.slice(openPos + 1, closingPos).trim();

    // Check if this modifier is followed by a trailing closure — conditional modifier pattern.
    // Look ahead for `{` after the closing paren (ignoring whitespace).
    const afterClose = bodyText.slice(closingPos + 1).trimStart();
    const isConditional = afterClose.startsWith("{");
    if (isConditional) continue;

    const args = splitArgsAtDepth0(innerContent);

    chain.push({ name, args });
  }

  return chain;
}

/**
 * Walk from an opening paren position and return the index of the matching closing paren.
 * Returns -1 if no matching paren is found (malformed source).
 */
function findMatchingParen(text: string, openPos: number): number {
  let depth = 1;
  let pos = openPos + 1;

  while (pos < text.length && depth > 0) {
    const ch = text[pos];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    pos++;
  }

  return depth === 0 ? pos - 1 : -1;
}

/**
 * Split a comma-separated argument string at depth 0.
 * Handles nested parentheses, brackets, and braces.
 * Returns an array of trimmed, non-empty argument strings.
 */
function splitArgsAtDepth0(str: string): readonly string[] {
  const args: string[] = [];
  let depth = 0;
  let start = 0;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === "," && depth === 0) {
      const arg = str.slice(start, i).trim();
      if (arg) args.push(arg);
      start = i + 1;
    }
  }

  const last = str.slice(start).trim();
  if (last) args.push(last);

  return args;
}

// === BODY HEURISTICS ===

/**
 * Determine if a View body is single-rooted.
 *
 * Heuristic: strip the outer braces from the body text, find the first
 * identifier that opens a call expression. If that identifier matches a known
 * layout container (HStack, VStack, ZStack, etc.), the body is multi-rooted.
 * Otherwise it's single-rooted and we walk the modifier chain.
 *
 * This is intentionally conservative — false negatives (multi-root classified
 * as single-root) would produce a noisy chain, so we err towards emitting
 * modifierChain: [] for ambiguous cases.
 */
function isSingleRootedBody(bodyText: string): boolean {
  // Strip outer `{ ... }` braces and leading whitespace
  const inner = bodyText
    .replace(/^\s*\{/, "")
    .replace(/\}\s*$/, "")
    .trim();
  if (!inner) return false;

  // Find the first identifier (potential root view call)
  const firstIdentMatch = /^([A-Z][A-Za-z0-9_]*)[\s\S]*$/.exec(inner);
  if (!firstIdentMatch?.[1]) return false;

  const rootViewName = firstIdentMatch[1];

  // If the root is a layout container, body is multi-rooted
  if (LAYOUT_CONTAINERS.has(rootViewName)) return false;

  return true;
}

// === PATH UTILITIES ===

function normalizeFilePath(filePath: string): string {
  return path.normalize(filePath);
}
