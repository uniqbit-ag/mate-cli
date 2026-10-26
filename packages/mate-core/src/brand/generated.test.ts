import { describe, expect, test } from "bun:test";

import {
  checkBrand,
  paletteProblems,
  parseAnsiRow,
  strayHexes,
} from "../../../../scripts/brand/generate";

/** BRAND.md's colour table, with each row's HEX cell replaceable. */
function brandTable(rows: [name: string, hex: string][]): string {
  const body = rows.map(([name, hex]) => `| ${name} | \`${hex}\` | 0 0 0 | role |`).join("\n");
  return `# Brand\n\n## Colour\n| Name | HEX | RGB | Role |\n|---|---|---|---|\n${body}\n\nContrast:\n\n## Next\n`;
}

const PALETTE = { mateGreen: { hex: "#2E7D5B" }, night: { hex: "#15191A" } };

describe("brand outputs generated from assets/logo-kit", () => {
  // Reads every scanned source in the repository, which is slow on a cold file cache.
  test("the brand check passes: outputs are current, the palette matches, no stray hex", async () => {
    expect(await checkBrand()).toEqual([]);
  }, 30_000);

  test("fail loudly on an SGR colour the kit is not known to use", () => {
    expect(() => parseAnsiRow("\x1b[38;2;1;2;3m█\x1b[0m", "symbol")).toThrow(/Unknown SGR/);
  });

  test("split a lockup row into pane, note, and word cells", () => {
    const row = "\x1b[38;2;31;36;33m███ \x1b[38;2;46;125;91m██      \x1b[38;2;31;36;33m▄▄\x1b[0m";
    // Padding puts the trailing ink cells past the 14-column symbol, where the wordmark begins.
    expect(parseAnsiRow(row.replace("██      ", "██         "), "lockup")).toEqual([
      { kind: "pane", text: "███" },
      { kind: "space", text: " " },
      { kind: "note", text: "██" },
      { kind: "space", text: "         " },
      { kind: "word", text: "▄▄" },
    ]);
  });
});

describe("the palette matches the logo kit's colour table", () => {
  test("a table that agrees, compared case-insensitively, has no problems", () => {
    const table = brandTable([
      ["Mate green", "#2e7d5b"],
      ["Night", "#15191A"],
    ]);
    expect(paletteProblems(table, PALETTE)).toEqual([]);
  });

  test("The palette disagrees with the logo kit: missing, extra, and differing colours are named", () => {
    const table = brandTable([
      ["Mate green", "#2E7D5C"],
      ["Light green", "#7FD0A6"],
    ]);
    expect(paletteProblems(table, PALETTE)).toEqual([
      "BRAND.md colour mateGreen is #2E7D5C, but the palette has #2E7D5B",
      "BRAND.md colour lightGreen is missing from the palette",
      "palette colour night is not in BRAND.md's colour table",
    ]);
  });

  test("a BRAND.md without a colour table fails loudly", () => {
    expect(() => paletteProblems("# Brand\n\n## Logo\n", PALETTE)).toThrow(/Colour/);
  });

  test("the current palette matches assets/logo-kit/BRAND.md", async () => {
    const markdown = await Bun.file(
      new URL("../../../../assets/logo-kit/BRAND.md", import.meta.url),
    ).text();
    expect(paletteProblems(markdown)).toEqual([]);
  });
});

describe("the brand module is the single runtime source of the Mate identity", () => {
  test("A surface needs the brand green: a hex value outside the brand sources is named", () => {
    const source = `.accent { color: #2E7D5B; }\n.night { background: #15191a; }\n.other { color: #123456; }`;
    expect(strayHexes("apps/docs/src/styles/x.css", source, PALETTE)).toEqual([
      "apps/docs/src/styles/x.css declares brand colour mateGreen (#2E7D5B)",
      "apps/docs/src/styles/x.css declares brand colour night (#15191A)",
    ]);
  });
});
