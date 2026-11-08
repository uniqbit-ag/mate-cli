import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { UsageSource } from "@uniqbit/mate-core/studio";

await import("../../../test/dom");
const { act, cleanup, fireEvent, render } = await import("@testing-library/react");
const { UsagePanel } = await import("./usage-view");
const { UsageLedger } = await import("./ledger");
const { UsageLoading } = await import("./loading");
const { UsageSources } = await import("./sources");
const { usageSelection, cost, tokens } = await import("./model");
const { usageFixture } = await import("./fixture");
afterEach(cleanup);

const actions = { days: 7, busy: false, onDays() {}, onRepository() {}, onRefresh() {} };

describe("Usage", () => {
  test("sources group repeated diagnostics by tool with repository details collapsed", () => {
    const fixture = usageFixture();
    const sources: UsageSource[] = [
      ...fixture.sources,
      ...fixture.sources.map((source) => ({
        ...source,
        name: "rtk" as const,
        status: "unavailable" as const,
        detail: "No RTK ledger found. Check RTK_DB_PATH.",
      })),
    ];
    const page = render(<UsageSources sources={sources} repositories={fixture.repositories} />);
    expect(page.container.querySelectorAll("details")).toHaveLength(2);
    expect(page.container.querySelectorAll("details[open]")).toHaveLength(0);
    expect(page.getAllByText("No RTK ledger found. Check RTK_DB_PATH.")).toHaveLength(1);
    expect(page.getByText(/3\/3 repositories readable/)).toBeDefined();
    expect(page.getByText("RTK").closest("summary")!.textContent).toContain("Unavailable");
    expect(page.getByText("RTK").closest("details")!.querySelectorAll("li")).toHaveLength(3);
  });

  test("source summaries distinguish partial coverage, unsupported schemas and no readable repositories", () => {
    const fixture = usageFixture();
    const sources: UsageSource[] = fixture.sources.map((source, index) =>
      index
        ? source
        : { ...source, status: "unsupported", detail: "Schema needs an adapter update." },
    );
    const page = render(<UsageSources sources={sources} repositories={fixture.repositories} />);
    expect(page.getByText("Partial")).toBeDefined();
    expect(page.getByText(/2\/3 repositories readable/)).toBeDefined();
    expect(page.getByText("Schema needs an adapter update.")).toBeDefined();
    page.rerender(
      <UsageSources
        sources={sources.map((source) => ({
          ...source,
          status: source.status === "ok" ? "unavailable" : source.status,
        }))}
        repositories={fixture.repositories}
      />,
    );
    expect(page.queryByText("Partial")).toBeNull();
    expect(page.getByText("Claude Code").closest("summary")!.textContent).toContain("Unavailable");
  });
  test("initial collection has a centered, labelled spinner without duplicate announcements", () => {
    const page = render(<UsageLoading />);
    expect(page.getAllByRole("status")).toHaveLength(1);
    expect(page.getByRole("status").textContent).toContain("Collecting usage…");
    expect(page.getByRole("status").className).toContain("place-items-center");
    expect(page.getByRole("status").className).toContain("flex-1");
    const spinner = page.container.querySelector('[data-slot="spinner"]')!;
    expect(spinner.getAttribute("aria-hidden")).toBe("true");
    expect(spinner.getAttribute("class")).toContain("motion-reduce:animate-none");
  });
  test("filters every visible region from one snapshot without inventing unknowns", () => {
    const fixture = usageFixture();
    const selected = usageSelection(fixture, "acme-web");
    expect(selected.metrics.totalTokens).toBe(200);
    expect(selected.daily).toEqual(fixture.repositories[1]!.daily);
    expect(selected.sources).toEqual(fixture.repositories[1]!.sources);
    expect(selected.repositories.map((row) => row.id)).toEqual(["acme-web"]);
    expect(usageSelection(fixture, "not-linked").repositoryId).toBeUndefined();
    expect(usageSelection(fixture).metrics.totalTokens).toBe(600);
    expect(tokens(null)).toBe("—");
    expect(tokens(0)).toBe("0");
    expect(cost({ amount: null, currency: null, basis: "unknown" })).toBe("—");
  });

  test("offers exact daily values and tokens/cost switching", async () => {
    const page = render(<UsagePanel {...actions} snapshot={usageFixture()} />);
    await act(async () => {
      fireEvent.click(page.getByRole("button", { name: "Table" }));
    });
    expect(
      page.getByRole("table", { name: "Daily token usage and cost, UTC" }).textContent,
    ).toContain("600");
    await act(async () => {
      fireEvent.click(page.getByRole("button", { name: "Cost" }));
    });
    expect(page.getByRole("group", { name: "Usage metric" }).textContent).toContain("Tokens");
  });

  test("highlights scoped saved-token totals and compares savings without converting dollars", async () => {
    const page = render(
      <UsagePanel {...actions} snapshot={usageFixture()} repositoryId="acme-web" />,
    );
    const summary = page.container.querySelector("dl")!;
    expect(summary.textContent).toContain("API token cost");
    expect(summary.querySelector("strong")!.textContent).toBe("400");
    expect(summary.querySelector("strong")!.className).toContain("text-accent");
    expect(page.getByLabelText("Token chart legend").textContent).toContain(
      "Estimated tokens saved",
    );
    expect(page.getByRole("group", { name: "Daily tokens chart" })).toBeDefined();
    await act(async () => {
      fireEvent.click(page.getByRole("button", { name: "Cost" }));
    });
    expect(page.getByRole("group", { name: "Daily cost chart" })).toBeDefined();
    expect(page.queryByLabelText("Token chart legend")).toBeNull();
    await act(async () => {
      fireEvent.click(page.getByRole("button", { name: "Table" }));
    });
    const row = page
      .getByRole("table", { name: "Daily token usage and cost, UTC" })
      .querySelector("tbody tr")!;
    expect([...row.querySelectorAll("td")].map((cell) => cell.textContent)).toEqual([
      "200",
      "$0.20",
      "400",
      "complete",
      "complete",
    ]);
  });

  test("keeps savings token-only even when the snapshot contains a monetary source estimate", () => {
    const fixture = usageFixture();
    fixture.repositories[1]!.metrics.savings.estimatedCost = {
      amount: 0.4,
      currency: "USD",
      basis: "estimated",
    };
    const page = render(<UsagePanel {...actions} snapshot={fixture} repositoryId="acme-web" />);
    const items = [...page.container.querySelectorAll("dl > div")].map((item) => item.textContent);
    expect(items).toHaveLength(3);
    expect(items[2]).toContain("Estimated tokens saved");
    expect(page.queryByText("Estimated API cost saved")).toBeNull();
    expect(page.container.querySelector("dl")!.textContent).not.toContain("$0.40");
  });

  test("savings-only charts remain visible and exact savings distinguish zero, unknown and partial", async () => {
    const fixture = usageFixture();
    fixture.totals = {
      ...fixture.totals,
      totalTokens: null,
      coverage: { ...fixture.totals.coverage, savings: "partial" },
    };
    fixture.daily = [0, null].map((saved, index) => ({
      date: `2026-11-0${index + 6}`,
      metrics: {
        ...fixture.totals,
        savings: { ...fixture.totals.savings, estimatedTokens: saved },
        coverage: {
          ...fixture.totals.coverage,
          savings: saved === null ? "unavailable" : "complete",
        },
      },
    }));
    const page = render(<UsagePanel {...actions} snapshot={fixture} />);
    expect(page.getByRole("group", { name: "Daily tokens chart" })).toBeDefined();
    expect(page.getByText(/Savings are separate estimates with partial coverage/)).toBeDefined();
    await act(async () => {
      fireEvent.click(page.getByRole("button", { name: "Table" }));
    });
    const rows = page
      .getByRole("table", { name: "Daily token usage and cost, UTC" })
      .querySelectorAll("tbody tr");
    expect(rows[0]!.querySelectorAll("td")[2]!.textContent).toBe("0");
    expect(rows[1]!.querySelectorAll("td")[2]!.textContent).toBe("—");
    expect(rows[1]!.querySelectorAll("td")[3]!.textContent).toBe("unavailable");
  });

  test("repository expansion exposes exact model/cache values and paginates without changing totals", async () => {
    const fixture = usageFixture();
    const repositories = [
      ...fixture.repositories,
      ...Array.from({ length: 60 }, (_, i) => ({
        ...fixture.repositories[1]!,
        id: `acme-${i}`,
        label: `acme/repository-${i}`,
      })),
    ];
    const page = render(<UsageLedger repositories={repositories} />);
    const expand = page.getByRole("button", { name: /^Companion Repository/ });
    await act(async () => {
      fireEvent.click(expand);
    });
    expect(expand.getAttribute("aria-expanded")).toBe("true");
    expect(
      page.getByRole("region", { name: "Model breakdown for Companion Repository" }).textContent,
    ).toContain("acme-model");
    expect(page.getByText("Page 1 of 2 · totals include every repository")).toBeDefined();
    await act(async () => {
      fireEvent.click(page.getByRole("button", { name: "Next" }));
    });
    expect(page.getByText("Page 2 of 2 · totals include every repository")).toBeDefined();
  });

  test("custom periods submit and refresh is explicit", async () => {
    let days = 0;
    let refreshes = 0;
    const page = render(
      <UsagePanel
        {...actions}
        snapshot={usageFixture()}
        onDays={(value) => {
          days = value;
        }}
        onRefresh={() => {
          refreshes++;
        }}
      />,
    );
    await act(async () => {
      fireEvent.click(page.getByRole("combobox", { name: "Usage period" }));
    });
    await act(async () => {
      fireEvent.keyDown(page.getByRole("option", { name: "Custom days" }), { key: "Enter" });
    });
    await act(async () => {
      fireEvent.change(page.getByRole("spinbutton", { name: "Custom days" }), {
        target: { value: "14" },
      });
      fireEvent.submit(page.getByRole("button", { name: "Apply" }).closest("form")!);
    });
    expect(days).toBe(14);
    await act(async () => {
      fireEvent.click(page.getByRole("button", { name: "Refresh" }));
    });
    expect(refreshes).toBe(1);
  });

  test("distinguishes unavailable, no activity, no links and failed-refresh stale values", () => {
    const fixture = usageFixture();
    const unavailable = {
      ...fixture,
      totals: {
        ...fixture.totals,
        totalTokens: null,
        cost: { amount: null, currency: null, basis: "unknown" as const },
      },
      sources: fixture.sources.map((source) => ({ ...source, status: "unavailable" as const })),
    };
    const markup = renderToStaticMarkup(
      <UsagePanel {...actions} snapshot={unavailable} error="Refresh failed." />,
    );
    expect(markup).toContain("Usage is unavailable, not zero");
    expect(markup).toContain("Previous values are stale");
    expect(markup).toContain("12:00 UTC");
    expect(markup).toContain("Nov 7, 2026");
    const noLinks = {
      ...fixture,
      repositories: [fixture.repositories[0]!],
      totals: { ...fixture.totals, totalTokens: 0 },
    };
    const empty = renderToStaticMarkup(<UsagePanel {...actions} snapshot={noLinks} />);
    expect(empty).toContain("No measured activity");
    expect(empty).toContain("No Working Repositories are linked");
    expect(empty).not.toContain("netSpend");
  });

  test("repository picker searches labels and keeps selection explicit", async () => {
    let selected: string | undefined;
    const page = render(
      <UsagePanel
        {...actions}
        snapshot={usageFixture()}
        onRepository={(id) => {
          selected = id;
        }}
      />,
    );
    await act(async () => {
      fireEvent.click(page.getByRole("button", { name: "Show options" }));
    });
    await act(async () => {
      fireEvent.change(page.getByRole("combobox", { name: "Filter repositories" }), {
        target: { value: "api" },
      });
    });
    await act(async () => {
      fireEvent.click(page.getByRole("option", { name: "acme/api" }));
    });
    expect(selected).toBe("acme-api");
  });

  test("expanded rows span only visible columns at mobile widths", async () => {
    const width = window.innerWidth;
    window.innerWidth = 390;
    try {
      const page = render(<UsageLedger repositories={usageFixture().repositories} />);
      await act(async () => {
        fireEvent.click(page.getByRole("button", { name: /^Companion Repository/ }));
      });
      const cell = page.container.querySelector(
        '[id="usage-detail-acme-companion"]',
      )!.parentElement!;
      expect(cell.getAttribute("colspan")).toBe("3");
      expect(cell.className).toContain("!text-left");
      expect(cell.className).toContain("!font-sans");
    } finally {
      window.innerWidth = width;
    }
  });

  test("UTC labels distinguish years and the daily table distinguishes unknown from zero", async () => {
    const fixture = usageFixture();
    fixture.window.start = "2025-12-31T00:00:00Z";
    fixture.window.endExclusive = "2026-01-02T00:00:00Z";
    fixture.daily = [
      { date: "2025-12-31", metrics: { ...fixture.totals, totalTokens: 0 } },
      { date: "2026-01-01", metrics: { ...fixture.totals, totalTokens: null } },
    ];
    const page = render(<UsagePanel {...actions} snapshot={fixture} />);
    expect(page.getByText(/Dec 31, 2025/).textContent).toContain("Jan 1, 2026");
    await act(async () => {
      fireEvent.click(page.getByRole("button", { name: "Table" }));
    });
    const rows = page
      .getByRole("table", { name: "Daily token usage and cost, UTC" })
      .querySelectorAll("tbody tr");
    expect(rows[0]!.querySelector("td")!.textContent).toBe("0");
    expect(rows[1]!.querySelector("td")!.textContent).toBe("—");
  });
});
