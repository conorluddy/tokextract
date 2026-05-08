/**
 * parsers/component.ts
 *
 * Component token extractor for SwiftUI design system extraction.
 *
 * === CONFIDENCE TIERS ===
 *
 * Every component finding is tagged with `componentConfidence`:
 *
 * "high" — Always emitted. Definitive signal:
 *   - `struct X: ButtonStyle / ViewModifier / PrimitiveButtonStyle`
 *   - `extension View { func xStyle() -> some View { modifier(...) } }` wrappers
 *
 * "medium" — Emitted by default in v1. Strong heuristic signal (any one of):
 *   - Struct name contains a component keyword (Button, Badge, Chip, Pill, Tag,
 *     Avatar, Icon, Modifier, Style, Cell, Item, Tile) AND does NOT contain an
 *     exclusion suffix (Gallery, Experiment, Example, Demo, Preview, Section,
 *     Screen, List, Sheet, Hero) — the exclusion prevents demo/gallery views from
 *     being mis-classified even when their names contain component vocabulary.
 *   - Body uses `configuration.label` (ButtonStyle/protocol-shaped composition)
 *   - Struct has at least one `@Binding` property (reliable reusable-component signal)
 *
 * Deliberately excluded from keywords (too broad in demo/gallery-heavy codebases):
 *   Row, Bar, Card, Wrapper — these appear heavily in screen/gallery compound names
 *   (e.g. ActivityHeroK69_HeatRow, AnimatedProgressBar, BadgesGalleryView). They
 *   promote too many false positives on demo-heavy apps like Grapla.
 *   Parameterized Row/Card/Bar components will match via @Binding if they accept state.
 *
 * Also evaluated but rejected: typed init params (init(label: String)) — too broad;
 *   SwiftUI screens commonly have init(viewModel:), init(item:) etc.
 *
 * "low" — Dropped in v1. Custom struct View with no name match or init signal.
 *   Reserve for `--include-likely-components` opt-in (not wired yet).
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
 * 5. Custom `struct X: View` with medium-confidence signal (see tiers above).
 *    Low-confidence custom Views are NOT emitted in v1.
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
import type { Tree } from "./swift-ast.js";
import type { RawFinding } from "./types.js";

// Protocols that signal component-level token declarations (high confidence)
const COMPONENT_PROTOCOLS = new Set(["ButtonStyle", "ViewModifier", "PrimitiveButtonStyle"]);

/**
 * Name substrings that suggest a custom View struct is a reusable component (medium confidence).
 * All matched case-insensitively against the struct name.
 *
 * Included: words that reliably identify UI primitives across diverse codebases.
 * Excluded "Row", "Bar", "Card", "Wrapper" — too frequently appear in demo/gallery
 * screen names (e.g. ActivityHeroK69_HeatRow, AnimatedProgressBar, ActionCardExample).
 * Use @Binding signal path for parameterized Row/Bar/Card components.
 * Also excluded: "View", "Screen", "Page", "Controller", "Model", "Manager", "Service"
 *   — architectural vocabulary, not component vocabulary.
 */
const COMPONENT_NAME_KEYWORDS = [
  "button",
  "badge",
  "chip",
  "pill",
  "tag",
  "avatar",
  "icon",
  "modifier",
  "style",
  "cell",
  "item",
  "tile",
] as const;

/**
 * Name suffix/substring exclusions that override a keyword match.
 * These are architectural or demo-context suffixes — even if a struct name contains
 * a component keyword (e.g. "BadgeGalleryView"), the exclusion wins.
 *
 * Rationale: demo-heavy codebases (design system showcases, component galleries,
 * UI experiment apps) generate views named XxxGallery, XxxExperiment, XxxExample
 * etc. These are screens/demos, not reusable components, even though they contain
 * component vocabulary in their names.
 */
const COMPONENT_NAME_EXCLUSIONS = [
  "gallery",
  "experiment",
  "example",
  "demo",
  "preview",
  "section",
  "screen",
  "list",
  "sheet",
  "hero",
  "hub",
  "panel",
  "detail",
  "form",
  "fields",
  "content",
  "tab",
] as const;

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
 * @param tree     Optional pre-parsed tree-sitter Tree. When provided, avoids a redundant
 *                 parse call. Falls back to parsing `source` if omitted (backward-compat).
 * @returns        Array of RawFinding objects (may be empty)
 */
export function extractComponents(source: string, filePath: string, tree?: Tree): RawFinding[] {
  const sharedTree = tree ?? parseSource(source);
  const relativePath = normalizeFilePath(filePath);
  const findings: RawFinding[] = [];

  // Pass 1: ButtonStyle / ViewModifier / PrimitiveButtonStyle structs
  const styleStructFindings = extractStyleProtocolStructs(sharedTree, relativePath);
  findings.push(...styleStructFindings);

  // Pass 2: extension View convenience wrapper functions
  const extensionViewFindings = extractExtensionViewWrappers(sharedTree, relativePath);
  findings.push(...extensionViewFindings);

  // Pass 3: Custom View structs wrapping a single primary native view
  const customViewFindings = extractCustomViewStructs(sharedTree, relativePath);
  findings.push(...customViewFindings);

  return findings;
}

// === PRIVATE HELPERS ===

