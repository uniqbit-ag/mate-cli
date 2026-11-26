import { afterEach, describe, expect, it } from "bun:test";

await import("../../test/dom");
const { createStudioQueryClient } = await import("./query-client");
const { studioConnection, useConnectionState } = await import("../stores/connection");

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  studioConnection()?.dispose();
  useConnectionState.setState({ state: "online" });
});

/** Answers every ping with `ping` and records the URLs asked for. */
function pinging(ping: () => Response) {
  const asked: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    asked.push(String(input));
    return ping();
  }) as unknown as typeof fetch;
  return asked;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("studio query client", () => {
  it("probes after a failed query and takes the state from the probe", async () => {
    const asked = pinging(() => new Response(null, { status: 401 }));
    const client = createStudioQueryClient();
    await client
      .fetchQuery({
        queryKey: ["sessions"],
        queryFn: () => Promise.reject(new Error("Studio connection: signed-out")),
        retry: false,
      })
      .catch(() => {});
    await settle();
    expect(asked).toEqual(["/api/ping"]);
    expect(useConnectionState.getState().state).toBe("expired");
  });

  it("probes after a failed mutation and stays online when Studio answers", async () => {
    const asked = pinging(() => new Response(null, { status: 204 }));
    const client = createStudioQueryClient();
    await client
      .getMutationCache()
      .build(client, { mutationFn: () => Promise.reject(new Error("refused")) })
      .execute(undefined)
      .catch(() => {});
    await settle();
    expect(asked).toEqual(["/api/ping"]);
    expect(useConnectionState.getState().state).toBe("online");
  });
});
