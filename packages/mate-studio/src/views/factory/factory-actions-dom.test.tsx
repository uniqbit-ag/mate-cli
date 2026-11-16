import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { FactoryRunView, StudioWorkset } from "@uniqbit/mate-core/studio";

import type { FactoryPayload } from "../../server/factory";

await import("../../../test/dom");
const { act, render } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const router = await import("@tanstack/react-router");

/** The actions the page posted, and the refusal the fake server answers next. */
const server = {
  posted: [] as { action: string; id?: string }[],
  refusal: null as string | null,
  /** What the page asked to add or remove, and what the fake server answers to adding next. */
  added: [] as { companion: string; input: unknown }[],
  removed: [] as string[],
  answers: [] as Array<Record<string, unknown>>,
};

const real = await import("../../server/factory");
mock.module("../../server/factory", () => ({
  ...real,
  runFactoryAction: async ({ data }: { data: { action: string; id?: string } }) => {
    server.posted.push({ action: data.action, id: data.id });
    if (server.refusal) throw new Error(server.refusal);
    return { ok: true };
  },
  addRepository: async ({ data }: { data: { companion: string; input: unknown } }) => {
    server.added.push(data);
    return server.answers.shift() ?? { ok: true, identity: "acme/api", existing: false };
  },
  removeRepository: async ({ data }: { data: { identity: string } }) => {
    server.removed.push(data.identity);
    return { ok: true };
  },
}));
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
  ...overrides,
});

const running: FactoryRunView = {
  state: "running",
  stage: "clarify",
  startedAt: "2026-11-02T11:00:00.000Z",
  updatedAt: "2026-11-02T11:00:00.000Z",
};

const payload = (
  worksets: StudioWorkset[],
  extra: Partial<FactoryPayload> = {},
): FactoryPayload => ({
  worksets,
  linkedRepositories: ["acme/web"],
  ticketFormat: "none",
  worksetProblems: [],
  warnings: [],
  ...extra,
});

/** The board at `/factory`, with the Outcome's panel open when `open` is set. */
async function mount(
  worksets: StudioWorkset[],
  runs: Record<string, FactoryRunView> = {},
  open = false,
  extra: { factoryMode?: boolean; payload?: Partial<FactoryPayload> } = {},
) {
  const root = router.createRootRoute();
  const route = router.createRoute({
    getParentRoute: () => root,
    path: "/factory",
    validateSearch: (raw: { outcome?: unknown }) =>
      typeof raw.outcome === "string" ? { outcome: raw.outcome } : {},
    component: function Board() {
      const { outcome: openId } = route.useSearch();
      return (
        <Factory
          payload={payload(worksets, extra.payload)}
          companionDigest="0123456789"
          writable
          factoryMode={extra.factoryMode}
          runs={runs}
          now={Date.parse("2026-11-02T12:00:00.000Z")}
          openId={openId}
        />
      );
    },
  });
  const instance = router.createRouter({
    routeTree: root.addChildren([route]),
    history: router.createMemoryHistory({
      initialEntries: [open ? "/factory?outcome=acme-onboarding" : "/factory"],
    }),
  });
  await instance.load();
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <router.RouterProvider router={instance} />
    </QueryClientProvider>,
  );
  await act(async () => {});
  const doc = view.container.ownerDocument;
  const button = (scope: ParentNode, label: string) =>
    [...scope.querySelectorAll("button")].find((entry) => entry.textContent === label);
  const panel = () => doc.querySelector<HTMLElement>("[data-outcome-panel]");
  const click = (element: HTMLElement) => act(async () => element.click());
  return { view, doc, router: instance, button, panel, click };
}

beforeEach(() => {
  server.posted = [];
  server.refusal = null;
  server.added = [];
  server.removed = [];
  server.answers = [];
});

/** The repository the Outcome input will submit: the Select's hidden input, or the fixed label's. */
const repositoryValue = (doc: Document) =>
  doc.querySelector<HTMLInputElement>('[data-outcome-input] input[name="repository"]')?.value;

/** Opens the Working Repository select and picks the option whose text starts with `name`. */
async function pickRepository(doc: Document, name: string) {
  await act(async () =>
    doc.querySelector<HTMLButtonElement>('[aria-label="Working Repository"]')!.click(),
  );
  const option = [...doc.querySelectorAll<HTMLElement>('[role="option"]')].find((entry) =>
    entry.textContent!.startsWith(name),
  )!;
  await act(async () => option.click());
}

