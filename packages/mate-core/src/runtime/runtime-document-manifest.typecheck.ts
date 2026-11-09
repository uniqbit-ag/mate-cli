import { renderedDocument } from "./runtime-document-manifest";

/**
 * Compile-time test, run by the type check (which skips `*.test.ts`): a Runtime
 * Surface cannot render a destination the manifest module does not declare.
 */
export function undeclaredDestinationDoesNotCompile(): void {
  // @ts-expect-error -- `.claude/settings.json` is not a declared runtime document
  renderedDocument(".claude/settings.json", []);
}
