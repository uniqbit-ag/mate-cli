import { describe, expect, test } from "bun:test";

import { BRAND_COLORS } from "./palette";
import { chooseLogo, renderLogo } from "./terminal";

const ESCAPE = /\x1b\[[0-9;]*m/g;
const GREEN_SGR = "\x1b[38;2;46;125;91m";

describe("renderLogo", () => {
  test("colours only the note bars, in Mate green, on a colour TTY", () => {
    const output = renderLogo({ form: "symbol", columns: 80, isTTY: true, env: {} });
    const rows = output.split("\n");

    expect(rows).toHaveLength(7);
    expect(rows.every((row) => row.replace(ESCAPE, "").length === 14)).toBe(true);
    const escapes = [...new Set(output.match(ESCAPE))];
    expect(escapes.sort()).toEqual([GREEN_SGR, "\x1b[39m"].sort());
    for (const row of rows) {
      // The left pane comes first and stays in the default foreground.
      expect(row.startsWith(GREEN_SGR)).toBe(false);
      const coloured = row.slice(
        row.indexOf(GREEN_SGR) + GREEN_SGR.length,
        row.indexOf("\x1b[39m"),
      );
      expect(coloured).toMatch(/^[█▄▀]{5}$/);
    }
    expect(BRAND_COLORS.mateGreen.hex).toBe("#2E7D5B");
  });

  test("prints block art with no escape sequences when NO_COLOR is set", () => {
    const output = renderLogo({ form: "symbol", columns: 80, isTTY: true, env: { NO_COLOR: "1" } });

    expect(output).not.toMatch(ESCAPE);
    expect(output).toContain("█");
    expect(output.split("\n")).toHaveLength(7);
  });

  test("prints 7-bit ASCII with no escape sequences when the stream is not a TTY", () => {
    const output = renderLogo({ form: "symbol", columns: 80, isTTY: false, env: {} });

    expect(output).not.toMatch(ESCAPE);
    expect(/^[\x00-\x7f]*$/.test(output)).toBe(true);
    expect(output).toContain("####");
  });

  test("prints the lockup when 52 columns are available", () => {
    const output = renderLogo({ form: "lockup", columns: 52, isTTY: true, env: { NO_COLOR: "1" } });

    expect(output.split("\n")).toHaveLength(7);
    expect(Math.max(...output.split("\n").map((row) => row.length))).toBe(52);
  });

  test("falls back to the symbol, then to the word mate, as columns shrink", () => {
    const symbol = renderLogo({ form: "symbol", columns: 80, isTTY: true, env: {} });

    expect(renderLogo({ form: "lockup", columns: 40, isTTY: true, env: {} })).toBe(symbol);
    expect(renderLogo({ form: "lockup", columns: 10, isTTY: true, env: {} })).toBe("mate");
    expect(renderLogo({ form: "symbol", columns: 13, isTTY: false, env: {} })).toBe("mate");
  });

  test("treats an empty NO_COLOR as unset", () => {
    expect(renderLogo({ form: "symbol", columns: 80, isTTY: true, env: { NO_COLOR: "" } })).toMatch(
      ESCAPE,
    );
  });
});

describe("chooseLogo", () => {
  test("hands renderers the segment rows so they can apply their own colour props", () => {
    const choice = chooseLogo({ form: "symbol", columns: 80, isTTY: true, env: {} });

    expect(choice.kind).toBe("block");
    if (choice.kind !== "block") return;
    expect(choice.color).toBe(true);
    expect(choice.rows[0].map((segment) => segment.kind)).toEqual(["pane", "space", "note"]);
  });
});
