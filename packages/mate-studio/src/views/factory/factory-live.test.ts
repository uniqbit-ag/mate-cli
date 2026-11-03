import { describe, expect, it } from "bun:test";

import { factoryKeyHandler, matchesFilter, stepRow, titled } from "./factory-live";

const blank = { closest: () => null, matches: () => false };

/** A document whose open dialog answers `selectors` with a button recording its click. */
function withDialog(selectors: Record<string, string>, clicked: string[]): Document {
  const dialog = {
    querySelector: (selector: string) =>
      selector in selectors ? { click: () => clicked.push(selectors[selector]!) } : null,
  };
  return {
    querySelector: (selector: string) =>
      selector === "dialog.outcome-dialog[open]" ? dialog : null,
  } as unknown as Document;
}

const press = (doc: Document, key: string, target: unknown, init: object = {}) =>
  factoryKeyHandler(doc)({ key, target, preventDefault: () => {}, ...init } as KeyboardEvent);

describe("the live Factory view", () => {
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

  it("picks a numbered answer in the open dialog, but not while typing", () => {
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

  it("steps to the next Outcome with J in an open dialog", () => {
    const clicked: string[] = [];
    const doc = withDialog({ '[data-outcome-goto][aria-keyshortcuts="J"]': "next" }, clicked);
    press(doc, "j", blank);
    expect(clicked).toEqual(["next"]);
  });
});
