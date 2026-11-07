import { describe, expect, it } from "bun:test";
import type { FactoryRunView, StudioWorkset } from "@uniqbit/mate-core/studio";

import type { FactoryPayload } from "../../server/factory";

await import("../../../test/dom");
const { act, render } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const router = await import("@tanstack/react-router");
const { create } = await import("zustand");
const { Factory } = await import("./factory-view");

const outcome = (overrides: Partial<StudioWorkset> = {}): StudioWorkset => ({
  id: "acme-onboarding",
  title: "Make onboarding easier",
  intent: "Make onboarding easier.",
  repositories: ["acme/web"],
  changes: [],
  stage: "clarify-intent",
  stageLabel: "Clarify intent",
  turn: "human",
  problems: [],
  queuedAt: "2026-11-02T09:00:00.000Z",
  ...overrides,
});

const payload = (worksets: StudioWorkset[]): FactoryPayload => ({
  worksets,
  linkedRepositories: ["acme/web"],
  ticketFormat: "none",
  worksetProblems: [],
  warnings: [],
});

const waiting: FactoryRunView = {
  state: "waiting",
  stage: "clarify",
  questions: [{ question: "Launch languages?" }],
  round: "acme-round",
  updatedAt: "2026-11-02T10:00:00.000Z",
};

/** The board inside a router at `/factory`; `update` swaps its data like a refetch does. */
async function mount(initial: { worksets: StudioWorkset[]; runs: Record<string, FactoryRunView> }) {
  const board = create(() => initial);
  const root = router.createRootRoute();
  const route = router.createRoute({
    getParentRoute: () => root,
    path: "/factory",
    validateSearch: (raw: { outcome?: unknown }) =>
      typeof raw.outcome === "string" ? { outcome: raw.outcome } : {},
    component: function Board() {
      const { worksets, runs } = board();
      const { outcome: openId } = route.useSearch();
      return (
        <Factory
          payload={payload(worksets)}
          companionDigest="0123456789"
          writable
          runs={runs}
          now={Date.parse("2026-11-02T12:00:00.000Z")}
          openId={openId}
        />
      );
    },
  });
  const instance = router.createRouter({
    routeTree: root.addChildren([route]),
    history: router.createMemoryHistory({ initialEntries: ["/factory"] }),
  });
  await instance.load();
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <router.RouterProvider router={instance} />
    </QueryClientProvider>,
  );
  await act(async () => {});
  return {
    view,
    router: instance,
    update: (next: typeof initial) => act(() => board.setState(next)),
  };
}

describe("the Factory board in a browser", () => {
  it("keeps typed text and focus when the board updates under an open panel", async () => {
    const {
      view,
      update,
      router: app,
    } = await mount({
      worksets: [outcome()],
      runs: { "acme-onboarding": waiting },
    });
    await act(() => app.navigate({ to: "/factory", search: { outcome: "acme-onboarding" } }));
    const answer = view.container.ownerDocument.querySelector<HTMLTextAreaElement>(
      '[data-outcome-panel] textarea[name="answer"]',
    )!;
    answer.focus();
    answer.value = "English and German";
    await update({
      worksets: [outcome({ title: "Make onboarding much easier" })],
      runs: { "acme-onboarding": waiting },
    });
    const after = view.container.ownerDocument.querySelector<HTMLTextAreaElement>(
      '[data-outcome-panel] textarea[name="answer"]',
    )!;
    expect(view.container.ownerDocument.querySelector("[data-outcome-panel] h2")?.textContent).toBe(
      "Make onboarding much easier",
    );
    expect(after).toBe(answer);
    expect(after.value).toBe("English and German");
    expect(view.container.ownerDocument.activeElement).toBe(after);
    view.unmount();
  });

  it("opens an Outcome from its row and closes it again on Back", async () => {
    const { view, router: app } = await mount({ worksets: [outcome()], runs: {} });
    const doc = view.container.ownerDocument;
    expect(doc.querySelector("[data-outcome-panel]")).toBeNull();
    await act(async () => doc.querySelector<HTMLButtonElement>("[data-outcome-row]")!.click());
    expect(app.state.location.search).toEqual({ outcome: "acme-onboarding" });
    expect(doc.querySelector("[data-outcome-panel]")?.getAttribute("data-workset")).toBe(
      "acme-onboarding",
    );
    await act(async () => app.history.back());
    await act(async () => {});
    expect(doc.querySelector("[data-outcome-panel]")).toBeNull();
    view.unmount();
  });
});

