import { afterEach, describe, expect, it } from "bun:test";

await import("../../test/dom");
const { act, fireEvent, render, screen } = await import("@testing-library/react");
const { ConnectionBanner } = await import("./connection-banner");
const { useConnectionState } = await import("../stores/connection");

afterEach(() => useConnectionState.setState({ state: "online" }));

/** The banner above a view that keeps showing its data. */
function page(reloads: string[]) {
  return render(
    <main>
      <ConnectionBanner reload={() => reloads.push("reload")} />
      <p data-view>acme dashboard</p>
    </main>,
  );
}

describe("connection banner", () => {
  it.each([
    ["offline", "Connection to Studio lost"],
    ["signed-out", "Connection to Studio lost — reload to sign in again"],
    ["expired", "Session expired — open the address Studio printed when it started"],
  ] as const)("shows %s with Reload above the view", (state, text) => {
    const reloads: string[] = [];
    const view = page(reloads);
    act(() => useConnectionState.setState({ state }));
    expect(screen.getByRole("status").textContent).toBe(`${text}Reload`);
    expect(view.container.querySelector("[data-view]")?.textContent).toBe("acme dashboard");
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(reloads).toEqual(["reload"]);
  });

  it("offers no Reload when the host is refused", () => {
    page([]);
    act(() => useConnectionState.setState({ state: "host-refused" }));
    const banner = screen.getByRole("status");
    expect(banner.textContent).toBe("Studio does not answer to this host");
    expect(banner.getAttribute("aria-live")).toBe("polite");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("is empty while online and never reloads by itself", () => {
    const reloads: string[] = [];
    page(reloads);
    expect(screen.getByRole("status").textContent).toBe("");
    act(() => useConnectionState.setState({ state: "signed-out" }));
    expect(reloads).toEqual([]);
  });
});
