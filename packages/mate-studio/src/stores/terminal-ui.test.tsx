import { afterEach, describe, expect, it } from "bun:test";

await import("../../test/dom");

const { staticMarkup } = await import("../../test/render");
const { TerminalSidebar } = await import("../terminal/terminal-sidebar");
const { TERMINAL_COLLAPSED_KEY } = await import("../terminal/keys");
const { heldBy, useTerminalUi } = await import("./terminal-ui");

const terminal = { pinned: false, target: null, agents: [] };

afterEach(() => {
  document.documentElement.removeAttribute("data-terminal-collapsed");
  localStorage.removeItem(TERMINAL_COLLAPSED_KEY);
  useTerminalUi.setState({ collapsed: false, workspace: null, released: [] });
});

describe("a workspace view holding the agent terminal", () => {
  it("holds it until the person expands it for that view", () => {
    expect(heldBy("factory/factory", [])).toBe("factory/factory");
    expect(heldBy("factory/factory", ["factory/factory"])).toBeNull();
    expect(heldBy(null, [])).toBeNull();
  });

  it("shows the terminal collapsed while held", () => {
    const held = staticMarkup(<TerminalSidebar terminal={terminal} heldBy="factory/factory" />);
    expect(held).toMatch(/id="terminal-expand"[^>]*aria-expanded="false"/);
    const free = staticMarkup(<TerminalSidebar terminal={terminal} />);
    expect(free).toMatch(/id="terminal-expand"[^>]*aria-expanded="true"/);
  });

  it("expanding releases the view without forgetting the preference", () => {
    useTerminalUi.getState().release("factory/factory");
    expect(useTerminalUi.getState().released).toEqual(["factory/factory"]);
    expect(localStorage.getItem(TERMINAL_COLLAPSED_KEY)).toBeNull();
  });

  it("undoes a remembered collapse when the person expands it", () => {
    useTerminalUi.getState().setCollapsed(true);
    useTerminalUi.getState().release("factory/factory");
    expect(useTerminalUi.getState().collapsed).toBe(false);
    expect(localStorage.getItem(TERMINAL_COLLAPSED_KEY)).toBe("false");
  });

  it("releases the hold when another view reveals the terminal", () => {
    useTerminalUi.getState().setWorkspace("factory/factory");
    useTerminalUi.getState().reveal();
    expect(useTerminalUi.getState().released).toEqual(["factory/factory"]);
  });
});
