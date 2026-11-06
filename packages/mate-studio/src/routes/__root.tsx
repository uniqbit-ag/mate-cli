import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, HeadContent, redirect, Scripts } from "@tanstack/react-router";
import { BRAND_SVGS } from "@uniqbit/mate-core/studio";
import { STUDIO_PREPAINT_SCRIPT } from "../shell/prepaint";
import { studioPaletteCss } from "../styles/palette";
import type { ReactNode } from "react";

import { loadHeld } from "../lib/queries";
import { shellQuery } from "../lib/studio-queries";
import { canonicalHref, validateStudioSearch } from "../lib/search";
import { viewAt } from "../shell/views";
import stylesheet from "../styles/app.css?url";
import { TERMINAL_PREPAINT_SCRIPT } from "../stores/terminal-ui";
import { StudioLayout } from "../shell/layout";

const FAVICON_URI = `data:image/svg+xml;base64,${btoa(BRAND_SVGS.favicon)}`;

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  validateSearch: validateStudioSearch,
  loaderDeps: ({ search }) => search,
  // The shell and sidebar render with the document; each view route chooses its own rendering.
  ssr: true,
  // The address names the server's effective mode, so every link built from it carries that.
  beforeLoad: async ({ context, search, location }) => {
    const shell = await loadHeld(context.queryClient, shellQuery(search));
    const href = canonicalHref(
      location.pathname,
      location.searchStr,
      viewAt(location.pathname),
      shell.studioMode,
    );
    if (href) {
      const hash =
        viewAt(location.pathname) === "getting-started" && location.hash
          ? `#${location.hash.replace(/^#/, "")}`
          : "";
      throw redirect({ href: `${href}${hash}`, replace: true });
    }
  },
  loader: ({ context, deps }) => loadHeld(context.queryClient, shellQuery(deps)),
  // Waiting on the shell keeps the frame shown with the progress bar; views keep their placeholder.
  pendingMs: Infinity,
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Mate Studio" },
    ],
    links: [
      { rel: "icon", type: "image/svg+xml", href: FAVICON_URI },
      { rel: "stylesheet", href: stylesheet },
    ],
    // Authored source only, never a payload value: the palette's tokens and the pre-paint script.
    styles: [{ children: studioPaletteCss() }],
    scripts: [{ children: STUDIO_PREPAINT_SCRIPT }, { children: TERMINAL_PREPAINT_SCRIPT }],
  }),
  shellComponent: RootDocument,
  component: RootLayout,
});

function RootLayout() {
  const { companion, studioMode } = Route.useSearch();
  // Only the shared address: a view's own parameters (a vault path, a graph node) stay off
  // the links to other views.
  return <StudioLayout search={{ companion, studioMode }} />;
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
