/** @jsxRuntime automatic */
/** @jsxImportSource react */
import { describe, expect, test } from "bun:test";
import { renderToString } from "ink";

import { WizardHeader } from "./wizard-header";

describe("WizardHeader", () => {
  test("puts mate, the title and the step counter on one borderless line", () => {
    const output = renderToString(
      <WizardHeader title="Pick a companion" step={0} totalSteps={3} />,
      {
        columns: 80,
      },
    );
    const rows = output.split("\n").filter((row) => row.trim() !== "");

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatch(/^mate · Pick a companion\s+1 \/ 3$/);
    expect(output).not.toMatch(/[╭╮╰╯│─█▀▄]/);
  });

  test("hides the step counter for single-step wizards", () => {
    const output = renderToString(<WizardHeader title="Only step" step={0} totalSteps={1} />, {
      columns: 80,
    });

    expect(output).not.toContain("1 / 1");
  });
});
