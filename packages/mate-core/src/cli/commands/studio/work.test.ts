import { describe, expect, test } from "bun:test";

import { NO_CREDENTIAL } from "../../../lib/factory/credential-store";
import type { Outcomes } from "../../../lib/factory/outcomes";
import { factoryAvailability } from "./work";

const outcomes = (automated: boolean) => () => ({ automated }) as Outcomes;
const broker = (info: () => Promise<{ credential: unknown }>) => ({ info }) as never;

describe("factory availability", () => {
  test("without factory mode there is no factory at all", async () => {
    expect(
      await factoryAvailability("/acme", {
        factoryMode: false,
        outcomesFor: outcomes(true),
        broker: null,
      }),
    ).toEqual({ mode: false, usable: false });
  });

  test("factory mode with a usable broker, runner and credential", async () => {
    expect(
      await factoryAvailability("/acme", {
        factoryMode: true,
        outcomesFor: outcomes(true),
        broker: broker(async () => ({ credential: { kind: "api-key" } })),
      }),
    ).toEqual({ mode: true, usable: true });
  });

  test.each([
    [
      "a runner serving another companion",
      outcomes(false),
      async () => ({ credential: {} }),
      "does not serve",
    ],
    ["no agent credential", outcomes(true), async () => ({ credential: null }), NO_CREDENTIAL],
    [
      "an unreachable broker",
      outcomes(true),
      async () => {
        throw new Error("ECONNREFUSED");
      },
      "not reachable",
    ],
  ])("%s keeps the factory but offers no dispatch", async (_name, outcomesFor, info, reason) => {
    const availability = await factoryAvailability("/acme", {
      factoryMode: true,
      outcomesFor,
      broker: broker(info),
    });
    expect(availability.mode).toBe(true);
    expect(availability.usable).toBe(false);
    expect(availability.reason).toContain(reason);
  });

  test("a hanging broker is bounded", async () => {
    const started = Date.now();
    const availability = await factoryAvailability("/acme", {
      factoryMode: true,
      outcomesFor: outcomes(true),
      broker: broker(() => new Promise(() => {})),
    });
    expect(availability).toMatchObject({ mode: true, usable: false });
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
