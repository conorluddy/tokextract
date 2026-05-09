import type { FlatToken } from "../dtcg";
import { toRgba } from "../color";
import type { ImportContext, ImportResult } from "./index";

export function importColor(ctx: ImportContext, token: FlatToken, result: ImportResult): void {
  const rgba = toRgba(token.value);
  if (!rgba) {
    result.skipped.push({ name: token.name, reason: "could not parse color value" });
    return;
  }
  const variable = figma.variables.createVariable(token.name, ctx.collection, "COLOR");
  variable.setValueForMode(ctx.modeId, rgba);
  if (token.description) variable.description = token.description;
  ctx.byName.set(token.name, variable);
  result.variables++;
}
