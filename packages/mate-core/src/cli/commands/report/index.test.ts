import { afterEach, beforeEach, describe, expect, spyOn } from "bun:test";
import { test } from "bun:test";

import { RepositoryNotFoundError } from "../../../lib/orchestrator/types";
import { aggregateUsage } from "../../../lib/usage/aggregate";
import type { UsageScope } from "../../../lib/usage/scope";
import { sourceResult } from "../../../lib/usage/source";
import { UsageError } from "../../../lib/usage/types";
import { runReportCommand } from "./index";

const scope: UsageScope = {
  companionPath: "/acme/companion",
  companionId: "companion",
  fingerprint: "acme",
  capabilities: [],
  repositories: [
    {
      id: "companion",
      kind: "companion",
      label: "Companion Repository",
      path: "/acme/companion",
      aliases: ["/acme/companion"],
      available: true,
    },
  ],
};
const document = {
  version: 1,
  title: "Acme report",
  generatedAt: "2026-11-07T12:00:00Z",
  metadata: [],
  summary: [],
  sections: [{ id: "notes", title: "Notes", type: "text", content: "Acme" }],
};
const now = () => new Date("2026-11-07T12:00:00Z");
let log: ReturnType<typeof spyOn<typeof console, "log">>;
let errors: ReturnType<typeof spyOn<typeof console, "error">>;
beforeEach(() => {
  log = spyOn(console, "log").mockImplementation(() => {});
  errors = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  log.mockRestore();
  errors.mockRestore();
  process.exitCode = 0;
});
const output = () => {
  expect(log.mock.calls).toHaveLength(1);
  return JSON.parse(String(log.mock.calls[0]![0]));
};

function deps(): NonNullable<Parameters<typeof runReportCommand>[1]> {
  return {
    now,
    env: {},
    ensureUnambiguousCompanion: async () => true,
    resolveFrameworkContext: async () => ({ companionPath: scope.companionPath }),
    resolveUsageScope: async () => scope,
    collectCompanionUsage: async (selected, window) =>
      aggregateUsage(
        selected,
        window,
        [sourceResult(selected, "claude", "unavailable")],
        now().toISOString(),
      ),
    readInput: async () => JSON.stringify(document),
    publishReportToStudio: async () => null,
    writeTemporaryReport: async () => "/acme/temp/report.html",
  };
}

