import { describe, expect, test } from "bun:test";
import { renderToString } from "ink";

import { WizardHeader } from "./wizard-header";

describe("WizardHeader", () => {
  test("names mate above the title and step counter, without logo art", () => {
    const output = renderToString(
      <WizardHeader title="Pick a companion" step={0} totalSteps={3} />,
      {
        columns: 80,
      },
    );
    const rows = output.split("\n");

    expect(output).not.toMatch(/[█▀▄]/);
    const mateRow = rows.findIndex((row) => row.includes("mate framework"));
    const titleRow = rows.findIndex((row) => row.includes("Pick a companion"));
    expect(mateRow).toBeGreaterThan(-1);
    expect(titleRow).toBeGreaterThan(mateRow);
    expect(rows[titleRow]).toContain("1 / 3");
  });

  test("hides the step counter for single-step wizards", () => {
    const output = renderToString(<WizardHeader title="Only step" step={0} totalSteps={1} />, {
      columns: 80,
    });

    expect(output).not.toContain("1 / 1");
  });
});
