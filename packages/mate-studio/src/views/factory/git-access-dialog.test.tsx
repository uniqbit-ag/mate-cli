import { afterEach, describe, expect, it } from "bun:test";
import type { GitTokenStatus } from "@uniqbit/mate-core/studio";

await import("../../../test/dom");
const { act, render } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const router = await import("@tanstack/react-router");
const { GitAccessDialog } = await import("./git-access-dialog");
const { GitTokenForm } = await import("./git-token-form");
const { Factory } = await import("./factory-view");
const { useFactoryUi } = await import("../../stores/factory-ui");

const SECRET = "acme-dom-git-secret";
const ROUTE = "/api/factory/git-tokens";
const studioKey: GitTokenStatus = {
  key: "git.acme.test/acme",
  source: "studio",
  setAt: "2026-11-10T10:00:00.000Z",
};
const startupKey: GitTokenStatus = { key: "git.example.test", source: "startup", setAt: null };

/** Answers the Git token route from `routes`, recording each request's method, path and body. */
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

const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));
afterEach(() => {
  restore();
  useFactoryUi.setState({ gitAccessOpen: false });
});

async function mount(routes: Record<string, unknown>, ui = <GitAccessDialog onClose={() => {}} />) {
  const fake = fakeFetch(routes);
  restore = fake.restore;
  const view = render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);
  await settle();
  return { view, doc: view.container.ownerDocument, calls: fake.calls };
}

async function submit(doc: Document, key: string, token: string) {
  const form = doc.querySelector<HTMLFormElement>("[data-git-token-form]")!;
  form.querySelector<HTMLInputElement>('[name="key"]')!.value = key;
  form.querySelector<HTMLInputElement>('[name="token"]')!.value = token;
  await act(async () => form.requestSubmit());
  await settle();
  return form;
}

describe("the Git access panel", () => {
  it("lists each key with its source and never a token", async () => {
    const { view, doc } = await mount({ [`GET ${ROUTE}`]: { tokens: [studioKey, startupKey] } });
    const keys = [...doc.querySelectorAll("[data-git-access-key]")];
    expect(keys.map((item) => item.getAttribute("data-git-access-key"))).toEqual([
      "git.acme.test/acme",
      "git.example.test",
    ]);
    expect(keys[0]!.textContent).toContain("set in Studio on 2026-11-10");
    expect(keys[1]!.textContent).toContain("supplied at startup");
    expect(doc.querySelector("[data-git-access-status]")!.textContent).toBe("2 keys set.");
    view.unmount();
  });

  it("sets a token in one request, empties the field and shows the key", async () => {
    const { view, doc, calls } = await mount({
      [`GET ${ROUTE}`]: { tokens: [] },
      [`PUT ${ROUTE}`]: { tokens: [studioKey] },
    });
    const form = await submit(doc, "git.acme.test/acme", SECRET);
    expect(calls.filter((call) => call.method === "PUT")).toEqual([
      {
        method: "PUT",
        path: ROUTE,
        body: JSON.stringify({ key: "git.acme.test/acme", token: SECRET }),
      },
    ]);
    const field = form.querySelector<HTMLInputElement>('[name="token"]')!;
    expect(field.value).toBe("");
    expect(field.type).toBe("password");
    expect(doc.querySelector('[data-git-access-key="git.acme.test/acme"]')).not.toBeNull();
    expect(doc.body.innerHTML).not.toContain(SECRET);
    view.unmount();
  });

  it("shows the broker's refusal in place", async () => {
    const { view, doc } = await mount({ [`GET ${ROUTE}`]: { tokens: [] } });
    await submit(doc, "a.test/one/two", SECRET);
    expect(doc.querySelector('[role="alert"]')!.textContent).toContain("not found");
    expect(doc.body.innerHTML).not.toContain(SECRET);
    view.unmount();
  });

  it("offers Remove only for a key set in Studio", async () => {
    const { view, doc, calls } = await mount({
      [`GET ${ROUTE}`]: { tokens: [studioKey, startupKey] },
      [`DELETE ${ROUTE}`]: { tokens: [startupKey] },
    });
    expect(doc.querySelectorAll("[data-git-access-key] button")).toHaveLength(1);
    expect(doc.querySelector('[data-git-access-key="git.example.test"] button')).toBeNull();
    await act(async () =>
      doc
        .querySelector<HTMLButtonElement>('[data-git-access-key="git.acme.test/acme"] button')!
        .click(),
    );
    await settle();
    expect(calls.find((call) => call.method === "DELETE")!.body).toBe(
      JSON.stringify({ key: "git.acme.test/acme" }),
    );
    expect(doc.querySelector('[data-git-access-key="git.acme.test/acme"]')).toBeNull();
    view.unmount();
  });
});

describe("the Git token form", () => {
  it("opens with the key of the refused URL filled in", async () => {
    const { view, doc } = await mount({}, <GitTokenForm defaultKey="git.acme.test/acme" />);
    expect(doc.querySelector<HTMLInputElement>('[name="key"]')!.value).toBe("git.acme.test/acme");
    view.unmount();
  });

  it("reports the saved tokens to its caller", async () => {
    let saved: string[] = [];
    const { view, doc } = await mount(
      { [`PUT ${ROUTE}`]: { tokens: [studioKey] } },
      <GitTokenForm onSaved={(next) => (saved = next.tokens.map((token) => token.key))} />,
    );
    await submit(doc, "git.acme.test/acme", SECRET);
    expect(saved).toEqual(["git.acme.test/acme"]);
    view.unmount();
  });
});

describe("the Git access button", () => {
  async function mountBoard(factoryMode: boolean) {
    const root = router.createRootRoute();
    const route = router.createRoute({
      getParentRoute: () => root,
      path: "/factory",
      component: () => (
        <Factory
          payload={{
            worksets: [],
            linkedRepositories: ["acme/web"],
            ticketFormat: "none",
            worksetProblems: [],
            warnings: [],
          }}
          companionDigest="0123456789"
          writable
          runs={{}}
          factoryMode={factoryMode}
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
    expect(view.container.querySelector("[data-open-git-access]")).toBeNull();
    view.unmount();
  });

  it("opens the panel in factory mode", async () => {
    const fake = fakeFetch({ [`GET ${ROUTE}`]: { tokens: [] } });
    restore = fake.restore;
    const view = await mountBoard(true);
    const doc = view.container.ownerDocument;
    await act(async () => doc.querySelector<HTMLButtonElement>("[data-open-git-access]")!.click());
    await settle();
    expect(doc.querySelector("#git-access-title")?.textContent).toBe("Git access");
    view.unmount();
  });
});
