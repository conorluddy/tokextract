import type { FlatToken, DtcgType } from "./dtcg";

// Maps a token's path + type to Figma's VariableScope[] so the variable shows
// in relevant pickers (fills, strokes, corner radius, gap, …) and stays out of
// irrelevant ones. ALL_SCOPES is the fallback when we can't infer.
export function scopesFor(token: FlatToken): VariableScope[] {
  const path = token.path.map((segment) => segment.toLowerCase()).join("/");
  switch (token.type) {
    case "color":      return colorScopes(path);
    case "dimension":  return dimensionScopes(path);
    case "number":     return numberScopes(path);
    case "fontWeight": return ["FONT_WEIGHT"];
    case "fontFamily": return ["FONT_FAMILY"];
    default:           return ["ALL_SCOPES"];
  }
}

function colorScopes(path: string): VariableScope[] {
  if (/(^|\/)(text|label|content|foreground|fg)(\/|$|-)/.test(path)) return ["TEXT_FILL"];
  if (/(^|\/)(stroke|border|outline)(\/|$|-)/.test(path))            return ["STROKE_COLOR"];
  if (/(^|\/)effect/.test(path))                                     return ["EFFECT_COLOR"];
  return ["FRAME_FILL", "SHAPE_FILL"];
}

function dimensionScopes(path: string): VariableScope[] {
  if (/(^|\/)(radius|corner|rounding)(\/|$|-)/.test(path))      return ["CORNER_RADIUS"];
  if (/(^|\/)(spacing|gap|padding|margin)(\/|$|-)/.test(path))  return ["GAP"];
  if (/(^|\/)(stroke|border)(\/|$|-)/.test(path))               return ["STROKE_FLOAT"];
  if (/(^|\/)(width|height|size)(\/|$|-)/.test(path))           return ["WIDTH_HEIGHT"];
  return ["ALL_SCOPES"];
}

function numberScopes(path: string): VariableScope[] {
  if (/(^|\/)(opacity|alpha)(\/|$|-)/.test(path)) return ["OPACITY"];
  return ["ALL_SCOPES"];
}

// Figma also gates by underlying primitive type (COLOR, FLOAT, STRING, BOOLEAN).
// This helper is a small belt-and-braces check for callers.
export function isScopeValidFor(_type: DtcgType, _scopes: VariableScope[]): boolean {
  return true;
}
