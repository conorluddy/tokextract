import type { FlatToken } from "../dtcg";
import { decorateVariable, ensureVariable, type ImportContext, type ImportResult } from "./index";

export function importDuration(ctx: ImportContext, token: FlatToken, result: ImportResult): void {
  const ms = toMs(token.value);
  if (ms === null) {
    result.skipped.push({ name: token.name, reason: "could not parse duration" });
    return;
  }
  const variable = ensureVariable(ctx, token.name, "FLOAT");
  if (!variable) {
    result.skipped.push({ name: token.name, reason: "existing variable has different type" });
    return;
  }
  variable.setValueForMode(ctx.modeId, ms);
  decorateVariable(variable, token);
  result.variables++;
}

// Cubic-bezier becomes 4 FLOAT variables (x1, y1, x2, y2) so designers can
// reference each control-point component, plus a STRING `${name}/css` with the
// full `cubic-bezier(...)` literal for paste-into-CSS workflows.
export function importCubicBezier(ctx: ImportContext, token: FlatToken, result: ImportResult): void {
  if (!Array.isArray(token.value) || token.value.length !== 4) {
    result.skipped.push({ name: token.name, reason: "cubicBezier must be [x1, y1, x2, y2]" });
    return;
  }
  const components: { suffix: string; value: number }[] = [
    { suffix: "x1", value: Number(token.value[0]) },
    { suffix: "y1", value: Number(token.value[1]) },
    { suffix: "x2", value: Number(token.value[2]) },
    { suffix: "y2", value: Number(token.value[3]) },
  ];
  for (const component of components) {
    if (!Number.isFinite(component.value)) {
      result.skipped.push({ name: `${token.name}/${component.suffix}`, reason: "non-numeric component" });
      continue;
    }
    const subToken: FlatToken = {
      ...token,
      path: [...token.path, component.suffix],
      name: `${token.name}/${component.suffix}`,
    };
    const variable = ensureVariable(ctx, subToken.name, "FLOAT");
    if (!variable) {
      result.skipped.push({ name: subToken.name, reason: "existing variable has different type" });
      continue;
    }
    variable.setValueForMode(ctx.modeId, component.value);
    decorateVariable(variable, subToken);
    result.variables++;
  }
  const cssToken: FlatToken = {
    ...token,
    path: [...token.path, "css"],
    name: `${token.name}/css`,
  };
  const cssVariable = ensureVariable(ctx, cssToken.name, "STRING");
  if (!cssVariable) {
    result.skipped.push({ name: cssToken.name, reason: "existing variable has different type" });
    return;
  }
  cssVariable.setValueForMode(
    ctx.modeId,
    `cubic-bezier(${components.map((c) => c.value).join(", ")})`,
  );
  decorateVariable(cssVariable, cssToken);
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
