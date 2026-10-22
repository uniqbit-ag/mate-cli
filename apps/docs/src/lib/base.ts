const base = import.meta.env.BASE_URL.replace(/\/+$/, "");

/** Prefixes a root-relative site path with the configured Astro `base`. */
export function withBase(path: string): string {
  if (path === "/" || path === "") return base || "/";
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

export const docsBaseUrl = withBase("/docs");
