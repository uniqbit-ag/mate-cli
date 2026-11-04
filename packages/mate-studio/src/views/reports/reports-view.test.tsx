import { describe, expect, it } from "bun:test";

import { staticMarkup } from "../../../test/render";

import { Reports } from "./reports-view";

describe("Reports", () => {
  it("sits on the page, with the list and an empty note before any report", () => {
    const markup = staticMarkup(<Reports companion="0123456789" />);
    expect(markup).toContain('aria-label="Hosted reports"');
    expect(markup).toContain("Reports published by agent sessions Studio started.");
    expect(markup).not.toContain('class="panel');
    // The frame appears once a report is shown; before any exists the list and note stand alone.
    expect(markup).toContain('id="reports-list"');
    expect(markup).not.toContain('id="reports-frame"');
    expect(markup).toContain("No hosted reports yet.");
  });
});
