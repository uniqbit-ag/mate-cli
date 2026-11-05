import { describe, expect, it } from "bun:test";

import { factoryKeyHandler, matchesFilter, stepRow, titled } from "./factory-live";

const blank = { closest: () => null, matches: () => false };

/** A document whose open Outcome panel answers `selectors` with a button recording its click. */
function withDialog(selectors: Record<string, string>, clicked: string[]): Document {
  const dialog = {
    closest: () => null,
    querySelector: (selector: string) =>
      selector in selectors ? { click: () => clicked.push(selectors[selector]!) } : null,
  };
  return {
    querySelector: (selector: string) => (selector === "[data-outcome-panel]" ? dialog : null),
  } as unknown as Document;
}

const press = (doc: Document, key: string, target: unknown, init: object = {}) =>
  factoryKeyHandler(doc)({ key, target, preventDefault: () => {}, ...init } as KeyboardEvent);

describe("the live Factory view", () => {
  it("leaves board keys alone while focus is in another modal, such as Agents", () => {
    const focused: string[] = [];
    const field = { focus: () => focused.push("filter") };
    const doc = {
      querySelector: (selector: string) => (selector === "[data-outcome-filter]" ? field : null),
    } as unknown as Document;
    press(doc, "/", blank);
    expect(focused).toEqual(["filter"]);
    focused.length = 0;
    const sheet = { querySelector: () => null };
    const inAgents = { closest: (selector: string) => (selector.includes("sheet") ? sheet : null) };
    press(doc, "/", inAgents);
    expect(focused).toEqual([]);
  });

  it("counts decisions in the title and never stacks counts", () => {
    expect(titled("Mate Studio", 2)).toBe("(2) Mate Studio");
    expect(titled("(2) Mate Studio", 1)).toBe("(1) Mate Studio");
    expect(titled("(2) Mate Studio", 0)).toBe("Mate Studio");
  });

  it("starts the outcome on Ctrl or Cmd+Enter, and keeps Enter alone a new line", () => {
    const submitted: unknown[] = [];
    const start = { value: "start" };
    const form = {
      querySelector: (selector: string) => (selector.includes(":disabled") ? null : start),
      requestSubmit: (submitter: unknown) => submitted.push(submitter),
    };
    const textarea = { localName: "textarea", closest: () => form, matches: () => false };
    const doc = { querySelector: () => null } as unknown as Document;
    press(doc, "Enter", textarea);
    expect(submitted).toEqual([]);
    press(doc, "Enter", textarea, { metaKey: true });
    press(doc, "Enter", textarea, { ctrlKey: true });
    expect(submitted).toEqual([start, start]);
  });

  it("does not send a question round that is not fully answered", () => {
    const submitted: unknown[] = [];
    const form = { querySelector: () => ({}), requestSubmit: () => submitted.push(true) };
    const textarea = { localName: "textarea", closest: () => form, matches: () => false };
    press({ querySelector: () => null } as unknown as Document, "Enter", textarea, {
      metaKey: true,
    });
    expect(submitted).toEqual([]);
  });

  it("moves between rows and holds at the ends", () => {
    const rows = [{}, {}, {}] as Element[];
    expect(stepRow(rows, null, 1)).toBe(rows[0]);
    expect(stepRow(rows, rows[0]!, 1)).toBe(rows[1]);
    expect(stepRow(rows, rows[2]!, 1)).toBe(rows[2]);
    expect(stepRow(rows, rows[0]!, -1)).toBe(rows[0]);
    expect(stepRow([], null, 1)).toBeUndefined();
  });

  it("picks a numbered answer in the open panel, but not while typing", () => {
    const clicked: string[] = [];
    const doc = withDialog({ '[data-option-key="2"]': "2" }, clicked);
    press(doc, "2", blank);
    press(doc, "2", { closest: () => ({}), matches: () => false });
    press(doc, "3", blank);
    expect(clicked).toEqual(["2"]);
  });

  it("filters by every word, ignoring case and order", () => {
    expect(matchesFilter("Make onboarding easier Decisions needed", "onboarding")).toBe(true);
    expect(matchesFilter("Make onboarding easier Decisions needed", "DECISIONS make")).toBe(true);
    expect(matchesFilter("Make onboarding easier", "onboarding billing")).toBe(false);
  });

  it("steps to the next and previous Outcome with J and K in an open panel", () => {
    const clicked: string[] = [];
    const doc = withDialog(
      { 'button[aria-label="Next"]': "next", 'button[aria-label="Previous"]': "previous" },
      clicked,
    );
    press(doc, "j", blank);
    press(doc, "k", blank);
    expect(clicked).toEqual(["next", "previous"]);
  });
});
