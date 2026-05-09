import type { FlatToken } from "../dtcg";
import { importColor } from "./color";
import { importDimension } from "./dimension";
import { importFontFamily, importFontWeight, importTypography } from "./typography";
import { importOpacityOrNumber } from "./number";
import { importDuration, importCubicBezier } from "./motion";
import { importShadow } from "./shadow";
import { importMaterial } from "./material";

export interface ImportContext {
  collection: VariableCollection;
  modeId: string;
  byName: Map<string, Variable>;     // for $ref resolution later
  warnings: string[];
}

export interface ImportResult {
  variables: number;
  textStyles: number;
  effectStyles: number;
  skipped: { name: string; reason: string }[];
}

export function importToken(ctx: ImportContext, token: FlatToken, result: ImportResult): void | Promise<void> {
  try {
    switch (token.type) {
      case "color":       return importColor(ctx, token, result);
      case "dimension":   return importDimension(ctx, token, result);
      case "fontFamily":  return importFontFamily(ctx, token, result);
      case "fontWeight":  return importFontWeight(ctx, token, result);
      case "number":      return importOpacityOrNumber(ctx, token, result);
      case "duration":    return importDuration(ctx, token, result);
      case "cubicBezier": return importCubicBezier(ctx, token, result);
      case "shadow":      return importShadow(ctx, token, result);
      case "typography":  return importTypography(ctx, token, result);
      default: {
        // Material lives under $extensions; handled by name prefix elsewhere.
        if (token.path[0] === "$extensions" || token.extensions?.["material"]) {
          return importMaterial(ctx, token, result);
        }
        result.skipped.push({ name: token.name, reason: `unsupported type: ${token.type}` });
      }
    }
  } catch (error) {
    result.skipped.push({ name: token.name, reason: (error as Error).message });
  }
}