describe("deleting an Outcome from the board", () => {
  it("is offered on a Later row and in the panel behind a confirm that names it", async () => {
    const { view, doc, button, click, panel } = await mount([outcome()], {}, true);
    const row = doc.querySelector<HTMLElement>('[data-section="later"] .outcome-row-item')!;
    expect(button(row, "Delete")).toBeDefined();
    expect(panel()!.textContent).not.toContain("Delete outcome");
    await click(button(panel()!, "Delete")!);
    expect(panel()!.textContent).toContain("Delete “Make onboarding easier”?");
    expect(panel()!.textContent).not.toContain("will be stopped");
    expect(server.posted).toEqual([]);
    view.unmount();
  });

  it("deletes after the confirm and closes the panel", async () => {
    const { view, router: app, button, click, panel } = await mount([outcome()], {}, true);
    await click(button(panel()!, "Delete")!);
    await click(button(panel()!, "Delete outcome")!);
    expect(server.posted).toEqual([{ action: "delete", id: "acme-onboarding" }]);
    expect(app.state.location.search).toEqual({});
    view.unmount();
  });

  it("deletes from a Later row after the confirm", async () => {
    const { view, doc, button, click } = await mount([outcome()]);
    const row = () => doc.querySelector<HTMLElement>('[data-section="later"] .outcome-row-item')!;
    await click(button(row(), "Delete")!);
    await click(button(row(), "Delete outcome")!);
    expect(server.posted).toEqual([{ action: "delete", id: "acme-onboarding" }]);
    view.unmount();
  });

  it("changes nothing when the confirm is cancelled", async () => {
    const { view, button, click, panel } = await mount([outcome()], {}, true);
    await click(button(panel()!, "Delete")!);
    await click(button(panel()!, "Cancel")!);
    expect(server.posted).toEqual([]);
    expect(button(panel()!, "Delete")).toBeDefined();
    expect(button(panel()!, "Delete outcome")).toBeUndefined();
    view.unmount();
  });

  it("shows the factory's refusal in place and keeps the panel open", async () => {
    server.refusal = "the broker refused: work is not pushed";
    const { view, router: app, button, click, panel } = await mount([outcome()], {}, true);
    await click(button(panel()!, "Delete")!);
    await click(button(panel()!, "Delete outcome")!);
    // The mutation settles after the click's own turn.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(panel()!.querySelector('[role="alert"]')?.textContent).toBe(
      "the broker refused: work is not pushed",
    );
    expect(app.state.location.search).toEqual({ outcome: "acme-onboarding" });
    view.unmount();
  });

  it("is offered for a running Outcome, and the confirm says its run will be stopped", async () => {
    const started = outcome({ queuedAt: "2026-11-02T09:00:00.000Z" });
    const { view, button, click, panel } = await mount(
      [started],
      { "acme-onboarding": running },
      true,
    );
    await click(button(panel()!, "Delete")!);
    expect(panel()!.textContent).toContain("Its run will be stopped first.");
    view.unmount();
  });

  it("is not offered once the Outcome has a change", async () => {
    const { view, button, panel } = await mount(
      [outcome({ stage: "apply", changes: ["acme-onboarding-plan"] })],
      {},
      true,
    );
    expect(button(panel()!, "Delete")).toBeUndefined();
    view.unmount();
  });

  it("is not offered while a person has taken over", async () => {
    const control: FactoryRunView = {
      ...running,
      state: "idle",
      control: { mode: "manual" },
    } as never;
    const { view, button, panel } = await mount([outcome()], { "acme-onboarding": control }, true);
    expect(button(panel()!, "Delete")).toBeUndefined();
    view.unmount();
  });
});

