/** @jsxRuntime automatic */
/** @jsxImportSource react */
import { describe, expect, test } from "bun:test";
import { renderToString } from "ink";

import { ConfirmPromptApp } from "./confirm-prompt";

describe("ConfirmPromptApp", () => {
  test("puts the question and both choices on one line without a box", () => {
    const output = renderToString(<ConfirmPromptApp question="Install acme?" yesSelected />, {
      columns: 80,
    });
    const rows = output.split("\n").filter((row) => row.trim() !== "");

    expect(rows[0]).toMatch(/^\? Install acme\?\s+▸ Yes\s+No$/);
    expect(rows[1]).toContain("enter confirm");
    expect(output).not.toMatch(/[╭╮╰╯│─]/);
  });

  test("moves the cursor to No when No is selected", () => {
    const output = renderToString(
      <ConfirmPromptApp question="Install acme?" yesSelected={false} />,
      { columns: 80 },
    );

    expect(output).toMatch(/ Yes\s+▸ No/);
  });
});
