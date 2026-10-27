/** Where Studio serves its own client script: one fixed name, never mapped to a path. */
export const STUDIO_CLIENT_ROUTE = "/studio/client.js";

/** `null` for any name but the fixed one, so a request never maps to a file. */
export async function studioClientAsset(pathname: string): Promise<Response | null> {
  if (pathname !== STUDIO_CLIENT_ROUTE) return null;
  // Loaded on request, so the CLI's startup never reads the built script.
  const { STUDIO_CLIENT_BUNDLE } = await import("./views/studio-client.generated");
  return new Response(STUDIO_CLIENT_BUNDLE, {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
    },
  });
}