describe("adding a repository from the Outcome input", () => {
  const board = (extra: { factoryMode?: boolean; payload?: Partial<FactoryPayload> } = {}) =>
    mount([], {}, false, { factoryMode: true, ...extra });
  const dialog = (doc: Document) => doc.querySelector<HTMLElement>('[data-slot="dialog-content"]');
  const typeInto = (input: HTMLInputElement, text: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  const settle = () => act(async () => new Promise((done) => setTimeout(done, 20)));
  const open = async (doc: Document) => {
    await act(async () =>
      doc.querySelector<HTMLButtonElement>("[data-open-add-repository]")!.click(),
    );
    await settle();
  };
  const submit = async (doc: Document) => {
    await act(async () =>
      dialog(doc)!.querySelector<HTMLFormElement>("[data-add-repository-form]")!.requestSubmit(),
    );
    await settle();
  };

  it("is offered only in factory mode", async () => {
    const plain = await mount([], {}, false, { factoryMode: false });
    expect(plain.doc.querySelector("[data-open-add-repository]")).toBeNull();
    plain.view.unmount();
    const { doc, view } = await board();
    expect(doc.querySelector("[data-open-add-repository]")).not.toBeNull();
    view.unmount();
  });

  it("is offered when no repository is linked yet", async () => {
    const { doc, view } = await board({ payload: { linkedRepositories: [] } });
    expect(doc.querySelector("[data-outcome-input]")).toBeNull();
    expect(doc.querySelector("[data-open-add-repository]")).not.toBeNull();
    view.unmount();
  });

  it("adds by Git URL, selects it for the next Outcome and creates no Outcome", async () => {
    const { doc, view } = await board({
      payload: { linkedRepositories: ["acme/api", "acme/web"] },
    });
    await open(doc);
    await typeInto(
      dialog(doc)!.querySelector<HTMLInputElement>("input")!,
      "https://git.acme.test/acme/api.git",
    );
    await submit(doc);
    expect(server.added).toEqual([
      {
        companion: "0123456789",
        input: { kind: "url", url: "https://git.acme.test/acme/api.git" },
      },
    ]);
    expect(server.posted).toEqual([]);
    expect(repositoryValue(doc)).toBe("acme/api");
    expect(dialog(doc)).toBeNull();
    view.unmount();
  });

  it("adds from a local path in its own mode", async () => {
    const { doc, view } = await board();
    await open(doc);
    const tabs = [...dialog(doc)!.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Git URL", "Local path"]);
    await act(async () => tabs[1]!.click());
    expect(dialog(doc)!.textContent).toContain("not pushed there are not seen");
    await typeInto(dialog(doc)!.querySelector<HTMLInputElement>("input")!, "/home/dev/acme-web");
    await submit(doc);
    expect(server.added[0]!.input).toEqual({ kind: "path", path: "/home/dev/acme-web" });
    view.unmount();
  });

  it("shows a refusal in place and keeps the dialog", async () => {
    server.answers = [{ ok: false, reason: "reaching acme/api failed: repository not found" }];
    const { doc, view } = await board();
    await open(doc);
    await typeInto(
      dialog(doc)!.querySelector<HTMLInputElement>("input")!,
      "https://git.acme.test/acme/api.git",
    );
    await submit(doc);
    expect(dialog(doc)!.querySelector('[role="alert"]')!.textContent).toContain("not found");
    view.unmount();
  });

  it("offers the token form for the refused host and organization, then retries", async () => {
    server.answers = [
      {
        ok: false,
        reason: "authentication to git.acme.test/acme failed",
        tokenKey: "git.acme.test/acme",
      },
    ];
    const original = globalThis.fetch;
    const puts: string[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT" && typeof init.body === "string") puts.push(init.body);
      return Response.json({ tokens: [] });
    }) as typeof fetch;
    try {
      const { doc, view } = await board();
      await open(doc);
      await typeInto(
        dialog(doc)!.querySelector<HTMLInputElement>("input")!,
        "https://git.acme.test/acme/api.git",
      );
      await submit(doc);
      const token = dialog(doc)!.querySelector<HTMLFormElement>("[data-git-token-form]")!;
      expect(token.querySelector<HTMLInputElement>('[name="key"]')!.value).toBe(
        "git.acme.test/acme",
      );
      token.querySelector<HTMLInputElement>('[name="token"]')!.value = "acme-dom-secret";
      await act(async () => token.requestSubmit());
      await settle();
      expect(puts).toEqual([
        JSON.stringify({ key: "git.acme.test/acme", token: "acme-dom-secret" }),
      ]);
      expect(server.added).toHaveLength(2);
      expect(doc.body.innerHTML).not.toContain("acme-dom-secret");
      view.unmount();
    } finally {
      globalThis.fetch = original;
    }
  });

  it("offers Remove only for the entries the list holds", async () => {
    const { doc, view } = await board({
      payload: {
        linkedRepositories: ["acme/api", "acme/docs", "acme/web"],
        repositorySources: { "acme/api": "list", "acme/docs": "environment", "acme/web": "linked" },
      },
    });
    await open(doc);
    const listed = dialog(doc)!.querySelector("[data-listed-repositories]")!;
    expect([...listed.querySelectorAll("li")].map((item) => item.textContent)).toEqual([
      "acme/apiRemove",
    ]);
    await act(async () => listed.querySelector<HTMLButtonElement>("button")!.click());
    await settle();
    expect(server.removed).toEqual(["acme/api"]);
    view.unmount();
  });
});

describe("the Working Repository in the Outcome input", () => {
  const two = {
    linkedRepositories: ["acme/web", "other/api"],
    repositorySources: { "acme/web": "linked", "other/api": "list" },
    repositoryKeys: { "acme/web": "git.acme.test/acme", "other/api": "github.test/other" },
  } satisfies Partial<FactoryPayload>;
  const settle = () => act(async () => new Promise((done) => setTimeout(done, 20)));
  const dialog = (doc: Document) => doc.querySelector<HTMLElement>('[data-slot="dialog-content"]');
  const tokenNote = (doc: Document) => doc.querySelector("[data-repository-token]");

  /** Answers the Git token route with these keys; a PUT adds the key it was given. */
  async function withTokens<T>(keys: string[], run: () => Promise<T>): Promise<T> {
    const original = globalThis.fetch;
    const stored = [...keys];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT" && typeof init.body === "string") {
        stored.push((JSON.parse(init.body) as { key: string }).key);
      }
      return Response.json({
        tokens: stored.map((key) => ({ key, source: "studio", setAt: "2026-11-02T00:00:00Z" })),
      });
    }) as typeof fetch;
    try {
      return await run();
    } finally {
      globalThis.fetch = original;
    }
  }
  const board = async (extra: Partial<FactoryPayload>, factoryMode = true) => {
    const mounted = await mount([], {}, false, { factoryMode, payload: extra });
    await settle();
    return mounted;
  };

  it("shows one repository as a fixed label that is submitted", async () => {
    const { doc, view } = await board({
      linkedRepositories: ["acme/web"],
      repositorySources: { "acme/web": "linked" },
      repositoryKeys: { "acme/web": "git.acme.test/acme" },
    });
    expect(doc.querySelector('[aria-label="Working Repository"]')).toBeNull();
    expect(doc.querySelector("[data-working-repository]")!.textContent).toBe(
      "acme/web · git.acme.test · linked",
    );
    expect(doc.querySelector<HTMLInputElement>('input[name="repository"]')!.value).toBe("acme/web");
    view.unmount();
  });

  it("offers each repository with its host and source, and keeps the choice", async () => {
    const { doc, view } = await board(two);
    expect(repositoryValue(doc)).toBe("acme/web");
    await act(async () =>
      doc.querySelector<HTMLButtonElement>('[aria-label="Working Repository"]')!.click(),
    );
    expect(
      [...doc.querySelectorAll('[role="option"]')].map((option) => option.textContent),
    ).toEqual(["acme/web · git.acme.test · linked", "other/api · github.test · listed"]);
    await act(async () => [...doc.querySelectorAll<HTMLElement>('[role="option"]')][1]!.click());
    expect(repositoryValue(doc)).toBe("other/api");
    view.unmount();
  });

  it("shows covered for an organization token, a host token and a startup token", async () => {
    for (const key of ["github.test/other", "github.test"]) {
      await withTokens([key], async () => {
        const { doc, view } = await board({ ...two, linkedRepositories: ["other/api"] });
        expect(tokenNote(doc)!.getAttribute("data-repository-token")).toBe("covered");
        view.unmount();
      });
    }
  });

  it("says only public repositories clone when no token covers the choice", async () => {
    await withTokens(["git.acme.test/acme"], async () => {
      const { doc, view } = await board({ ...two, linkedRepositories: ["other/api"] });
      expect(tokenNote(doc)!.getAttribute("data-repository-token")).toBe("none");
      expect(tokenNote(doc)!.textContent).toContain("only public repositories clone");
      view.unmount();
    });
  });

  it("shows no token state outside factory mode", async () => {
    await withTokens([], async () => {
      const { doc, view } = await board(two, false);
      expect(tokenNote(doc)).toBeNull();
      expect(doc.querySelector("[data-open-set-token]")).toBeNull();
      view.unmount();
    });
  });

  it("sets the token in place, keeping the typed text and the choice", async () => {
    await withTokens([], async () => {
      const { doc, view } = await board(two);
      await pickRepository(doc, "other/api");
      const text = doc.querySelector<HTMLTextAreaElement>("[data-outcome-input] textarea")!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
          text,
          "Make onboarding easier",
        );
        text.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => doc.querySelector<HTMLButtonElement>("[data-open-set-token]")!.click());
      await settle();
      const form = dialog(doc)!.querySelector<HTMLFormElement>("[data-git-token-form]")!;
      expect(form.querySelector<HTMLInputElement>('[name="key"]')!.value).toBe("github.test/other");
      form.querySelector<HTMLInputElement>('[name="token"]')!.value = "acme-dom-secret";
      await act(async () => form.requestSubmit());
      await settle();
      expect(tokenNote(doc)!.getAttribute("data-repository-token")).toBe("covered");
      expect(doc.querySelector<HTMLTextAreaElement>("[data-outcome-input] textarea")!.value).toBe(
        "Make onboarding easier",
      );
      expect(repositoryValue(doc)).toBe("other/api");
      expect(doc.body.innerHTML).not.toContain("acme-dom-secret");
      view.unmount();
    });
  });
});
