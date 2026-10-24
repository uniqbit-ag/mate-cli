import { normalizeLanguage, renderNodesToHtml, renderTokens, tokenize } from "@tanstack/highlight";
import { createThemeCss, createThemeRule } from "@tanstack/highlight/theme";
import githubDark from "@tanstack/highlight/themes/github-dark";
import githubLight from "@tanstack/highlight/themes/github-light";

/** Sole boundary against `@tanstack/highlight`, so an upstream API break stays a single-file fix. */

function resolveHighlightLanguage(candidate: string | undefined): string {
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

/**
 * Token colours as an inlinable stylesheet; carries no script, font, or external reference.
 * Light by default, dark when the reader prefers it, and light again in print.
 */
export function highlightStyleBlock(codeBlockSelector: string): string {
  const light = createThemeCss({ light: githubLight, codeBlockSelector });
  return `${light}
@media (prefers-color-scheme: dark) {
${createThemeRule(":root", githubDark)}
}
@media print {
${createThemeRule(":root", githubLight)}
}`;
}