describe("technical usage output", () => {
  test.each([[], ["--json"], ["--days", "30"]].map((args) => ({ args })))(
    "prints one usage snapshot: %j",
    async ({ args }) => {
      const options = deps();
      options.env = { MATE_REPORT_OUTPUT: "/acme/should-not-write.html" };
      options.writeTemporaryReport = async () => {
        throw new Error("must not write");
      };
      options.publishReportToStudio = async () => {
        throw new Error("must not host");
      };
      await runReportCommand(args, options);
      expect(output()).toMatchObject({
        kind: "companion-usage",
        version: 1,
        window: { days: args.includes("30") ? 30 : 7 },
      });
      expect(errors).not.toHaveBeenCalled();
    },
  );

  test.each(
    [
      ["--days", "7x"],
      ["--days", "0"],
      ["--days", "366"],
      ["--days"],
      ["--other"],
      ["--days", "7", "--input", "-"],
      ["--input"],
    ].map((args) => ({ args })),
  )("rejects invalid options: %j", async ({ args }) => {
    const options = deps();
    options.resolveFrameworkContext = async () => {
      throw new Error("must not resolve");
    };
    await runReportCommand(args, options);
    expect(output()).toMatchObject({
      kind: "error",
      version: 1,
      error: { code: "INVALID_OPTIONS" },
    });
    expect(process.exitCode).toBe(1);
  });

  test("reports unresolved scope and fatal failures as sanitized JSON", async () => {
    const options = deps();
    options.resolveFrameworkContext = async () => {
      throw new RepositoryNotFoundError("private source detail");
    };
    await runReportCommand([], options);
    expect(output().error.code).toBe("COMPANION_UNRESOLVED");
    expect(JSON.stringify(log.mock.calls)).not.toContain("private source detail");
  });

  test("reports an unpinned ambiguous companion before resolving context", async () => {
    let resolved = false;
    await runReportCommand([], {
      ...deps(),
      ensureUnambiguousCompanion: async () => false,
      resolveFrameworkContext: async () => {
        resolved = true;
        return { companionPath: scope.companionPath };
      },
    });
    expect(output().error.code).toBe("COMPANION_AMBIGUOUS");
    expect(resolved).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  test("preserves a typed ambiguity error without human stdout", async () => {
    await runReportCommand([], {
      ...deps(),
      resolveUsageScope: async () => {
        throw new UsageError("COMPANION_AMBIGUOUS", "Select a companion");
      },
    });
    expect(output().error.code).toBe("COMPANION_AMBIGUOUS");
  });
});

describe("explicit generic reports", () => {
  test("retains document JSON without collection or delivery", async () => {
    await runReportCommand(["--input", "-", "--json"], {
      ...deps(),
      collectCompanionUsage: async () => {
        throw new Error("must not collect");
      },
      writeTemporaryReport: async () => {
        throw new Error("must not deliver");
      },
    });
    expect(output()).toEqual(document);
  });

  test("validates before creating a partial report", async () => {
    let wrote = false;
    await runReportCommand(["--input", "acme.json"], {
      ...deps(),
      readInput: async () => '{"version":1}',
      writeTemporaryReport: async () => {
        wrote = true;
        return "unused";
      },
    });
    expect(output().error.code).toBe("INVALID_REPORT_INPUT");
    expect(wrote).toBe(false);
  });

  test("local delivery returns HTML locator, not a browser launch", async () => {
    let html = "";
    await runReportCommand(["--input", "-"], {
      ...deps(),
      writeTemporaryReport: async (content) => {
        html = content;
        return "/acme/temp/report.html";
      },
    });
    expect(output()).toMatchObject({
      kind: "report-delivery",
      version: 1,
      delivery: { kind: "temporary-file", path: "/acme/temp/report.html" },
    });
    expect(html).toContain("Acme report");
  });

  test.each([
    "https://reports.example.com/studio/reports/acme",
    undefined,
    "http://127.0.0.1/acme",
  ])("hosted receipt keeps only public locators: %s", async (url) => {
    await runReportCommand(["--input", "-"], {
      ...deps(),
      publishReportToStudio: async () => ({ id: "acme", ...(url ? { url } : {}) }),
      writeTemporaryReport: async () => {
        throw new Error("must not write");
      },
    });
    const receipt = output();
    expect(receipt.delivery.kind).toBe("studio");
    if (url?.startsWith("https:")) expect(receipt.delivery.url).toBe(url);
    else expect(receipt.delivery).toEqual({ kind: "studio", id: "acme", surface: "reports" });
  });

  test("hosting failure falls back with no leaked error detail", async () => {
    await runReportCommand(["--input", "-"], {
      ...deps(),
      publishReportToStudio: async () => {
        throw new Error("private credential");
      },
    });
    const receipt = output();
    expect(receipt.delivery.kind).toBe("temporary-file");
    expect(JSON.stringify(receipt)).not.toContain("private credential");
  });

  test("runner receipts omit destination and hosting takes precedence", async () => {
    let wrote = false;
    await runReportCommand(["--input", "-"], {
      ...deps(),
      env: { MATE_REPORT_OUTPUT: "/acme/private/report.html" },
      writeOutput: async () => {
        wrote = true;
      },
    });
    expect(output().delivery).toEqual({ kind: "runner-output" });
    expect(wrote).toBe(true);
  });

  test("final delivery failure is a JSON error with document fallback", async () => {
    await runReportCommand(["--input", "-"], {
      ...deps(),
      writeTemporaryReport: async () => {
        throw new Error("private failure");
      },
    });
    expect(output()).toMatchObject({
      kind: "error",
      error: { code: "REPORT_DELIVERY_FAILED" },
      fallback: document,
    });
    expect(process.exitCode).toBe(1);
    expect(JSON.stringify(log.mock.calls)).not.toContain("private failure");
  });
});
