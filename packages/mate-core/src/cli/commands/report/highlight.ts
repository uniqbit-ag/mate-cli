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
 * Light by default, dark on screen when the reader prefers it or the page sets
 * `data-scheme="dark"`, and light in print because both dark rules are screen-only.
 */
export function highlightStyleBlock(codeBlockSelector: string): string {
  const light = createThemeCss({ light: githubLight, codeBlockSelector });
  return `${light}
@media screen and (prefers-color-scheme: dark) {
${createThemeRule(':root:not([data-scheme="light"])', githubDark)}
}
@media screen {
${createThemeRule(':root[data-scheme="dark"]', githubDark)}
}`;
}
