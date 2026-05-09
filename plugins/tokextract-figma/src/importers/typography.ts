import type { FlatToken, DtcgTypographyValue } from "../dtcg";
import { findFont, DEFAULT_FALLBACKS } from "../font-matcher";
import { decorateVariable, ensureVariable, type ImportContext, type ImportResult } from "./index";

export function importFontFamily(ctx: ImportContext, token: FlatToken, result: ImportResult): void {
  const value = Array.isArray(token.value) ? String(token.value[0]) : String(token.value);
  const variable = ensureVariable(ctx, token.name, "STRING");
  if (!variable) {
    result.skipped.push({ name: token.name, reason: "existing variable has different type" });
    return;
  }
  variable.setValueForMode(ctx.modeId, value);
  decorateVariable(variable, token);
  result.variables++;
}

export function importFontWeight(ctx: ImportContext, token: FlatToken, result: ImportResult): void {
  const numeric = typeof token.value === "number" ? token.value : weightNameToNumber(String(token.value));
  if (numeric === null) {
    result.skipped.push({ name: token.name, reason: `unknown font weight: ${String(token.value)}` });
    return;
  }
  const variable = ensureVariable(ctx, token.name, "FLOAT");
  if (!variable) {
    result.skipped.push({ name: token.name, reason: "existing variable has different type" });
    return;
  }
  variable.setValueForMode(ctx.modeId, numeric);
  decorateVariable(variable, token);
  result.variables++;
}

export async function importTypography(
  ctx: ImportContext,
  token: FlatToken,
  result: ImportResult,
): Promise<void> {
  const value = token.value as DtcgTypographyValue;
  if (!value || typeof value !== "object") {
    result.skipped.push({ name: token.name, reason: "typography value malformed" });
    return;
  }
  const family = Array.isArray(value.fontFamily) ? value.fontFamily[0] : value.fontFamily;
  const style = weightNumberToStyleName(
    typeof value.fontWeight === "number" ? value.fontWeight : weightNameToNumber(String(value.fontWeight)) ?? 400,
  );

  const matched = await findFont({ family, style }, DEFAULT_FALLBACKS);
  if (matched.reason === "fallback") {
    result.fontFallbacks.push({
      name: token.name,
      requested: `${family} ${style}`,
      used: `${matched.fontName.family} ${matched.fontName.style}`,
    });
  }

  const text = figma.createTextStyle();
  text.name = token.name;
  text.fontName = matched.fontName;
  text.fontSize = pxOrDefault(value.fontSize, 16);
  if (value.lineHeight) {
    if (typeof value.lineHeight === "number") {
      text.lineHeight = { unit: "PERCENT", value: value.lineHeight * 100 };
    } else {
      text.lineHeight = { unit: "PIXELS", value: pxOrDefault(value.lineHeight, 0) };
    }
  }
  if (value.letterSpacing) {
    text.letterSpacing = { unit: "PIXELS", value: pxOrDefault(value.letterSpacing, 0) };
  }
  if (token.description) text.description = token.description;
  result.textStyles++;
}

function weightNameToNumber(name: string): number | null {
  const map: Record<string, number> = {
    thin: 100, hairline: 100,
    extralight: 200, ultralight: 200,
    light: 300,
    regular: 400, normal: 400, book: 400,
    medium: 500,
    semibold: 600, demibold: 600,
    bold: 700,
    extrabold: 800, ultrabold: 800,
    black: 900, heavy: 900,
  };
  return map[name.toLowerCase()] ?? null;
}

function weightNumberToStyleName(weight: number): string {
  if (weight <= 150) return "Thin";
  if (weight <= 250) return "Extra Light";
  if (weight <= 350) return "Light";
  if (weight <= 450) return "Regular";
  if (weight <= 550) return "Medium";
  if (weight <= 650) return "Semi Bold";
  if (weight <= 750) return "Bold";
  if (weight <= 850) return "Extra Bold";
  return "Black";
}

function pxOrDefault(value: unknown, fallback: number): number {
  if (typeof value === "number") return value;
  if (value && typeof value === "object" && "value" in (value as object)) {
    const v = value as { value: number; unit?: string };
    if (!v.unit || v.unit === "px") return v.value;
    if (v.unit === "rem") return v.value * 16;
    if (v.unit === "pt") return v.value * (96 / 72);
  }
  return fallback;
}
