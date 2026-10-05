import fs from "node:fs/promises";
import { createRequire } from "node:module";

/** Route prefix for the terminal client; served only when the terminal is enabled. */
export const TERMINAL_ASSET_PREFIX = "/studio/terminal/";

const ASSETS: Record<string, { module: string; type: string }> = {
  "xterm.js": { module: "@xterm/xterm/lib/xterm.js", type: "text/javascript" },
  "xterm.css": { module: "@xterm/xterm/css/xterm.css", type: "text/css" },
  "addon-fit.js": { module: "@xterm/addon-fit/lib/addon-fit.js", type: "text/javascript" },
  "addon-unicode11.js": {
    module: "@xterm/addon-unicode11/lib/addon-unicode11.js",
    type: "text/javascript",
  },
  "addon-web-links.js": {
    module: "@xterm/addon-web-links/lib/addon-web-links.js",
    type: "text/javascript",
  },
  "addon-clipboard.js": {
    module: "@xterm/addon-clipboard/lib/addon-clipboard.js",
    type: "text/javascript",
  },
};

export const TERMINAL_SCRIPTS = [
  "xterm.js",
  "addon-fit.js",
  "addon-unicode11.js",
  "addon-web-links.js",
  "addon-clipboard.js",
].map((name) => `${TERMINAL_ASSET_PREFIX}${name}`);

export const TERMINAL_STYLESHEET = `${TERMINAL_ASSET_PREFIX}xterm.css`;

const require = createRequire(import.meta.url);

/** `null` for any name outside the fixed set, so the route never maps a request to a path. */
export async function terminalAsset(pathname: string): Promise<Response | null> {
  if (!pathname.startsWith(TERMINAL_ASSET_PREFIX)) return null;
  const asset = ASSETS[pathname.slice(TERMINAL_ASSET_PREFIX.length)];
  if (!asset) return null;
  const body = await fs.readFile(require.resolve(asset.module));
  return new Response(body, {
    headers: {
      "content-type": `${asset.type}; charset=utf-8`,
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
    },
  });
}
