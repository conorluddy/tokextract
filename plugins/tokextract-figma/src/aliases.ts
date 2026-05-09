import { sanitizeName, type FlatToken } from "./dtcg";
import { decorateVariable, ensureVariable, type ImportContext, type ImportResult } from "./importers";

// DTCG aliases look like `"{color.primary.500}"` as a $value. We import them
// after concrete tokens have been created so target lookup can succeed.
const ALIAS_PATTERN = /^\{(.+)\}$/;

export interface AliasEntry { token: FlatToken; targetName: string; }

export function detectAlias(token: FlatToken): AliasEntry | null {
  if (typeof token.value !== "string") return null;
  const match = token.value.match(ALIAS_PATTERN);
  if (!match) return null;
  const targetName = sanitizeName(match[1].split("."));
  return { token, targetName };
}

export function resolveAliases(
  ctx: ImportContext,
  aliases: AliasEntry[],
  result: ImportResult,
): void {
  for (const { token, targetName } of aliases) {
    const target = ctx.byName.get(targetName);
    if (!target) {
      result.skipped.push({ name: token.name, reason: `alias target not found: ${targetName}` });
      continue;
    }
    const variable = ensureVariable(ctx, token.name, target.resolvedType);
    if (!variable) {
      result.skipped.push({ name: token.name, reason: "existing variable has different type" });
      continue;
    }
    variable.setValueForMode(ctx.modeId, figma.variables.createVariableAlias(target));
    decorateVariable(variable, token);
    result.variables++;
  }
}
