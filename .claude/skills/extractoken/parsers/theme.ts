/**
 * parsers/theme.ts
 *
 * Theme injection infrastructure extraction for Extractoken.
 * Captures the theme *provider* plumbing — not literal token values — so the
 * LLM normalize pass can understand the injection topology of the codebase.
 *
 * === PATTERNS HANDLED ===
 *
 * 1. Custom EnvironmentKey structs
 *    `private struct ThemeKey: EnvironmentKey { static let defaultValue: Theme = .default }`
 *
 * 2. EnvironmentValues extension computed property (explicit get/set accessor form)
 *    `extension EnvironmentValues { var theme: Theme { get { ... } set { ... } } }`
 *
 * 3. @Entry macro (iOS 18+)
 *    `extension EnvironmentValues { @Entry var theme: Theme = .default }`
 *
 * 4. @Observable theme provider class
 *    `@Observable final class ThemeProvider { var colorScheme: AppColorScheme = .brand }`
 *
 * 5. FluentUI-style tier hints: when an @Observable provider has property names
 *    containing `globalTokens`, `aliasTokens`, or `controlTokens`, tier is set.
 *
 * === NODE TYPE NOTES ===
 *
 * tree-sitter-swift represents `extension Foo { }` as `class_declaration`.
 * `struct Foo: Bar { }` is also `class_declaration` — conformance lives in
 * `(class_declaration (inheritance_specifiers ...))`.
 * `@Observable` is an attribute node at `(attribute (user_type (type_identifier)))`.
 * `@Entry` appears the same way as an attribute on a `property_declaration`.
 */

import path from "node:path";
import { getCapture, nodeColumn, nodeLineNumber, parseSource, runQuery } from "./swift-ast.js";
import type { Tree } from "./swift-ast.js";
import type { RawFinding } from "./types.js";

// === PUBLIC API ===

/**
 * Extract theme injection infrastructure findings from a single Swift source file.
 *
 * @param source   Raw Swift source text
 * @param filePath Absolute path — used for provenance in findings
 * @param tree     Optional pre-parsed tree-sitter Tree. When provided, avoids a redundant
 *                 parse call. Falls back to parsing `source` if omitted (backward-compat).
 * @returns        Array of RawFinding objects (may be empty)
 */
export function extractTheme(source: string, filePath: string, tree?: Tree): RawFinding[] {
  const sharedTree = tree ?? parseSource(source);
  const relativePath = path.normalize(filePath);
  const findings: RawFinding[] = [];

  findings.push(...extractEnvironmentKeyStructs(source, relativePath));
  findings.push(...extractEnvironmentValuesExtensions(sharedTree, relativePath));
  findings.push(...extractEntryMacros(source, relativePath));
  findings.push(...extractObservableProviders(sharedTree, relativePath));

  return findings;
}

// === PRIVATE HELPERS ===

/**
 * Detect the EnvironmentKey conformance tier hint for a property name.
 * Used by the Observable provider pass (FluentUI naming convention).
 */
function detectTier(propertyName: string): "global" | "alias" | "control" | undefined {
  if (propertyName.includes("globalTokens")) return "global";
  if (propertyName.includes("aliasTokens")) return "alias";
  if (propertyName.includes("controlTokens")) return "control";
  return undefined;
}

/**
 * Pass 1 — Custom EnvironmentKey struct declarations.
 *
 * Pattern:
 *   private struct ThemeKey: EnvironmentKey {
 *       static let defaultValue: Theme = .default
 *   }
 *
 * Captures: keyName, valueType, defaultValue.
 *
 * Approach: regex over source lines for the struct declaration + default value.
 * The AST query for struct conformance is complex (inheritance_specifiers nesting
 * varies) and tree-sitter-swift is still evolving; regex is more resilient here
 * and the pattern is constrained enough to have low false-positive risk.
 */