/**
 * Extract ButtonStyle / ViewModifier / PrimitiveButtonStyle struct declarations.
 * Walks makeBody / body function to collect the modifier chain.
 */
function extractStyleProtocolStructs(tree: Tree, filePath: string): RawFinding[] {
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
      componentConfidence: "high",
    });
  }

  return findings;
}

/**
 * Extract `extension View { func someStyle() -> some View { ... } }` convenience wrappers.
 * These are identified by the extension name being "View" (user_type node, not type_identifier).
 */
function extractExtensionViewWrappers(tree: Tree, filePath: string): RawFinding[] {
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
      componentConfidence: "high",
    });
  }

  return findings;
}

/**
 * Extract custom View structs with medium confidence only.
 *
 * Confidence tiers applied here:
 * - medium: struct name contains a component keyword, body uses `configuration.label`,
 *           or struct has an init-signal (typed params / @Binding properties).
 * - low: everything else — NOT emitted in v1. Dropped to reduce noise from app
 *        screens and one-off views. Behind --include-likely-components opt-in (future).
 *
 * Multi-rooted bodies (HStack/VStack root) still emit with modifierChain: [].
 */
function extractCustomViewStructs(tree: Tree, filePath: string): RawFinding[] {
  const findings: RawFinding[] = [];

  // Query: struct conforming to View with a computed body property
  // Excludes extension View (those have name: user_type, not type_identifier)
  // Also capture the full class body so we can inspect properties for init signals
  const query = `
    (class_declaration
      name: (type_identifier) @struct_name
      (inheritance_specifier
        inherits_from: (user_type (type_identifier) @protocol))
      body: (class_body) @class_body
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
    const classBodyNode = getCapture(match, "class_body");

    if (!structNameNode || !protocolNode || !classBodyNode) continue;
    if (protocolNode.text !== "View") continue;

    const declName = structNameNode.text;
    const classBodyText = classBodyNode.text;

    // Extract the body computed property text for chain analysis
    const bodyText = extractBodyPropertyText(classBodyText);
    if (bodyText === null) continue; // no `var body: some View` found — not a View

    // === Confidence gating ===
    // Only emit medium confidence; drop low. Order: cheapest checks first.

    const confidence = classifyCustomViewConfidence(declName, bodyText, classBodyText);
    if (confidence === "low") continue; // dropped in v1

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
      componentConfidence: "medium",
    });
  }

  return findings;
}

/**
 * Classify a custom struct View into medium or low confidence.
 *
 * Returns "medium" if any heuristic fires; "low" otherwise.
 *
 * Note on init signal: `detectTypedInit` (typed init params) was evaluated but
 * produced too many false positives on Grapla (screens with init(viewModel:),
 * init(item:) etc. matched). Only `@Binding` properties are used as the init
 * signal — they reliably indicate a reusable, stateful component rather than a screen.
 */
function classifyCustomViewConfidence(
  declName: string,
  bodyText: string,
  classBodyText: string,
): "medium" | "low" {
  const nameLower = declName.toLowerCase();

  // 1. Name-keyword match (case-insensitive), gated by exclusion check
  const hasKeyword = COMPONENT_NAME_KEYWORDS.some((kw) => nameLower.includes(kw));
  if (hasKeyword) {
    // Exclusion wins: architectural/demo suffixes override a keyword match
    const hasExclusion = COMPONENT_NAME_EXCLUSIONS.some((ex) => nameLower.includes(ex));
    if (!hasExclusion) return "medium";
  }

  // 2. Body uses configuration.label — ButtonStyle/Style-protocol-shaped composition
  //    No exclusion check needed — `configuration.label` is unambiguously component-shaped.
  if (bodyText.includes("configuration.label")) return "medium";

  // 3. @Binding property — reliable signal for a reusable stateful component, UNLESS
  //    the name contains an architectural exclusion suffix. Sheets/sections/screens often
  //    carry @Binding var isPresented: Bool for navigation — that's routing, not a
  //    component token. The exclusion prevents over-capturing navigation-layer views.
  if (/@Binding\b/.test(classBodyText)) {
    const hasExclusionName = COMPONENT_NAME_EXCLUSIONS.some((ex) => nameLower.includes(ex));
    if (!hasExclusionName) return "medium";
  }

  return "low";
}

/**
 * Extract the text of `var body: some View { ... }` from a class body string.
 * Returns null if no body property is found (so the caller can skip the struct).
 *
 * Uses a simple brace-balanced walk from the `var body` position.
 */
function extractBodyPropertyText(classBodyText: string): string | null {
  // Match `var body` declaration that precedes a computed property (opening brace)
  const bodyVarMatch = /\bvar\s+body\s*(?::\s*some\s+View\s*)?\{/.exec(classBodyText);
  if (!bodyVarMatch) return null;

  // Walk from the opening brace to find the matching closing brace
  const openPos = bodyVarMatch.index + bodyVarMatch[0].length - 1; // position of `{`
  let depth = 1;
  let pos = openPos + 1;

  while (pos < classBodyText.length && depth > 0) {
    const ch = classBodyText[pos];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    pos++;
  }

  if (depth !== 0) return null; // malformed
  return classBodyText.slice(openPos, pos); // includes `{ ... }`
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
