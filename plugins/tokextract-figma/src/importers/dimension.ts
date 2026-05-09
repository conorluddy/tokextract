import type { FlatToken } from "../dtcg";
import { decorateVariable, ensureVariable, type ImportContext, type ImportResult } from "./index";

export function importDimension(ctx: ImportContext, token: FlatToken, result: ImportResult): void {
  const px = toPx(token.value);
  if (px === null) {
    result.skipped.push({ name: token.name, reason: "could not parse dimension value" });
    return;
  }
  const variable = ensureVariable(ctx, token.name, "FLOAT");
  if (!variable) {
    result.skipped.push({ name: token.name, reason: "existing variable has different type" });
    return;
  }
  variable.setValueForMode(ctx.modeId, px);
  decorateVariable(variable, token);
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
