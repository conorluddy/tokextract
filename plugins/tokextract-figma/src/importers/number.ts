import type { FlatToken } from "../dtcg";
import { decorateVariable, ensureVariable, type ImportContext, type ImportResult } from "./index";

export function importOpacityOrNumber(
  ctx: ImportContext,
  token: FlatToken,
  result: ImportResult,
): void {
  if (typeof token.value !== "number") {
    result.skipped.push({ name: token.name, reason: "non-numeric value for number type" });
    return;
  }
  const variable = ensureVariable(ctx, token.name, "FLOAT");
  if (!variable) {
    result.skipped.push({ name: token.name, reason: "existing variable has different type" });
    return;
  }
  variable.setValueForMode(ctx.modeId, token.value);
  decorateVariable(variable, token);
  result.variables++;
}
