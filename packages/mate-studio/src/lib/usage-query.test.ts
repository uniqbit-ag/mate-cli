import { expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";

import { validateStudioSearch } from "./search";
import { usageQuery } from "./usage-query";
import { validateUsageInput } from "../server/usage";
import { usageFixture } from "../views/usage/fixture";

test("usage periods and repository ids are validated without trusting paths", () => {
  expect(validateStudioSearch({ usageDays: "30", usageRepository: "acme-web" })).toEqual({
    usageDays: 30,
    usageRepository: "acme-web",
  });
  for (const usageDays of [0, 366, "7x", "1.5"])
    expect(validateStudioSearch({ usageDays })).toEqual({});
  expect(validateStudioSearch({ usageRepository: "/acme/secret" })).toEqual({});
  expect(() => validateUsageInput({ companion: "/acme/path", days: 7 })).toThrow();
  expect(() => validateUsageInput({ companion: "0123456789", days: 366 })).toThrow();
  expect(validateUsageInput({ companion: "0123456789", days: 30 })).toEqual({
    companion: "0123456789",
    days: 30,
    refresh: false,
  });
});

test("late responses and periods remain isolated with no stale-data placeholder", async () => {
  const client = new QueryClient();
  const first = usageQuery("0123456789", 7);
  const second = usageQuery("9876543210", 7);
  const longer = usageQuery("0123456789", 30);
  client.setQueryData(first.queryKey, {
    snapshot: null,
    error: { code: "COLLECTION_FAILED", message: "Synthetic failure" },
  });
  expect(client.getQueryData(second.queryKey)).toBeUndefined();
  expect(client.getQueryData(longer.queryKey)).toBeUndefined();
  expect(first.staleTime).toBe(Infinity);
  expect(first.refetchOnWindowFocus).toBe(false);
  client.removeQueries({ queryKey: first.queryKey, exact: true });
  const delayed = Promise.withResolvers<ReturnType<typeof usageFixture>>();
  const late = client.fetchQuery({
    ...first,
    queryFn: async () => ({ snapshot: await delayed.promise, error: null }),
  });
  const other = usageFixture();
  other.companion.id = "acme-other";
  client.setQueryData(second.queryKey, { snapshot: other, error: null });
  delayed.resolve(usageFixture());
  await late;
  expect(client.getQueryData(second.queryKey)?.snapshot?.companion.id).toBe("acme-other");
  expect(client.getQueryData(longer.queryKey)).toBeUndefined();
  client.clear();
});
