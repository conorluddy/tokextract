// === DTCG 2025.10 token types (subset Tokextract emits) ===

export type DtcgType =
  | "color"
  | "dimension"
  | "fontFamily"
  | "fontWeight"
  | "duration"
  | "cubicBezier"
  | "number"
  | "shadow"
  | "typography"
  | "border"
  | "strokeStyle"
  | "transition"
  | "gradient"
  | "string";

export interface DtcgColorValue {
  colorSpace: "srgb" | "display-p3" | "rec2020" | "a98-rgb" | "prophoto-rgb" | "xyz-d65" | "xyz-d50";
  components: [number, number, number];
  alpha?: number;
  hex?: string;
}

export interface DtcgDimensionValue {
  value: number;
  unit: "px" | "rem" | "pt";
}

export interface DtcgDurationValue {
  value: number;
  unit: "ms" | "s";
}

export interface DtcgShadowValue {
  color: DtcgColorValue | string;
  offsetX: DtcgDimensionValue;
  offsetY: DtcgDimensionValue;
  blur: DtcgDimensionValue;
  spread?: DtcgDimensionValue;
  inset?: boolean;
}

export interface DtcgTypographyValue {
  fontFamily: string | string[];
  fontSize: DtcgDimensionValue;
  fontWeight: number | string;
  lineHeight?: number | DtcgDimensionValue;
  letterSpacing?: DtcgDimensionValue;
}

export interface DtcgToken {
  $type?: DtcgType;
  $value: unknown;
  $description?: string;
  $extensions?: Record<string, unknown>;
}

export interface DtcgGroup {
  $type?: DtcgType;
  $description?: string;
  $extensions?: Record<string, unknown>;
  [key: string]: unknown;
}

export type DtcgFile = DtcgGroup;

export function isToken(node: unknown): node is DtcgToken {
  return typeof node === "object" && node !== null && "$value" in node;
}

export interface FlatToken {
  path: string[];      // ["color", "primary", "500"]
  name: string;        // "color/primary/500"
  type: DtcgType;
  value: unknown;
  description?: string;
  extensions?: Record<string, unknown>;
}

// Figma Variable names use `/` as a group separator. Segments must not contain
// `/` themselves, leading/trailing whitespace, or chars Figma rejects in pickers.
// We allow [A-Za-z0-9_-], collapse anything else to `-`, and drop empty segments.
export function sanitizeName(segments: string[]): string {
  const cleaned = segments
    .map((segment) =>
      segment
        .trim()
        .replace(/[^A-Za-z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, ""),
    )
    .filter((segment) => segment.length > 0);
  return cleaned.length > 0 ? cleaned.join("/") : "unnamed";
}

export function flatten(file: DtcgFile): FlatToken[] {
  const out: FlatToken[] = [];
  walk(file, [], undefined, out);
  return out;
}

function walk(
  node: unknown,
  path: string[],
  inheritedType: DtcgType | undefined,
  out: FlatToken[],
): void {
  if (!node || typeof node !== "object") return;
  const group = node as DtcgGroup;
  const groupType = (group.$type as DtcgType | undefined) ?? inheritedType;

  if (isToken(group)) {
    const type = (group.$type as DtcgType | undefined) ?? inheritedType;
    if (!type) return;
    out.push({
      path,
      name: sanitizeName(path),
      type,
      value: group.$value,
      description: group.$description,
      extensions: group.$extensions,
    });
    return;
  }

  for (const key of Object.keys(group)) {
    if (key.startsWith("$")) continue;
    walk(group[key], [...path, key], groupType, out);
  }
}
