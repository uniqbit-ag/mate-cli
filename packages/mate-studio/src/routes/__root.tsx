import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, HeadContent, Scripts } from "@tanstack/react-router";
import { BRAND_SVGS } from "@uniqbit/mate-core/studio";
import { STUDIO_PREPAINT_SCRIPT } from "../shell/prepaint";
import { studioPaletteCss } from "../styles/palette";
import type { ReactNode } from "react";

import { shellQuery } from "../lib/queries";
import { validateStudioSearch } from "../lib/search";
import stylesheet from "../styles/studio.css?url";
import { TERMINAL_PREPAINT_SCRIPT } from "../stores/terminal-ui";
import { StudioLayout } from "../shell/layout";

const FAVICON_URI = `data:image/svg+xml;base64,${btoa(BRAND_SVGS.favicon)}`;

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  validateSearch: validateStudioSearch,
  loaderDeps: ({ search }) => search,
  // The shell and sidebar render with the document; views below render in the browser (D4).
  ssr: true,
  loader: ({ context, deps }) => context.queryClient.ensureQueryData(shellQuery(deps)),
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
  return <StudioLayout search={Route.useSearch()} />;
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
