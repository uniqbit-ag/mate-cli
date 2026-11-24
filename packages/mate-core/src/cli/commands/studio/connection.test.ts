import { describe, expect, test } from "bun:test";

import { connectionStateOf, probeStudio } from "./connection";

/** What a browser's `fetch` resolves to when `redirect: "manual"` stopped a redirect. */
function opaqueRedirect(): Response {
  const response = new Response(null, { status: 200 });
  Object.defineProperty(response, "type", { value: "opaqueredirect" });
  return response;
}

const refusal = () =>
  Response.json({ reason: "start Studio with --writable to add companions" }, { status: 403 });

describe("connectionStateOf", () => {
  test.each([
    ["a TypeError", new TypeError("Failed to fetch"), "offline"],
    ["an opaque redirect", opaqueRedirect(), "signed-out"],
    ["a 401", new Response(null, { status: 401 }), "expired"],
    ["a 421", new Response(null, { status: 421 }), "host-refused"],
    ["a 403 refusal", refusal(), null],
    ["an abort", new DOMException("aborted", "AbortError"), null],
    ["another thrown value", new Error("boom"), null],
    ["a success", new Response(null, { status: 204 }), null],
  ] as const)("classifies %s", (_, outcome, expected) => {
    expect(connectionStateOf(outcome)).toBe(expected);
  });
});

describe("probeStudio", () => {
  const answering = (outcome: () => Response | Promise<never>) =>
    (async () => outcome()) as unknown as typeof fetch;

  test("pings without following redirects, credentials beyond the origin, or the cache", async () => {
    const calls: [unknown, RequestInit | undefined][] = [];
    const fake = (async (input: unknown, init?: RequestInit) => {
      calls.push([input, init]);
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    expect(await probeStudio(fake)).toBe("online");
    expect(calls).toEqual([
      ["/api/ping", { redirect: "manual", credentials: "same-origin", cache: "no-store" }],
    ]);
  });

  test.each([
    ["an auth proxy redirects it", () => opaqueRedirect(), "signed-out"],
    ["Studio restarted with a new token", () => new Response(null, { status: 401 }), "expired"],
    ["the host is not allowed", () => new Response(null, { status: 421 }), "host-refused"],
    ["Studio refuses", refusal, "online"],
  ] as const)("resolves when %s", async (_, outcome, expected) => {
    expect(await probeStudio(answering(outcome))).toBe(expected);
  });

  test("resolves to offline when the network is down", async () => {
    expect(
      await probeStudio(answering(() => Promise.reject(new TypeError("Failed to fetch")))),
    ).toBe("offline");
  });
});
