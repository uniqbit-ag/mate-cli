import { describe, expect, it } from "bun:test";
import { useState } from "react";

await import("../../test/dom");
const { act, render } = await import("@testing-library/react");
const { SidePanel } = await import("./panel");

const ITEMS = ["acme-a", "acme-b", "acme-c"];

/** A list whose rows open the panel, as a view uses it. */
function List() {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      {ITEMS.map((id) => (
        <button key={id} type="button" data-row={id} onClick={() => setOpen(id)}>
          {id}
        </button>
      ))}
      <SidePanel items={ITEMS} current={open} onSelect={setOpen} title={open ?? "none"}>
        <p data-shown>{open}</p>
      </SidePanel>
    </>
  );
}

const settle = () => act(async () => new Promise((done) => setTimeout(done, 30)));

async function mount() {
  const page = render(<List />);
  const doc = page.container.ownerDocument;
  const row = doc.querySelector<HTMLButtonElement>('[data-row="acme-b"]')!;
  row.focus();
  await act(async () => row.click());
  await settle();
  return { page, doc, row, shown: () => doc.querySelector("[data-shown]")?.textContent ?? null };
}

const key = (doc: Document, name: string) =>
  act(async () => {
    (doc.activeElement ?? doc.body).dispatchEvent(
      new KeyboardEvent("keydown", { key: name, bubbles: true }),
    );
  });

describe("the slide-over panel", () => {
  it("opens over the page with its position, Close taking the first focus", async () => {
    const { page, doc, shown } = await mount();
    expect(shown()).toBe("acme-b");
    const panel = doc.querySelector('[data-slot="sheet-content"]')!;
    expect(panel.textContent).toContain("2 of 3");
    expect(doc.activeElement?.getAttribute("aria-label")).toBe("Close");
    page.unmount();
  });

  it("walks with Previous, Next and the arrow keys", async () => {
    const { page, doc, shown } = await mount();
    await key(doc, "ArrowRight");
    expect(shown()).toBe("acme-c");
    const next = doc.querySelector<HTMLButtonElement>('button[aria-label="Next"]')!;
    expect(next.disabled).toBe(true);
    await act(async () =>
      doc.querySelector<HTMLButtonElement>('button[aria-label="Previous"]')!.click(),
    );
    expect(shown()).toBe("acme-b");
    await key(doc, "ArrowLeft");
    expect(shown()).toBe("acme-a");
    page.unmount();
  });

  it("closes on Escape and returns focus to the item it was opened from", async () => {
    const { page, doc, row, shown } = await mount();
    await key(doc, "Escape");
    await settle();
    expect(shown()).toBeNull();
    expect(doc.activeElement).toBe(row);
    page.unmount();
  });

  it("closes from its Close control", async () => {
    const { page, doc, shown } = await mount();
    await act(async () =>
      doc.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click(),
    );
    await settle();
    expect(shown()).toBeNull();
    page.unmount();
  });
});
