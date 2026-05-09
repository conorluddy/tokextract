import type { FlatToken, DtcgShadowValue } from "../dtcg";
import { toRgba } from "../color";
import type { ImportContext, ImportResult } from "./index";

// Shadows have no Variable type in Figma — they live as Effect Styles.
export function importShadow(_ctx: ImportContext, token: FlatToken, result: ImportResult): void {
  const shadows = Array.isArray(token.value)
    ? (token.value as DtcgShadowValue[])
    : [token.value as DtcgShadowValue];
  const effects: (DropShadowEffect | InnerShadowEffect)[] = [];
  for (const s of shadows) {
    const color = toRgba(s.color);
    if (!color) {
      result.skipped.push({ name: token.name, reason: "shadow color unparseable" });
      return;
    }
    effects.push({
      type: s.inset ? "INNER_SHADOW" : "DROP_SHADOW",
      color,
      offset: { x: dim(s.offsetX), y: dim(s.offsetY) },
      radius: dim(s.blur),
      spread: s.spread ? dim(s.spread) : 0,
      visible: true,
      blendMode: "NORMAL",
    });
  }
  const style = figma.createEffectStyle();
  style.name = token.name;
  style.effects = effects;
  if (token.description) style.description = token.description;
  result.effectStyles++;
}

function dim(value: unknown): number {
  if (typeof value === "number") return value;
  if (value && typeof value === "object" && "value" in (value as object)) {
    return (value as { value: number }).value;
  }
  return 0;
}
