import type { FlatToken } from "../dtcg";
import type { ImportContext, ImportResult } from "./index";

// Handles bare `number` tokens (opacity, line-height ratios, z-index, etc.).
export function importOpacityOrNumber(
  ctx: ImportContext,
  token: FlatToken,
  result: ImportResult,
): void {
  if (typeof token.value !== "number") {
    result.skipped.push({ name: token.name, reason: "non-numeric value for number type" });
    return;
  }
  const variable = figma.variables.createVariable(token.name, ctx.collection, "FLOAT");
  variable.setValueForMode(ctx.modeId, token.value);
  if (token.description) variable.description = token.description;
  ctx.byName.set(token.name, variable);
  result.variables++;
}
