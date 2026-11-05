import { describe, expect, it } from "bun:test";
import type { StudioCompanionPayload } from "@uniqbit/mate-core/studio";
import type { ReactElement } from "react";

await import("../../test/dom");
const { act } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const router = await import("@tanstack/react-router");
const { renderToString } = await import("react-dom/server");
const { createRoot } = await import("react-dom/client");
const { AnalystOverview } = await import("../views/overview/analyst-overview");
const { Dashboard } = await import("../views/overview/dashboard");
const { Skills } = await import("../views/skills/skills-view");
const { Specs } = await import("../views/specs/specs-view");
const { Workflow } = await import("../views/workflow/workflow-view");

const payload = {
  companionPath: "/home/dev/.mate/companions/acme-companion",
  changes: [
    {
      name: "acme-build",
      completedTasks: 2,
      totalTasks: 5,
      status: "in-progress",
      artifacts: [{ id: "tasks" }],
    },
  ],
  specs: [{ capability: "acme-login", areas: ["acme"], requirementCount: 3, valid: true }],
  shipped: [
    {
      name: "acme-checkout",
      anchor: "2026-02-10-acme-checkout",
      archivedOn: "2026-02-10",
      specs: ["acme-login"],
      hasProposal: true,
    },
  ],
  skills: ["mate-grill-me", "mate-apply-change"],
  skillInventory: { claude: ["mate-grill-me"], opencode: [], agents: [] },
  topology: null,
  warnings: [],
} as unknown as StudioCompanionPayload;

const VIEWS: [string, ReactElement][] = [
  ["Overview", <Dashboard key="view" payload={payload} companion="0123456789" />],
  ["Analysis Overview", <AnalystOverview key="view" payload={payload} />],
  ["Workflow", <Workflow key="view" payload={payload} changes={payload.changes} />],
  ["Skills", <Skills key="view" skills={payload.skillInventory} companion="0123456789" />],
  ["Specs", <Specs key="view" payload={payload} companion="0123456789" />],
];

async function page(element: ReactElement): Promise<ReactElement> {
  const root = router.createRootRoute();
  const instance = router.createRouter({
    routeTree: root,
    history: router.createMemoryHistory({
      initialEntries: ["/?companion=0123456789&studioMode=engineering"],
    }),
  });
  await instance.load();
  return (
    <QueryClientProvider client={new QueryClient()}>
      <router.RouterContextProvider router={instance}>{element}</router.RouterContextProvider>
    </QueryClientProvider>
  );
}

/**
 * What hydration must agree on: the text and the element structure. Attribute spelling differs
 * between the two serializers, and roving focus sets `tabindex` after mount.
 */
function shape(root: Element): { text: string; tags: string } {
  return {
    text: root.textContent ?? "",
    tags: [...root.querySelectorAll("*")].map((element) => element.tagName).join(" "),
  };
}

/**
 * Server-drawn views must be taken over in the browser without React redrawing them: the
 * browser's first render must produce the markup the server sent.
 */
describe("server-drawn views", () => {
  for (const [name, element] of VIEWS) {
    it(`${name} renders the same in the browser as on the server`, async () => {
      const server = document.createElement("div");
      server.innerHTML = renderToString(await page(element));
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      try {
        const browser = await page(element);
        await act(async () => root.render(browser));
        expect(shape(container)).toEqual(shape(server));
      } finally {
        await act(async () => root.unmount());
        container.remove();
      }
    });
  }
});
