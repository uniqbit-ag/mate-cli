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
  topology: null,
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
