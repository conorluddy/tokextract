import type { FlatToken } from "../dtcg";
import { scopesFor } from "../scopes";
import { applyCodeSyntax } from "../code-syntax";
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
  byName: Map<string, Variable>;     // for $ref resolution
  warnings: string[];
}

export interface ImportResult {
  variables: number;
  textStyles: number;
  effectStyles: number;
  skipped: { name: string; reason: string }[];
}

export async function importToken(
  ctx: ImportContext,
  token: FlatToken,
  result: ImportResult,
): Promise<void> {
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

// Shared finalizer for any importer that creates a Variable.
// Keeps scopes + codeSyntax + description application in one place.
export function decorateVariable(
  variable: Variable,
  token: FlatToken,
  options: { hidden?: boolean } = {},
): void {
  variable.scopes = scopesFor(token);
  applyCodeSyntax(variable, token);
  if (token.description) variable.description = token.description;
  if (options.hidden) variable.hiddenFromPublishing = true;
}

// Returns the existing variable in the collection (when name + type match)
// or creates a fresh one. Returns null on type mismatch — caller should skip.
// Idempotent: re-running the plugin with the same tokens.json updates values
// in place rather than failing on duplicate-name errors.
export function ensureVariable(
  ctx: ImportContext,
  name: string,
  type: VariableResolvedDataType,
): Variable | null {
  const existing = ctx.byName.get(name);
  if (existing) {
    if (existing.resolvedType !== type) return null;
    return existing;
  }
  const created = figma.variables.createVariable(name, ctx.collection, type);
  ctx.byName.set(name, created);
  return created;
}
