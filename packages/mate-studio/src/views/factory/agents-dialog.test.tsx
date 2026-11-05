import { afterEach, describe, expect, it } from "bun:test";
import type { CredentialStatus, FactoryRunView, StudioWorkset } from "@uniqbit/mate-core/studio";

await import("../../../test/dom");
const { act, render } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const router = await import("@tanstack/react-router");
const { AgentsDialog } = await import("./agents-dialog");
const { Factory } = await import("./factory-view");
const { useFactoryUi } = await import("../../stores/factory-ui");

const KEY = "sk-ant-api03-acme-dom-key";
const none: CredentialStatus = { kind: null, source: null, setAt: null };
const studioKey: CredentialStatus = {
  kind: "api-key",
  source: "studio",
  setAt: "2026-11-02T10:00:00.000Z",
};

/** Answers the credential routes from `routes`, recording each request's method, path and body. */
function fakeFetch(routes: Record<string, unknown>) {
  const calls: Array<{ method: string; path: string; body: string | null }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = String(input);
    calls.push({ method, path, body: typeof init?.body === "string" ? init.body : null });
    const answer = routes[`${method} ${path}`];
    return answer === undefined
      ? new Response(JSON.stringify({ reason: "not found" }), { status: 404 })
      : Response.json(answer);
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

let restore: () => void = () => {};

/** Lets fetches, queries and mutations settle. */
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));
afterEach(() => {
  restore();
  useFactoryUi.setState({ agentsOpen: false });
});

async function mountDialog(routes: Record<string, unknown>) {
  const fake = fakeFetch(routes);
  restore = fake.restore;
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <AgentsDialog onClose={() => {}} />
    </QueryClientProvider>,
  );
  await settle();
  const doc = view.container.ownerDocument;
  return { view, doc, calls: fake.calls };
}

async function submit(doc: Document, selector: string, name: string, value: string) {
  const form = doc.querySelector<HTMLFormElement>(selector)!;
  form.querySelector<HTMLInputElement>(`[name="${name}"]`)!.value = value;
  await act(async () => form.requestSubmit());
  await settle();
  return form;
}

describe("the Agents panel", () => {
  it("shows the status without any part of a value", async () => {
    const { view, doc } = await mountDialog({ "GET /api/factory/credential": studioKey });
    const status = doc.querySelector("[data-agents-status]")!.textContent!;
    expect(status).toStartWith("Anthropic API key, set in Studio on");
    expect(doc.body.innerHTML).not.toContain("sk-ant-api03");
    view.unmount();
  });

  it("saves an API key in one request and empties the field", async () => {
    const { view, doc, calls } = await mountDialog({
      "GET /api/factory/credential": none,
      "PUT /api/factory/credential": studioKey,
    });
    await act(async () => doc.querySelector<HTMLButtonElement>("#agents-tab-api-key")!.click());
    const form = await submit(doc, '[data-agents-form="api-key"]', "value", KEY);
    expect(calls.filter((call) => call.method === "PUT")).toEqual([
      {
        method: "PUT",
        path: "/api/factory/credential",
        body: JSON.stringify({ kind: "api-key", value: KEY }),
      },
    ]);
    expect(form.querySelector<HTMLInputElement>('[name="value"]')!.value).toBe("");
    expect(form.querySelector<HTMLInputElement>('[name="value"]')!.type).toBe("password");
    expect(doc.querySelector("[data-agents-status]")!.textContent).toContain("set in Studio");
    expect(doc.body.innerHTML).not.toContain(KEY);
    view.unmount();
  });

  it("explains claude setup-token and saves the pasted token as a subscription", async () => {
    const { view, doc, calls } = await mountDialog({
      "GET /api/factory/credential": none,
      "PUT /api/factory/credential": { ...studioKey, kind: "subscription" },
    });
    expect(doc.querySelector('[data-agents-form="subscription"]')!.textContent).toContain(
      "claude setup-token",
    );
    await submit(doc, '[data-agents-form="subscription"]', "value", "sk-ant-oat01-acme");
    expect(JSON.parse(calls.find((call) => call.method === "PUT")!.body!).kind).toBe(
      "subscription",
    );
    view.unmount();
  });

  it("offers Clear only for a credential set in Studio", async () => {
    const startup = await mountDialog({
      "GET /api/factory/credential": { kind: "api-key", source: "startup", setAt: null },
    });
    expect(startup.doc.querySelector(".agents-clear")).toBeNull();
    startup.view.unmount();
    restore();

    const { view, doc, calls } = await mountDialog({
      "GET /api/factory/credential": studioKey,
      "DELETE /api/factory/credential": none,
    });
    await act(async () => doc.querySelector<HTMLButtonElement>(".agents-clear button")!.click());
    await settle();
    expect(calls.some((call) => call.method === "DELETE")).toBe(true);
    expect(doc.querySelector(".agents-clear")).toBeNull();
    expect(doc.querySelector("[data-agents-status]")!.textContent).toStartWith("No credential");
    view.unmount();
  });
});

describe("the Agents button", () => {
  async function mountBoard(
    factoryMode: boolean,
    board: { worksets: StudioWorkset[]; runs: Record<string, FactoryRunView> } = {
      worksets: [],
      runs: {},
    },
    openId?: string,
  ) {
    const root = router.createRootRoute();
    const route = router.createRoute({
      getParentRoute: () => root,
      path: "/factory",
      component: () => (
        <Factory
          payload={{
            worksets: board.worksets,
            linkedRepositories: ["acme/web"],
            ticketFormat: "none",
            topology: null,
            worksetProblems: [],
            warnings: [],
          }}
          companionDigest="0123456789"
          writable
          runs={board.runs}
          factoryMode={factoryMode}
          openId={openId}
        />
      ),
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
    await settle();
    return view;
  }

  it("is hidden outside factory mode", async () => {
    const view = await mountBoard(false);
    expect(view.container.querySelector("[data-open-agents]")).toBeNull();
    view.unmount();
  });

  it("opens the panel in factory mode", async () => {
    const fake = fakeFetch({ "GET /api/factory/credential": none });
    restore = fake.restore;
    const view = await mountBoard(true);
    const doc = view.container.ownerDocument;
    await act(async () => doc.querySelector<HTMLButtonElement>("[data-open-agents]")!.click());
    await settle();
    expect(doc.querySelector("#agents-title")?.textContent).toBe("Workset agents");
    view.unmount();
  });

  it("is linked from a run refused for a missing credential", async () => {
    const fake = fakeFetch({ "GET /api/factory/credential": none });
    restore = fake.restore;
    const view = await mountBoard(
      true,
      {
        worksets: [
          {
            id: "acme-onboarding",
            title: "Make onboarding easier",
            intent: "Make onboarding easier.",
            repositories: ["acme/web"],
            changes: [],
            stage: "clarify-intent",
            stageLabel: "Clarify intent",
            turn: "agent",
            problems: [],
            queuedAt: "2026-11-02T09:00:00.000Z",
          },
        ],
        runs: {
          "acme-onboarding": {
            state: "failed",
            stage: "clarify",
            reason: "no Workset agent credential is configured; set one in the Agents panel",
            updatedAt: "2026-11-02T10:00:00.000Z",
            needsCredential: true,
          },
        },
      },
      "acme-onboarding",
    );
    const doc = view.container.ownerDocument;
    const links = doc.querySelectorAll<HTMLButtonElement>("dialog [data-open-agents]");
    expect(links).toHaveLength(1);
    await act(async () => links[0]!.click());
    await settle();
    expect(doc.querySelector("#agents-title")?.textContent).toBe("Workset agents");
    view.unmount();
  });
});
