import { flatten, type DtcgFile, type FlatToken } from "./dtcg";
import { importToken, type ImportContext, type ImportResult } from "./importers";
import { detectAlias, resolveAliases, type AliasEntry } from "./aliases";
import { buildSpecPage } from "./spec-page";

interface UiImportMessage {
  type: "import";
  json: string;
  collectionName?: string;
  buildSpec?: boolean;
}

interface UiResponse {
  type: "done" | "error";
  message?: string;
  result?: ImportResult & { reusedCollection?: boolean };
}

figma.showUI(__html__, { width: 420, height: 520, themeColors: true });

figma.ui.onmessage = async (msg: UiImportMessage) => {
  if (msg.type !== "import") return;
  try {
    const result = await runImport(msg);
    respond({ type: "done", result });
    figma.notify(summary(result));
  } catch (error) {
    respond({ type: "error", message: (error as Error).message });
  }
};

async function runImport(msg: UiImportMessage): Promise<ImportResult & { reusedCollection: boolean }> {
  const file = JSON.parse(msg.json) as DtcgFile;
  const tokens = flatten(file);
  if (tokens.length === 0) throw new Error("No tokens found in JSON.");

  const result: ImportResult = {
    variables: 0,
    textStyles: 0,
    effectStyles: 0,
    skipped: [],
    fontFallbacks: [],
    nonDesignTokens: 0,
  };

  // Dedupe by sanitised name — sanitisation can produce collisions (e.g.
  // `font.size.h1` and `font/size/h1` both → `font/size/h1`).
  const seen = new Set<string>();
  const unique: FlatToken[] = [];
  for (const token of tokens) {
    if (seen.has(token.name)) {
      result.skipped.push({ name: token.name, reason: "duplicate sanitised name; first occurrence kept" });
      continue;
    }
    seen.add(token.name);
    unique.push(token);
  }

  // Split aliases from concrete tokens so we can import concretes first.
  const concrete: FlatToken[] = [];
  const aliases: AliasEntry[] = [];
  for (const token of unique) {
    const alias = detectAlias(token);
    if (alias) aliases.push(alias);
    else concrete.push(token);
  }

  const collectionName = msg.collectionName?.trim() || "Tokextract";
  const { collection, reused } = await ensureCollection(collectionName);
  const modeId = collection.modes[0].modeId;

  const ctx: ImportContext = { collection, modeId, byName: new Map(), warnings: [] };
  for (const id of collection.variableIds) {
    const variable = await figma.variables.getVariableByIdAsync(id);
    if (variable) ctx.byName.set(variable.name, variable);
  }

  for (const token of concrete) await importToken(ctx, token, result);
  resolveAliases(ctx, aliases, result);

  if (msg.buildSpec) {
    const page = await buildSpecPage(unique);
    figma.currentPage = page;
  }

  return { ...result, reusedCollection: reused };
}

async function ensureCollection(name: string): Promise<{ collection: VariableCollection; reused: boolean }> {
  const existing = await figma.variables.getLocalVariableCollectionsAsync();
  const match = existing.find((c) => c.name === name);
  if (match) return { collection: match, reused: true };
  return { collection: figma.variables.createVariableCollection(name), reused: false };
}

function respond(msg: UiResponse): void {
  figma.ui.postMessage(msg);
}

function summary(r: ImportResult & { reusedCollection: boolean }): string {
  const collectionVerb = r.reusedCollection ? "Updated" : "Created";
  const parts = [
    `${collectionVerb} collection`,
    `${r.variables} variables`,
    `${r.textStyles} text`,
    `${r.effectStyles} effects`,
  ];
  const tail: string[] = [];
  if (r.skipped.length > 0) tail.push(`${r.skipped.length} skipped`);
  if (r.fontFallbacks.length > 0) tail.push(`${r.fontFallbacks.length} font fallbacks`);
  if (r.nonDesignTokens > 0) tail.push(`${r.nonDesignTokens} non-tokens ignored`);
  return `${parts.join(" · ")}${tail.length ? ` (${tail.join(", ")})` : ""}`;
}
