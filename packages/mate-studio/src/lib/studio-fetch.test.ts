import { afterEach, describe, expect, it } from "bun:test";

import { studioFetch } from "./studio-fetch";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function answering(response: Response, seen: RequestInit[] = []) {
  globalThis.fetch = (async (_: unknown, init: RequestInit) => {
    seen.push(init);
    return response;
  }) as unknown as typeof fetch;
}

describe("studioFetch", () => {
  it("throws when an auth proxy redirects the poll", async () => {
    const redirected = new Response(null);
    Object.defineProperty(redirected, "type", { value: "opaqueredirect" });
    const seen: RequestInit[] = [];
    answering(redirected, seen);
    await expect(studioFetch("/api/terminal/sessions")).rejects.toThrow("signed-out");
    expect(seen[0]).toMatchObject({ redirect: "manual", credentials: "same-origin" });
  });

  it("returns a refusal for its caller to handle", async () => {
    answering(new Response(null, { status: 403 }));
    expect((await studioFetch("/api/plugins/acme/attention")).status).toBe(403);
  });
});
