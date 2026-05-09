import type { DtcgColorValue } from "./dtcg";

// Figma's variable API expects { r, g, b } in 0..1 plus optional alpha.
export interface RGBA { r: number; g: number; b: number; a: number; }

export function toRgba(value: unknown): RGBA | null {
  if (typeof value === "string") return parseHex(value);
  if (value && typeof value === "object" && "components" in (value as object)) {
    const v = value as DtcgColorValue;
    const [r, g, b] = v.components;
    return { r: clamp01(r), g: clamp01(g), b: clamp01(b), a: clamp01(v.alpha ?? 1) };
  }
  return null;
}

function parseHex(input: string): RGBA | null {
  const hex = input.trim().replace(/^#/, "");
  if (![3, 4, 6, 8].includes(hex.length)) return null;
  const expand = hex.length <= 4
    ? hex.split("").map((c) => c + c).join("")
    : hex;
  const r = parseInt(expand.slice(0, 2), 16) / 255;
  const g = parseInt(expand.slice(2, 4), 16) / 255;
  const b = parseInt(expand.slice(4, 6), 16) / 255;
  const a = expand.length === 8 ? parseInt(expand.slice(6, 8), 16) / 255 : 1;
  if ([r, g, b, a].some(Number.isNaN)) return null;
  return { r, g, b, a };
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}
