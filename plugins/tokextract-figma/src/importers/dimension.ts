import type { FlatToken } from "../dtcg";
import type { ImportContext, ImportResult } from "./index";

export function importDimension(ctx: ImportContext, token: FlatToken, result: ImportResult): void {
  const px = toPx(token.value);
  if (px === null) {
    result.skipped.push({ name: token.name, reason: "could not parse dimension value" });
    return;
  }
  const variable = figma.variables.createVariable(token.name, ctx.collection, "FLOAT");
  variable.setValueForMode(ctx.modeId, px);
  if (token.description) variable.description = token.description;
  ctx.byName.set(token.name, variable);
  result.variables++;
}

function toPx(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (value && typeof value === "object" && "value" in (value as object)) {
    const v = value as { value: number; unit?: string };
    if (typeof v.value !== "number") return null;
    if (!v.unit || v.unit === "px") return v.value;
    if (v.unit === "rem") return v.value * 16;
    if (v.unit === "pt") return v.value * (96 / 72);
  }
  return null;
}
