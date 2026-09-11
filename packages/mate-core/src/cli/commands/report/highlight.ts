import { normalizeLanguage, renderNodesToHtml, renderTokens, tokenize } from "@tanstack/highlight";
import { createThemeCss } from "@tanstack/highlight/theme";
import githubLight from "@tanstack/highlight/themes/github-light";

/** Sole boundary against `@tanstack/highlight`, so an upstream API break stays a single-file fix. */

/** Language every unknown or unsupported candidate resolves to. */
export const PLAIN_LANGUAGE = "plaintext";

export function resolveHighlightLanguage(candidate: string | undefined): string {
  return normalizeLanguage(candidate);
}

/**
 * Class-annotated inline markup for one fragment, escaped and without a block wrapper.
 * An unknown language yields plain escaped text carrying no token classes.
 */
export function highlightInline(code: string, language: string | undefined): string {
  const resolved = resolveHighlightLanguage(language);
  const { tokens } = tokenize(code, { lang: resolved });
  return renderNodesToHtml(renderTokens(tokens));
}

/** Token colours as an inlinable stylesheet; carries no script, font, or external reference. */
export function highlightStyleBlock(codeBlockSelector: string): string {
  return createThemeCss({ light: githubLight, codeBlockSelector });
}
