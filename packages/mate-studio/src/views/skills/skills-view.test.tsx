import { describe, expect, it } from "bun:test";
import type { StudioSkillInventory } from "@uniqbit/mate-core/studio";

await import("../../../test/dom");
const { act, render: mountDom } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const router = await import("@tanstack/react-router");
const { staticMarkup } = await import("../../../test/render");
const { Skills } = await import("./skills-view");
const { skillPreviewQuery } = await import("../../lib/studio-queries");

function render(skills: StudioSkillInventory): string {
  return staticMarkup(<Skills skills={skills} />);
}

async function mount(skills: StudioSkillInventory, client = new QueryClient(), companion?: string) {
  const root = router.createRootRoute();
  const route = router.createRoute({
    getParentRoute: () => root,
    path: "/skills",
    component: () => <Skills skills={skills} companion={companion} />,
  });
  const instance = router.createRouter({
    routeTree: root.addChildren([route]),
    history: router.createMemoryHistory({ initialEntries: ["/skills"] }),
  });
  await instance.load();
  const page = mountDom(
    <QueryClientProvider client={client}>
      <router.RouterProvider router={instance} />
    </QueryClientProvider>,
  );
  await act(async () => {});
  return { page, doc: page.container.ownerDocument };
}

const settle = () => act(async () => new Promise((done) => setTimeout(done, 20)));

describe("Skills", () => {
  it("lists every runtime's skills without merging them", () => {
    const markup = render({
      claude: ["claude-only", "shared-skill"],
      opencode: ["opencode-only", "shared-skill"],
      agents: ["agent-only", "shared-skill"],
    });
    expect(markup).toContain("claude-only");
    expect(markup).toContain("opencode-only");
    expect(markup).toContain("agent-only");
    expect(markup.match(/data-skill="shared-skill"/g)).toHaveLength(3);
  });

  it("offers one filter with each agent's count, starting on Claude", () => {
    const markup = render({ claude: ["mate-interview-me"], opencode: [], agents: [] });
    expect(markup).toContain('aria-label="Agent"');
    expect(markup).toMatch(/aria-pressed="true"[^>]*>Claude<span[^>]*>1<\/span>/);
    expect(markup).toMatch(/aria-pressed="false"[^>]*>OpenCode<span[^>]*>0<\/span>/);
    expect(markup).toMatch(/data-skill-panel="claude" data-active="true"/);
    expect(markup).toMatch(/aria-hidden="true" data-skill-panel="opencode"/);
    expect(markup).toContain("OpenCode has no skills in this companion.");
    expect(markup).toContain("Agents has no skills in this companion.");
  });

  it("lists Delivery Path skills first, in path order, each naming its stage", () => {
    const markup = render({
      claude: ["mate-archive-change", "acme-helper", "mate-apply-change", "mate-grilling"],
      opencode: [],
      agents: [],
    });
    const at = (text: string) => markup.indexOf(text);
    expect(at(">Delivery Path</h2>")).toBeLessThan(at(">Used by other skills</h2>"));
    expect(at('data-skill="mate-apply-change"')).toBeLessThan(
      at('data-skill="mate-archive-change"'),
    );
    expect(markup).toMatch(/data-skill="mate-apply-change"[\s\S]*?Apply change/);
    // Its group already says it is used by other skills; the row does not repeat it.
    expect(markup).toMatch(/data-skill="mate-grilling"><span[^>]*>mate-grilling<\/span><\/button>/);
    expect(at(">Other skills</h2>")).toBeGreaterThan(at(">Used by other skills</h2>"));
  });

  it("renders no skills when the inventory is absent", () => {
    expect(staticMarkup(<Skills />)).toContain("Claude has no skills in this companion.");
  });

  it("switches agent in place, hiding the others from assistive technology", async () => {
    const { page, doc } = await mount({
      claude: ["claude-only"],
      opencode: ["opencode-only"],
      agents: [],
    });
    const pills = [...doc.querySelectorAll<HTMLButtonElement>('[aria-label="Agent"] button')];
    await act(async () => pills[1]!.click());
    expect(doc.querySelector('[data-skill-panel="opencode"]')?.getAttribute("aria-hidden")).toBe(
      "false",
    );
    expect(doc.querySelector('[data-skill-panel="claude"]')?.getAttribute("aria-hidden")).toBe(
      "true",
    );
    page.unmount();
  });

  it("opens a skill with its start command and where it is installed", async () => {
    const { page, doc } = await mount({
      claude: ["mate-apply-change", "mate-grilling"],
      opencode: [],
      agents: ["mate-apply-change"],
    });
    await act(async () =>
      doc.querySelector<HTMLButtonElement>('[data-skill="mate-apply-change"]')!.click(),
    );
    await settle();
    const panel = doc.querySelector('[data-slot="sheet-content"]')!;
    expect(panel.querySelector('[data-copy="/mate-apply-change"]')).not.toBeNull();
    expect(panel.textContent).toContain(".claude/skills/mate-apply-change/");
    expect(panel.textContent).toContain(".agents/skills/mate-apply-change/");
    await act(async () =>
      panel.querySelector<HTMLButtonElement>('button[aria-label="Next"]')!.click(),
    );
    await settle();
    const loaded = doc.querySelector('[data-slot="sheet-content"]')!;
    expect(loaded.textContent).toContain("Used by other skills");
    expect(loaded.querySelector("[data-copy]")).toBeNull();
    page.unmount();
  });

  it("previews the skill's files read-only, SKILL.md first, another on choosing it", async () => {
    const companion = "0123456789";
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
    const md = (text: string) => [{ t: "p" as const, c: [text] }];
    const files = [
      { path: "SKILL.md", size: 1200 },
      { path: "references/notes.md", size: 80 },
    ];
    client.setQueryData(skillPreviewQuery(companion, "claude", "acme-skill").queryKey, {
      files,
      truncated: false,
      open: { path: "SKILL.md", nodes: md("Acme skill body"), note: null },
    });
    client.setQueryData(
      skillPreviewQuery(companion, "claude", "acme-skill", "references/notes.md").queryKey,
      {
        files,
        truncated: false,
        open: { path: "references/notes.md", nodes: md("Acme notes"), note: null },
      },
    );
    const { page, doc } = await mount(
      { claude: ["acme-skill"], opencode: [], agents: [] },
      client,
      companion,
    );
    await act(async () => {
      doc.querySelector<HTMLElement>('[data-skill="acme-skill"]')!.click();
    });
    await settle();
    expect(doc.body.textContent).toContain("Acme skill body");
    expect(doc.querySelector('[data-skill-file="SKILL.md"]')?.getAttribute("aria-current")).toBe(
      "true",
    );
    await act(async () => {
      doc.querySelector<HTMLElement>('[data-skill-file="references/notes.md"]')!.click();
    });
    await settle();
    expect(doc.body.textContent).toContain("Acme notes");
    page.unmount();
  });
});
