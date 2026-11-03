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
  role: "product-engineer",
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

  it("keeps companion and role in every view link, and marks the current view", () => {
    const markup = staticMarkup(
      <Sidebar
        shell={shell({ selected: acme, role: "business-analyst" })}
        search={{ companion: acme.digest, role: "business-analyst" }}
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
      expect(link.searchParams.get("role")).toBe("business-analyst");
    }
    expect(markup).toMatch(/aria-current="page"[^>]*>.*?Specs|Specs/);
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
