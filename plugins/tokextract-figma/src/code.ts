import { flatten, type DtcgFile, type FlatToken } from "./dtcg";
import { importToken, type ImportContext, type ImportResult } from "./importers";
import { buildSpecPage } from "./spec-page";

interface UiMessage {
  type: "import";
  json: string;
  collectionName?: string;
  buildSpec?: boolean;
}

interface UiResponse {
  type: "done" | "error";
  message?: string;
  result?: ImportResult;
}

figma.showUI(__html__, { width: 420, height: 520, themeColors: true });

figma.ui.onmessage = async (msg: UiMessage) => {
  if (msg.type !== "import") return;
  try {
    const file = JSON.parse(msg.json) as DtcgFile;
    const tokens = flatten(file);
    if (tokens.length === 0) throw new Error("No tokens found in JSON.");

    const collection = figma.variables.createVariableCollection(msg.collectionName || "Tokextract");
    const modeId = collection.modes[0].modeId;

    const ctx: ImportContext = { collection, modeId, byName: new Map(), warnings: [] };
    const result: ImportResult = { variables: 0, textStyles: 0, effectStyles: 0, skipped: [] };

    const sync = tokens.filter((t) => t.type !== "typography");
    const async = tokens.filter((t) => t.type === "typography");
    for (const token of sync) importToken(ctx, token, result);
    for (const token of async) {
      // typography importer is async; await sequentially to keep loadFontAsync ordered.
      await (importToken(ctx, token, result) as unknown as Promise<void> | undefined);
    }

    if (msg.buildSpec) {
      const page = await buildSpecPage(tokens);
      figma.currentPage = page;
    }

    respond({ type: "done", result });
    figma.notify(summary(result));
  } catch (error) {
    respond({ type: "error", message: (error as Error).message });
  }
};

function respond(msg: UiResponse): void {
  figma.ui.postMessage(msg);
}

function summary(r: ImportResult): string {
  return `Imported ${r.variables} variables · ${r.textStyles} text styles · ${r.effectStyles} effects (${r.skipped.length} skipped)`;
}

// Keeps unused-import noise out of strict mode.
void (null as unknown as FlatToken);