function extractEnvironmentKeyStructs(source: string, filePath: string): RawFinding[] {
  const findings: RawFinding[] = [];

  // Match the struct header line, then look ahead for defaultValue in the body.
  // We allow private/internal/public/fileprivate visibility modifiers.
  const structHeaderRe =
    /^[ \t]*(?:(?:private|internal|public|fileprivate|open)\s+)?struct\s+(\w+)\s*:\s*EnvironmentKey\b/gm;

  for (const headerMatch of [...source.matchAll(structHeaderRe)]) {
    if (headerMatch.index === undefined) continue;

    const keyName = headerMatch[1];
    if (!keyName) continue;

    const headerLine = lineNumberAt(source, headerMatch.index);

    // Search for `static let defaultValue: <Type> = <value>` within the next ~10 lines
    const afterHeader = source.slice(headerMatch.index);
    const defaultValueRe = /static\s+let\s+defaultValue\s*:\s*(\w[\w<>?\[\], .]*?)\s*=\s*([^\n{]+)/;
    const defaultMatch = defaultValueRe.exec(afterHeader);

    // Only associate if the defaultValue line is close (within the struct body)
    const closingBrace = afterHeader.indexOf("}");
    const defaultOffset = defaultMatch?.index ?? Number.MAX_SAFE_INTEGER;
    if (!defaultMatch || defaultOffset > closingBrace) continue;

    const valueType = defaultMatch[1]?.trim() ?? "";
    const defaultValue = defaultMatch[2]?.trim() ?? "";

    const rawValue = source.slice(headerMatch.index, headerMatch.index + closingBrace + 1);

    const finding: RawFinding = {
      category: "theme",
      sourcePath: filePath,
      line: headerLine,
      col: headerMatch[0].indexOf("struct"),
      declName: keyName,
      rawValue,
      normalizedValue: {
        pattern: "EnvironmentKey",
        keyName,
        valueType,
        defaultValue,
      },
      context: "struct EnvironmentKey",
      isDeclaration: true,
    };

    findings.push(finding);
  }

  return findings;
}

/**
 * Pass 2 — EnvironmentValues extension with explicit computed property.
 *
 * Pattern:
 *   extension EnvironmentValues {
 *       var theme: Theme { get { self[ThemeKey.self] } set { self[ThemeKey.self] = newValue } }
 *   }
 *
 * We capture:
 *   - propertyName: `theme`
 *   - valueType:    `Theme`
 *   - keyName:      `ThemeKey` (extracted from `self[ThemeKey.self]`)
 *
 * Approach: tree-sitter AST query for EnvironmentValues class_declaration containing
 * property_declaration nodes. Falls back gracefully on query error.
 * We then regex the raw property text to pull keyName from `self[ThemeKey.self]`.
 */
function extractEnvironmentValuesExtensions(tree: Tree, filePath: string): RawFinding[] {
  const findings: RawFinding[] = [];

  // Query: class_declaration named "EnvironmentValues" with property_declaration children.
  // Note: tree-sitter-swift parses `extension` as `class_declaration`. The name field
  // uses `(user_type (type_identifier))` for extension forms. Property field names
  // (`name:`, `type_annotation:`) are NOT available in this grammar — use positional
  // child matching instead.
  // We exclude @Entry-annotated properties — those are handled by Pass 3.
  const query = `
    (class_declaration
      (user_type (type_identifier) @ext_name)
      body: (class_body
        (property_declaration
          (pattern (simple_identifier) @prop_name)
          (type_annotation (user_type (type_identifier) @value_type))
          ) @prop_decl))
  `;

  let matches: ReturnType<typeof runQuery>;
  try {
    matches = runQuery(tree, query);
  } catch {
    return [];
  }

  for (const match of matches) {
    const extNameNode = getCapture(match, "ext_name");
    const propNameNode = getCapture(match, "prop_name");
    const valueTypeNode = getCapture(match, "value_type");
    const propDeclNode = getCapture(match, "prop_decl");

    if (!extNameNode || extNameNode.text !== "EnvironmentValues") continue;
    if (!propNameNode || !valueTypeNode || !propDeclNode) continue;

    const propertyName = propNameNode.text;
    const valueType = valueTypeNode.text;
    const rawValue = propDeclNode.text;

    // Skip @Entry properties — the @Entry pass covers those
    if (rawValue.includes("@Entry")) continue;

    // Skip properties that are just stored vars (have `=` immediately after type annotation)
    // by checking if the raw text has a computed body `{`
    if (!rawValue.includes("{")) continue;

    // Extract keyName from `self[ThemeKey.self]` or `self[ThemeKey.self]` patterns
    const keyNameMatch = /self\[(\w+)\.self\]/.exec(rawValue);
    const keyName = keyNameMatch?.[1] ?? undefined;

    const finding: RawFinding = {
      category: "theme",
      sourcePath: filePath,
      line: nodeLineNumber(propNameNode),
      col: nodeColumn(propNameNode),
      declName: propertyName,
      rawValue,
      normalizedValue: {
        pattern: "EnvironmentValues-extension",
        keyName,
        propertyName,
        valueType,
      },
      context: "extension EnvironmentValues",
      isDeclaration: true,
    };

    findings.push(finding);
  }

  return findings;
}

/**
 * Pass 3 — @Entry macro (iOS 18+).
 *
 * Pattern:
 *   extension EnvironmentValues {
 *       @Entry var theme: Theme = .default
 *   }
 *
 * Approach: regex over source lines. The @Entry attribute is concise enough that
 * a line-oriented regex beats a complex tree-sitter query for this form, and avoids
 * fragility around attribute node nesting across grammar versions.
 */
function extractEntryMacros(source: string, filePath: string): RawFinding[] {
  const findings: RawFinding[] = [];

  // Find all `extension EnvironmentValues { ... }` blocks
  const extRe = /\bextension\s+EnvironmentValues\s*\{/g;
  for (const extMatch of [...source.matchAll(extRe)]) {
    if (extMatch.index === undefined) continue;

    const blockStart = extMatch.index + extMatch[0].length;
    const blockEnd = findMatchingBrace(source, extMatch.index + extMatch[0].indexOf("{"));
    if (blockEnd === -1) continue;

    const blockBody = source.slice(blockStart, blockEnd);
    const bodyLineOffset = lineNumberAt(source, blockStart);

    // Match `@Entry var <name>: <Type> = <defaultValue>`
    const entryRe = /[ \t]*@Entry\s+var\s+(\w+)\s*:\s*(\w[\w<>?, .]*?)\s*=\s*([^\n]+)/g;
    for (const entryMatch of [...blockBody.matchAll(entryRe)]) {
      if (entryMatch.index === undefined) continue;

      const propertyName = entryMatch[1];
      const valueType = entryMatch[2]?.trim();
      const defaultValue = entryMatch[3]?.trim();

      if (!propertyName || !valueType || !defaultValue) continue;

      const lineInBlock = countNewlines(blockBody.slice(0, entryMatch.index));
      const line = bodyLineOffset + lineInBlock;
      const col = entryMatch[0].indexOf("@Entry");

      const finding: RawFinding = {
        category: "theme",
        sourcePath: filePath,
        line,
        col,
        declName: propertyName,
        rawValue: entryMatch[0].trim(),
        normalizedValue: {
          pattern: "Entry-macro",
          propertyName,
          valueType,
          defaultValue,
        },
        context: "@Entry macro",
        isDeclaration: true,
      };

      findings.push(finding);
    }
  }

  return findings;
}

/**
 * Pass 4 — @Observable theme provider class.
 *
 * Pattern:
 *   @Observable final class ThemeProvider {
 *       var colorScheme: AppColorScheme = .brand
 *       var radiusScale: RadiusScale = .rounded
 *   }
 *
 * Captures: class name, all var properties (name + type).
 * Adds FluentUI tier hint when property names contain globalTokens / aliasTokens / controlTokens.
 *
 * Approach: tree-sitter AST for class with @Observable attribute + property declarations.
 */
function extractObservableProviders(tree: Tree, filePath: string): RawFinding[] {
  const findings: RawFinding[] = [];

  // Query for class declarations that have an @Observable attribute.
  // Observable classes use `name: (type_identifier)` directly (no wrapping user_type),
  // unlike extension forms which use `(user_type (type_identifier))`.
  const query = `
    (class_declaration
      (modifiers
        (attribute
          (user_type (type_identifier) @attr_name)))
      name: (type_identifier) @class_name
      body: (class_body) @class_body)
  `;

  let matches: ReturnType<typeof runQuery>;
  try {
    matches = runQuery(tree, query);
  } catch {
    return [];
  }

  for (const match of matches) {
    const attrNameNode = getCapture(match, "attr_name");
    const classNameNode = getCapture(match, "class_name");
    const classBodyNode = getCapture(match, "class_body");

    if (!attrNameNode || attrNameNode.text !== "Observable") continue;
    if (!classNameNode || !classBodyNode) continue;

    const className = classNameNode.text;

    // Collect all `var` property declarations from the class body.
    // Note: field qualifiers `name:` and `type_annotation:` are not available in this
    // grammar version — match positionally (child order is deterministic for var decls).
    const propQuery = `
      (property_declaration
        (pattern (simple_identifier) @prop_name)
        (type_annotation (user_type (type_identifier) @prop_type)))
    `;

    let propMatches: ReturnType<typeof runQuery>;
    try {
      propMatches = runQuery(tree, propQuery);
    } catch {
      propMatches = [];
    }

    // Filter to only properties physically inside this class body
    const bodyStart = classBodyNode.startPosition;
    const bodyEnd = classBodyNode.endPosition;

    const properties: Array<{ name: string; type: string }> = [];
    for (const propMatch of propMatches) {
      const propNameNode = getCapture(propMatch, "prop_name");
      const propTypeNode = getCapture(propMatch, "prop_type");
      if (!propNameNode || !propTypeNode) continue;

      // Check the property is inside this class body
      const pos = propNameNode.startPosition;
      if (
        pos.row < bodyStart.row ||
        pos.row > bodyEnd.row ||
        (pos.row === bodyStart.row && pos.column < bodyStart.column) ||
        (pos.row === bodyEnd.row && pos.column > bodyEnd.column)
      ) {
        continue;
      }

      properties.push({ name: propNameNode.text, type: propTypeNode.text });
    }

    // Detect FluentUI tier — use the first property that matches a tier keyword,
    // or check if any property name triggers a tier hint.
    let tier: "global" | "alias" | "control" | undefined;
    for (const prop of properties) {
      const detected = detectTier(prop.name);
      if (detected) {
        tier = detected;
        break;
      }
    }

    const rawValue = classBodyNode.text
      ? `@Observable class ${className} ${classBodyNode.text}`
      : `@Observable class ${className}`;

    const finding: RawFinding = {
      category: "theme",
      sourcePath: filePath,
      line: nodeLineNumber(classNameNode),
      col: nodeColumn(classNameNode),
      declName: className,
      rawValue,
      normalizedValue: {
        pattern: "Observable-provider",
        properties,
        ...(tier !== undefined && { tier }),
      },
      context: "@Observable class",
      isDeclaration: true,
    };

    findings.push(finding);
  }

  return findings;
}

// === UTILITIES ===

/**
 * Compute 1-based line number for a byte offset within source.
 */
function lineNumberAt(source: string, offset: number): number {
  return source.slice(0, offset).split("\n").length;
}

/**
 * Count newline characters in a string.
 */
function countNewlines(text: string): number {
  let count = 0;
  for (const ch of text) {
    if (ch === "\n") count++;
  }
  return count;
}

/**
 * Find the index of the closing `}` that matches the `{` at `openIndex`.
 * Returns -1 if not found.
 */
function findMatchingBrace(source: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
