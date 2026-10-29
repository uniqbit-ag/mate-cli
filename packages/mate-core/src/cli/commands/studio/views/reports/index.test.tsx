/** @jsxImportSource hono/jsx */

import { describe, expect, it } from "bun:test";

import { Reports } from "./index";

describe("Reports", () => {
  it("sits on the page, with the list beside the report frame and an empty note", () => {
    const markup = String(<Reports />);
    expect(markup).toContain('aria-label="Hosted reports"');
    expect(markup).toContain("Reports published by agent sessions Studio started.");
    expect(markup).not.toContain('class="panel');
    expect(markup.indexOf('id="reports-list"')).toBeLessThan(markup.indexOf('id="reports-frame"'));
    expect(markup).toContain("No hosted reports yet.");
  });
});
