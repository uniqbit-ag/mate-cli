import { describe, expect, it } from "bun:test";

import { renderToStaticMarkup } from "react-dom/server";

import { PathSteps } from "./path-steps";

const STEPS = ["Propose change", "Human review", "Apply change", "Archive change"];
const html = (current: number, tone?: "why") =>
  renderToStaticMarkup(<PathSteps steps={STEPS} current={current} tone={tone} />);

describe("PathSteps", () => {
  it("lists every step in order and marks only the current one", () => {
    const markup = html(1, "why");
    expect(markup).toContain('aria-label="Delivery Path"');
    expect(markup.match(/aria-current="step"/g)).toHaveLength(1);
    expect(markup).toMatch(/aria-current="step"[^>]*before:bg-why[^>]*>Human review</);
    expect(markup).toMatch(/Propose change.*Human review.*Apply change.*Archive change/s);
  });

  describe("compact", () => {
    const compact = (current: number, tone?: "why" | "warn" | "bad") =>
      renderToStaticMarkup(<PathSteps steps={STEPS} current={current} tone={tone} compact />);

    it("reads one line over a tick per step and names every step for assistive tech", () => {
      const markup = compact(1, "why");
      expect(markup).toContain("Step 2 of 4 · Human review");
      expect(markup.match(/<li/g)).toHaveLength(STEPS.length);
      expect(markup).toMatch(/Propose change.*Human review.*Apply change.*Archive change/s);
      expect(markup).toContain("sr-only");
    });

    it("marks done, current and upcoming ticks, the current one in its tone", () => {
      const markup = compact(1, "warn");
      expect(markup.match(/aria-current="step"/g)).toHaveLength(1);
      expect(markup).toMatch(/aria-current="step"[^>]*bg-warn/);
      expect(markup).toMatch(/<li[^>]*color-mix[^>]*>.*aria-current/s);
      expect(markup.match(/<li class="h-1 rounded-full bg-rule"/g)).toHaveLength(2);
    });

    it("says Saved for later before the first step and Delivered past the last", () => {
      expect(compact(-1)).toContain("Saved for later");
      expect(compact(-1)).not.toContain("aria-current");
      expect(compact(STEPS.length)).toContain("Delivered");
      expect(compact(STEPS.length)).not.toContain("aria-current");
    });
  });

  it("marks no step when none is current or all are done", () => {
    expect(html(-1)).not.toContain("aria-current");
    expect(html(STEPS.length)).not.toContain("aria-current");
  });
});
