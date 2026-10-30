import { describe, expect, test } from "bun:test";
import { waitForPublishedPackages } from "../scripts/wait-for-published-packages.mjs";

const VERSION = "9.9.9-canary.1";

function publishedResponse(name: string) {
  return new Response(JSON.stringify({ name, version: VERSION }), { status: 200 });
}

function missingResponse() {
  return new Response("not found", { status: 404 });
}

describe("waitForPublishedPackages", () => {
  test("returns when every package is immediately available", async () => {
    const calls: string[] = [];
    await waitForPublishedPackages(["@acme/core", "@acme/cli"], VERSION, {
      request: async (url) => {
        const packageName = decodeURIComponent(new URL(String(url)).pathname.split("/")[1]);
        calls.push(packageName);
        return publishedResponse(packageName);
      },
    });

    expect(calls).toEqual(["@acme/core", "@acme/cli"]);
  });

  test("rechecks only a missing package and bypasses cached responses", async () => {
    let currentTime = 0;
    const requestedUrls: string[] = [];
    const waited: string[] = [];
    let attempts = 0;

    await waitForPublishedPackages(["@acme/core", "@acme/cli"], VERSION, {
      timeoutMs: 100,
      intervalMs: 25,
      now: () => currentTime,
      sleep: async (ms) => {
        currentTime += ms;
      },
      log: (message) => waited.push(message),
      request: async (url, init) => {
        requestedUrls.push(String(url));
        expect(new Headers(init?.headers).get("cache-control")).toContain("no-cache");
        attempts += 1;
        if (new URL(String(url)).pathname.includes("core")) return publishedResponse("@acme/core");
        return attempts === 2 ? missingResponse() : publishedResponse("@acme/cli");
      },
    });

    expect(requestedUrls).toHaveLength(3);
    expect(requestedUrls[0]).not.toBe(requestedUrls[2]);
    expect(waited.some((message) => message.includes("Waited for @acme/cli"))).toBe(true);
  });

  test("shares one deadline across all still-missing packages", async () => {
    let currentTime = 0;
    const sleeps: number[] = [];
    const requests: string[] = [];

    await expect(
      waitForPublishedPackages(["@acme/core", "@acme/plugin"], VERSION, {
        timeoutMs: 1_000,
        intervalMs: 600,
        now: () => currentTime,
        sleep: async (ms) => {
          sleeps.push(ms);
          currentTime += ms;
        },
        log: () => {},
        request: async (url) => {
          requests.push(String(url));
          return missingResponse();
        },
      }),
    ).rejects.toThrow("@acme/core@9.9.9-canary.1, @acme/plugin@9.9.9-canary.1");

    expect(sleeps).toEqual([600, 400]);
    expect(requests).toHaveLength(4);
  });

  test("names a package that remains missing at timeout", async () => {
    let currentTime = 0;
    await expect(
      waitForPublishedPackages(["@acme/core"], VERSION, {
        timeoutMs: 50,
        intervalMs: 30,
        now: () => currentTime,
        sleep: async (ms) => {
          currentTime += ms;
        },
        log: () => {},
        request: async () => missingResponse(),
      }),
    ).rejects.toThrow("@acme/core@9.9.9-canary.1");
  });

  test("reports registry errors instead of treating them as missing versions", async () => {
    await expect(
      waitForPublishedPackages(["@acme/core"], VERSION, {
        request: async () => new Response("unavailable", { status: 503 }),
      }),
    ).rejects.toThrow("@acme/core@9.9.9-canary.1: registry returned HTTP 503");
  });
});
