import { describe, expect, it } from "bun:test";

import { staticMarkup } from "../../test/render";
import type { ShellCompanion, ShellData } from "../server/shell";
import { CompanionPicker } from "./companion-picker";
import { Sidebar } from "./sidebar";

const acme: ShellCompanion = {
  digest: "0123456789",
  path: "/home/dev/.mate/companions/acme-companion",
  note: "",
  unready: false,
  pairings: ["acme/web", "acme/api", "acme/docs", "acme/infra"],
};
const broken: ShellCompanion = {
  digest: "abcdef0123",
  path: "/home/dev/.mate/companions/acme-old",
  note: "missing — the directory is gone",
  unready: true,
  pairings: [],
};

const shell = (overrides: Partial<ShellData> = {}): ShellData => ({
  companions: [acme, broken],
  selected: null,
  studioMode: "engineering",
  enabledModes: ["engineering", "analysis"],
  profile: "standard",
  collectedAt: null,
  metrics: null,
  writable: false,
  factoryMode: false,
  terminal: null,
  ...overrides,
});

describe("the companion picker", () => {
  it("offers one card per companion, naming it and its linked repositories", () => {
    const markup = staticMarkup(<CompanionPicker companions={[acme, broken]} />);
    expect(markup).toContain("Choose a Companion Repository");
    expect(markup).toContain('<span class="picker-card-name">acme-companion</span>');
    expect(markup).toContain("acme/web");
    expect(markup).toContain("+1 more");
    expect(markup).not.toContain("acme/infra");
    expect(markup).toContain("no linked working repository");
    expect(markup).toContain('data-unready="true"');
    expect(markup).toContain("missing — the directory is gone");
  });

  it("says how to register one when none is", () => {
    const markup = staticMarkup(<CompanionPicker companions={[]} />);
    expect(markup).toContain("No Companion Repository is registered on this machine.");
    expect(markup).toContain("mate companion setup");
  });
});

