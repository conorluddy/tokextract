import type { FlatToken } from "../dtcg";
import { toRgba } from "../color";
import { decorateVariable, ensureVariable, type ImportContext, type ImportResult } from "./index";

export function importColor(ctx: ImportContext, token: FlatToken, result: ImportResult): void {
  const rgba = toRgba(token.value);
  if (!rgba) {
    result.skipped.push({ name: token.name, reason: "could not parse color value" });
    return;
  }
  const variable = ensureVariable(ctx, token.name, "COLOR");
  if (!variable) {
    result.skipped.push({ name: token.name, reason: "existing variable has different type" });
    return;
  }
  variable.setValueForMode(ctx.modeId, rgba);
  decorateVariable(variable, token);
  result.variables++;
}
