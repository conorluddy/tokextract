import type { FlatToken } from "../dtcg";
import type { ImportContext, ImportResult } from "./index";

export function importDuration(ctx: ImportContext, token: FlatToken, result: ImportResult): void {
  const ms = toMs(token.value);
  if (ms === null) {
    result.skipped.push({ name: token.name, reason: "could not parse duration" });
    return;
  }
  const variable = figma.variables.createVariable(token.name, ctx.collection, "FLOAT");
  variable.setValueForMode(ctx.modeId, ms);
  if (token.description) variable.description = token.description;
  ctx.byName.set(token.name, variable);
  result.variables++;
}

export function importCubicBezier(ctx: ImportContext, token: FlatToken, result: ImportResult): void {
  if (!Array.isArray(token.value) || token.value.length !== 4) {
    result.skipped.push({ name: token.name, reason: "cubicBezier must be [x1, y1, x2, y2]" });
    return;
  }
  const [x1, y1, x2, y2] = token.value as number[];
  const variable = figma.variables.createVariable(token.name, ctx.collection, "STRING");
  variable.setValueForMode(ctx.modeId, `cubic-bezier(${x1}, ${y1}, ${x2}, ${y2})`);
  if (token.description) variable.description = token.description;
  ctx.byName.set(token.name, variable);
  result.variables++;
}

function toMs(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (value && typeof value === "object" && "value" in (value as object)) {
    const v = value as { value: number; unit?: string };
    if (typeof v.value !== "number") return null;
    if (v.unit === "s") return v.value * 1000;
    return v.value;
  }
  return null;
}