describe("the sidebar's companion selector", () => {
  it("asks for a choice while none is selected, and marks unready companions", () => {
    const markup = staticMarkup(<Sidebar shell={shell()} search={{}} view="dashboard" />);
    expect(markup).toContain("select a companion…");
    expect(markup).toMatch(/<option[^>]*value="abcdef0123"[^>]*data-unready="true"/);
    expect(markup).toContain(`${broken.path} (${broken.note})`);
  });

  it("shows the selected companion without the placeholder", () => {
    const markup = staticMarkup(
      <Sidebar
        shell={shell({ selected: acme })}
        search={{ companion: acme.digest }}
        view="dashboard"
      />,
    );
    expect(markup).not.toContain("select a companion…");
    expect(markup).toMatch(/<option value="0123456789" selected="">/);
  });

  it("offers the Factory view only where the factory broker runs", () => {
    const factoryLink =
      /class="sidebar-nav-link"[^>]*href="\/factory|href="\/factory[^"]*"[^>]*class="sidebar-nav-link"/;
    const without = staticMarkup(<Sidebar shell={shell()} search={{}} view="dashboard" />);
    expect(without).not.toMatch(factoryLink);
    expect(without).toContain("Workflow");
    const withBroker = staticMarkup(
      <Sidebar shell={shell({ factoryMode: true })} search={{}} view="dashboard" />,
    );
    expect(withBroker).toMatch(factoryLink);
  });

  it("says when no companion is registered", () => {
    const markup = staticMarkup(
      <Sidebar shell={shell({ companions: [] })} search={{}} view="dashboard" />,
    );
    expect(markup).toContain("no companion registered");
  });

  it("keeps companion and mode in every view link, and marks the current view", () => {
    const markup = staticMarkup(
      <Sidebar
        shell={shell({ selected: acme, studioMode: "analysis" })}
        search={{ companion: acme.digest, studioMode: "analysis" }}
        view="specs"
      />,
    );
    const links = [
      ...markup.matchAll(
        /class="sidebar-nav-link"[^>]*href="([^"]*)"|href="([^"]*)"[^>]*class="sidebar-nav-link"/g,
      ),
    ].map((match) => new URL((match[1] ?? match[2])!.replaceAll("&amp;", "&"), "http://localhost"));
    expect(links.length).toBeGreaterThan(2);
    for (const link of links) {
      expect(link.searchParams.get("companion")).toBe(acme.digest);
      expect(link.searchParams.get("studioMode")).toBe("analysis");
      expect(link.searchParams.has("role")).toBe(false);
    }
    expect(markup).toMatch(/aria-current="page"[^>]*>.*?Specs|Specs/);
  });
});

/** The Mode control's segments: tag, attributes, and label, in order. */
function segments(markup: string) {
  const group = /<div class="mode-switch"[^>]*>([\s\S]*?)<\/div>/.exec(markup)?.[1] ?? "";
  return [...group.matchAll(/<(a|button)([^>]*)>([^<]*)<\/\1>/g)].map(([, tag, attrs, label]) => ({
    tag,
    attrs: attrs!,
    label,
  }));
}

describe("the Mode switch", () => {
  const appliance = shell({
    selected: acme,
    studioMode: "analysis",
    enabledModes: ["analysis"],
    profile: "appliance",
  });

  it("names the group Mode and offers Engineering and Analysis, marking the effective one", () => {
    const markup = staticMarkup(
      <Sidebar
        shell={shell({ selected: acme, studioMode: "analysis" })}
        search={{ companion: acme.digest, studioMode: "analysis" }}
        view="dashboard"
      />,
    );
    expect(markup).toContain('role="group" aria-label="Mode"');
    expect(markup).not.toMatch(/Product Engineer|Business Analyst/);
    const [engineering, analysis] = segments(markup);
    expect([engineering?.label, analysis?.label]).toEqual(["Engineering", "Analysis"]);
    expect(engineering?.attrs).toContain('aria-pressed="false"');
    expect(analysis?.attrs).toContain('aria-pressed="true"');
    expect(markup).not.toContain("mode-switch-note");
  });

  it("enables both modes locally and in the factory, each linking with its own mode", () => {
    for (const factoryMode of [false, true]) {
      const markup = staticMarkup(
        <Sidebar
          shell={shell({ selected: acme, factoryMode })}
          search={{ companion: acme.digest, studioMode: "engineering" }}
          view="workflow"
        />,
      );
      const found = segments(markup);
      expect(found.map((segment) => segment.tag)).toEqual(["a", "a"]);
      const hrefs = found.map(
        (segment) =>
          new URL(/href="([^"]*)"/.exec(segment.attrs)![1]!.replaceAll("&amp;", "&"), "http://x"),
      );
      expect(hrefs.map((href) => href.searchParams.get("studioMode"))).toEqual([
        "engineering",
        "analysis",
      ]);
      // Analysis is not offered Workflow, so it lands on its Overview.
      expect(hrefs.map((href) => href.pathname)).toEqual(["/workflow", "/"]);
    }
  });

  it("keeps a shared view and its target when switching", () => {
    const markup = staticMarkup(
      <Sidebar
        shell={shell({ selected: acme })}
        search={{ companion: acme.digest, studioMode: "engineering" }}
        view="vault"
      />,
    );
    const analysis = segments(markup)[1]!;
    expect(analysis.attrs).toContain('href="/vault?');
  });

  it("shows appliance Engineering disabled, without a target, and says why", () => {
    const markup = staticMarkup(
      <Sidebar
        shell={appliance}
        search={{ companion: acme.digest, studioMode: "analysis" }}
        view="dashboard"
      />,
    );
    const [engineering, analysis] = segments(markup);
    expect(engineering?.tag).toBe("button");
    expect(engineering?.label).toBe("Engineering");
    expect(engineering?.attrs).toContain('disabled=""');
    expect(engineering?.attrs).not.toContain("href");
    expect(engineering?.attrs).toContain('aria-describedby="studio-mode-note"');
    expect(analysis?.attrs).toContain('aria-pressed="true"');
    expect(markup).toContain('aria-describedby="studio-mode-note"');
    expect(markup).toMatch(
      /<p class="mode-switch-note" id="studio-mode-note">Engineering is unavailable in the appliance\.<\/p>/,
    );
  });

  it("gives Analysis its own heading, only the shared views, and no metrics", () => {
    const markup = staticMarkup(
      <Sidebar
        shell={{
          ...appliance,
          factoryMode: true,
          metrics: { changes: 3, done: 1, specs: 2 },
        }}
        search={{ companion: acme.digest, studioMode: "analysis" }}
        view="dashboard"
      />,
    );
    expect(markup).toContain('data-studio-nav-section="Analysis"');
    expect(markup).not.toMatch(/href="\/(factory|workflow|skills)/);
    expect(markup).not.toContain('id="studio-stats"');
  });

  it("gives Engineering its heading, views, and metrics", () => {
    const markup = staticMarkup(
      <Sidebar
        shell={shell({ selected: acme, metrics: { changes: 3, done: 1, specs: 2 } })}
        search={{ companion: acme.digest, studioMode: "engineering" }}
        view="dashboard"
      />,
    );
    expect(markup).toContain('data-studio-nav-section="Engineering"');
    expect(markup).toMatch(/href="\/workflow/);
    expect(markup).toMatch(/href="\/skills/);
    expect(markup).toContain('id="studio-stats"');
  });
});

describe("times in the server-rendered shell", () => {
  it("leaves the clock time to the browser, whose time zone may differ from the server's", () => {
    const at = Date.UTC(2026, 10, 3, 9, 30, 15);
    const markup = staticMarkup(
      <Sidebar
        shell={shell({ selected: acme, collectedAt: at })}
        search={{ companion: acme.digest }}
        view="dashboard"
      />,
    );
    expect(markup).toContain(`<time dateTime="${new Date(at).toISOString()}"></time>`);
  });
});
