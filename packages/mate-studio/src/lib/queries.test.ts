import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "bun:test";

import { loadView } from "./queries";

const deferred = () => {
  let resolve!: (value: string) => void;
  const promise = new Promise<string>((done) => (resolve = done));
  return { promise, resolve };
};

describe("loadView", () => {
  it("awaits the data on the server, so the first response carries it", async () => {
    const queryClient = new QueryClient();
    const data = await loadView(
      queryClient,
      { queryKey: ["specs"], queryFn: async () => "acme" },
      true,
    );
    expect(data).toBe("acme");
    expect(queryClient.getQueryData(["specs"])).toBe("acme");
  });

  it("starts the data without awaiting it in the browser", async () => {
    const queryClient = new QueryClient();
    const pending = deferred();
    const result = await loadView(
      queryClient,
      { queryKey: ["specs"], queryFn: () => pending.promise },
      false,
    );
    expect(result).toBeNull();
    expect(queryClient.getQueryState(["specs"])?.fetchStatus).toBe("fetching");
    pending.resolve("acme");
    await queryClient.getQueryCache().find({ queryKey: ["specs"] })?.promise;
    expect(queryClient.getQueryData(["specs"])).toBe("acme");
  });

  it("leaves held data alone, however old, so a hover preload reads nothing", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(["specs"], "held", { updatedAt: 0 });
    let asked = 0;
    await loadView(
      queryClient,
      {
        queryKey: ["specs"],
        queryFn: async () => {
          asked += 1;
          return "fresh";
        },
      },
      false,
    );
    expect(asked).toBe(0);
    expect(queryClient.getQueryData(["specs"])).toBe("held");
  });

  it("leaves a failed fetch to the view's own query", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const result = await loadView(
      queryClient,
      { queryKey: ["specs"], queryFn: () => Promise.reject(new Error("offline")) },
      false,
    );
    await new Promise((done) => setTimeout(done, 0));
    expect(result).toBeNull();
    expect(queryClient.getQueryState(["specs"])?.status).toBe("error");
  });
});