describe("a review report in the panel", () => {
  const review = (id: string, title: string) =>
    outcome({
      id,
      title,
      stage: "human-review",
      stageLabel: "Human Reviews",
      changes: ["acme-login", "acme-signup"],
    });
  const reviewed = (reports: Record<string, string>, extra: Partial<FactoryRunView> = {}) =>
    ({ state: "idle", updatedAt: "", reviewReports: reports, ...extra }) as FactoryRunView;

  async function opened(
    runs: Record<string, FactoryRunView>,
    worksets = [review("acme-onboarding", "Make onboarding easier")],
  ) {
    const mounted = await mount({ worksets, runs });
    await act(() =>
      mounted.router.navigate({ to: "/factory", search: { outcome: worksets[0]!.id } }),
    );
    const doc = mounted.view.container.ownerDocument;
    const panel = () => doc.querySelector<HTMLElement>("[data-outcome-panel]")!;
    const click = (selector: string) =>
      act(async () => doc.querySelector<HTMLButtonElement>(selector)!.click());
    return { ...mounted, doc, panel, click };
  }

  it("opens one report in place of the Outcome and goes Back to the review", async () => {
    const { view, panel, click } = await opened({
      "acme-onboarding": reviewed({ "acme-login": "r1", "acme-signup": "r2" }),
    });
    expect(panel().querySelector("iframe")).toBeNull();
    await click('[aria-label="Needs you"] [data-open-report="acme-signup"]');
    expect(panel().getAttribute("data-layout")).toBe("report");
    const frames = panel().querySelectorAll("iframe");
    expect(frames).toHaveLength(1);
    expect(frames[0]!.getAttribute("src")).toBe("/studio/reports/r2");
    expect(panel().querySelector("h2")?.textContent).toContain("acme-signup");
    expect(panel().querySelector('a[target="_blank"]')?.getAttribute("href")).toBe(
      "/studio/reports/r2",
    );
    await click(".outcome-report-back");
    expect(panel().getAttribute("data-layout")).toBeNull();
    expect(panel().querySelectorAll('[aria-label="Needs you"] [data-open-report]')).toHaveLength(2);
    view.unmount();
  });

  it("shows the next Outcome's content when stepping away from a report", async () => {
    const { view, panel, click } = await opened(
      {
        "acme-onboarding": reviewed({ "acme-login": "r1", "acme-signup": "r2" }),
        "acme-checkout": reviewed({ "acme-login": "r3", "acme-signup": "r4" }),
      },
      [
        review("acme-onboarding", "Make onboarding easier"),
        review("acme-checkout", "Faster checkout"),
      ],
    );
    // Start from the first row, so Next has somewhere to go.
    await click("[data-outcome-row]");
    const first = panel().getAttribute("data-workset");
    await click('[aria-label="Needs you"] [data-open-report="acme-login"]');
    expect(panel().getAttribute("data-layout")).toBe("report");
    await click('[aria-label="Next"]');
    expect(panel().getAttribute("data-workset")).not.toBe(first);
    expect(panel().getAttribute("data-layout")).toBeNull();
    expect(panel().querySelector("iframe")).toBeNull();
    view.unmount();
  });

  it("keeps a typed draft behind a report and moves focus to Back and back again", async () => {
    const { view, doc, panel, click } = await opened({
      "acme-onboarding": reviewed({ "acme-login": "r1", "acme-signup": "r2" }),
    });
    const draft = panel().querySelector<HTMLTextAreaElement>("textarea")!;
    draft.value = "Shorter steps";
    const opener = '[aria-label="Needs you"] [data-open-report="acme-login"]';
    await click(opener);
    expect(doc.activeElement).toBe(panel().querySelector(".outcome-report-back"));
    await click(".outcome-report-back");
    expect(panel().querySelector("textarea")).toBe(draft);
    expect(draft.value).toBe("Shorter steps");
    expect(doc.activeElement).toBe(panel().querySelector(opener));
    view.unmount();
  });

  it("stays on the review when a regenerated report replaces the open one", async () => {
    const { view, panel, click, update } = await opened({
      "acme-onboarding": reviewed({ "acme-login": "r1", "acme-signup": "r2" }),
    });
    const worksets = [review("acme-onboarding", "Make onboarding easier")];
    await click('[aria-label="Needs you"] [data-open-report="acme-login"]');
    expect(panel().getAttribute("data-layout")).toBe("report");
    await update({ worksets, runs: { "acme-onboarding": reviewed({ "acme-signup": "r2" }) } });
    expect(panel().getAttribute("data-layout")).toBeNull();
    await update({
      worksets,
      runs: { "acme-onboarding": reviewed({ "acme-login": "r3", "acme-signup": "r2" }) },
    });
    expect(panel().getAttribute("data-layout")).toBeNull();
    expect(panel().querySelector("iframe")).toBeNull();
    view.unmount();
  });

  it("opens Review plan in the panel and keeps View changes external", async () => {
    const { view, panel, click } = await opened(
      {
        "acme-onboarding": reviewed(
          { "acme-login": "r1" },
          { compareUrl: "https://github.com/acme/web/compare/main...workset/acme-onboarding" },
        ),
      },
      [
        outcome({
          stage: "merge-wait",
          stageLabel: "Waiting for merge",
          changes: ["acme-login"],
        }),
      ],
    );
    const results = panel().querySelector(".outcome-results")!;
    expect(results.querySelector("a")?.textContent).toBe("View changes");
    expect(results.querySelector("a")?.getAttribute("target")).toBe("_blank");
    await click('.outcome-results [data-open-report="acme-login"]');
    expect(panel().getAttribute("data-layout")).toBe("report");
    expect(panel().querySelector("iframe")?.getAttribute("src")).toBe("/studio/reports/r1");
    view.unmount();
  });
});
