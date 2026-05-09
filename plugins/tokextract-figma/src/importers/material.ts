import type { FlatToken } from "../dtcg";
import type { ImportContext, ImportResult } from "./index";

// Liquid Glass / proprietary materials live under $extensions.<vendor>.material.
// Figma has no native concept — we serialise the JSON into a STRING variable
// so designers can at least see what the codebase declared.
export function importMaterial(ctx: ImportContext, token: FlatToken, result: ImportResult): void {
  const variable = figma.variables.createVariable(token.name, ctx.collection, "STRING");
  variable.setValueForMode(ctx.modeId, JSON.stringify(token.value));
  variable.description = token.description ?? "Proprietary material — see source codebase for rendering.";
  ctx.byName.set(token.name, variable);
  result.variables++;
}
