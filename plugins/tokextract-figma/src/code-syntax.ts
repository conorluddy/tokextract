import type { FlatToken } from "./dtcg";

// Variable.codeSyntax surfaces platform-specific names in Dev Mode. We don't
// know exact target platforms, so we emit the same dotted path everywhere as
// a useful default — designers see the SwiftUI-flavoured token name regardless
// of which platform tab they're on.
export function codeSyntaxFor(token: FlatToken): { WEB: string; iOS: string; ANDROID: string } {
  const dotted = token.path.join(".");
  return { WEB: dotted, iOS: dotted, ANDROID: dotted };
}

export function applyCodeSyntax(variable: Variable, token: FlatToken): void {
  const syntax = codeSyntaxFor(token);
  variable.setVariableCodeSyntax("WEB", syntax.WEB);
  variable.setVariableCodeSyntax("iOS", syntax.iOS);
  variable.setVariableCodeSyntax("ANDROID", syntax.ANDROID);
}
