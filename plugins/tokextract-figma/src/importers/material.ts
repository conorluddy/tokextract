import type { FlatToken } from "../dtcg";
import { decorateVariable, ensureVariable, type ImportContext, type ImportResult } from "./index";

export function importMaterial(ctx: ImportContext, token: FlatToken, result: ImportResult): void {
  const variable = ensureVariable(ctx, token.name, "STRING");
  if (!variable) {
    result.skipped.push({ name: token.name, reason: "existing variable has different type" });
    return;
  }
  variable.setValueForMode(ctx.modeId, JSON.stringify(token.value));
  const decorationToken: FlatToken = {
    ...token,
    description: token.description ?? "Proprietary material — see source codebase for rendering.",
  };
  decorateVariable(variable, decorationToken, { hidden: true });
  result.variables++;
}
