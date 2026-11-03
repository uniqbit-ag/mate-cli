import fs from "node:fs/promises";
import { createRequire } from "node:module";

import { TERMINAL_ASSET_PREFIX } from "./routes";

const require = createRequire(import.meta.url);

/**
 * The terminal's WASM core, the one file Studio's bundled terminal loads from Studio itself, so
 * its version always matches the installed `@wterm/core`.
 */
const ASSETS: Record<string, { body: () => Promise<ArrayBuffer>; type: string }> = {
  "wterm.wasm": {
    body: async () => {
      const bytes = await fs.readFile(require.resolve("@wterm/core/wasm"));
      return bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
    },
    type: "application/wasm",
  },
};

/** `null` for any name outside the fixed set, so the route never maps a request to a path. */
export async function terminalAsset(pathname: string): Promise<Response | null> {
  if (!pathname.startsWith(TERMINAL_ASSET_PREFIX)) return null;
  const name = pathname.slice(TERMINAL_ASSET_PREFIX.length);
  const asset = Object.hasOwn(ASSETS, name) ? ASSETS[name] : undefined;
  if (!asset) return null;
  return new Response(await asset.body(), {
    headers: {
      "content-type": asset.type,
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
    },
  });
}
