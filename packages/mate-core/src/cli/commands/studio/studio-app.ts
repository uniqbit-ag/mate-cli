import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { StudioRequestContext } from "./services";

/** Studio's built application: Start's request handler and the browser assets it references. */
export interface StudioApp {
  fetch(request: Request, options: { context: StudioRequestContext }): Promise<Response>;
  /** Directory holding the browser build, served under `/assets/`. */
  clientDir: string;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Where the build may live: the workspace's own build when running from a checkout (so a
 * rebuild shows at once), then the copy the published package carries (`studio-dist`,
 * made at pack time). `@uniqbit/mate-studio` is never published, so an install has only the latter.
 */
export const STUDIO_APP_DIRS = [
  path.resolve(HERE, "../../../../../mate-studio/dist"),
  path.resolve(HERE, "../../../../studio-dist"),
];

/** Loads the first build found; `null` when none exists, so Studio answers the missing-build page. */
export async function loadStudioApp(dirs: string[] = STUDIO_APP_DIRS): Promise<StudioApp | null> {
  for (const dir of dirs) {
    const entry = path.join(dir, "server/server.js");
    if (!existsSync(entry)) continue;
    const module = (await import(entry)) as { default: Pick<StudioApp, "fetch"> };
    const handler = module.default;
    return {
      fetch: (request, options) => Promise.resolve(handler.fetch(request, options)),
      clientDir: path.join(dir, "client"),
    };
  }
  return null;
}

/** Hashed build files are flat and never change; any other name maps to nothing. */
const ASSET = /^\/assets\/([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.(?:js|css|woff2|svg|png|map))$/;

const ASSET_TYPES: Record<string, string> = {
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  woff2: "font/woff2",
  svg: "image/svg+xml",
  png: "image/png",
  map: "application/json",
};

/** A browser asset of the application, or `null` when the path names none. */
export async function studioAppAsset(app: StudioApp, pathname: string): Promise<Response | null> {
  const name = ASSET.exec(pathname)?.[1];
  if (!name) return null;
  const body = await readFile(path.join(app.clientDir, "assets", name)).catch(() => null);
  if (!body) return null;
  return new Response(body, {
    headers: {
      "content-type": ASSET_TYPES[name.slice(name.lastIndexOf(".") + 1)]!,
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    },
  });
}
