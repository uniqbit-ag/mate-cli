import { describe, expect, test } from "bun:test";

import { lcovToCobertura, parseLcov } from "./lcov-to-cobertura";

describe("parseLcov", () => {
  test("parses records and normalizes absolute paths relative to the project root", () => {
    const lcov = ["TN:", "SF:/repo/src/example.ts", "DA:2,3", "DA:1,0", "end_of_record"].join("\n");

    expect(parseLcov(lcov, "/repo")).toEqual([
      {
        filePath: "src/example.ts",
        lines: [
          { hits: 0, lineNumber: 1 },
          { hits: 3, lineNumber: 2 },
        ],
      },
    ]);
  });

  test("keeps absolute paths when they are outside the project root", () => {
    const lcov = ["TN:", "SF:/outside/project/example.ts", "DA:1,1", "end_of_record"].join("\n");

    expect(parseLcov(lcov, "/repo")).toEqual([
      {
        filePath: "/outside/project/example.ts",
        lines: [{ hits: 1, lineNumber: 1 }],
      },
    ]);
  });
});

describe("lcovToCobertura", () => {
  test("converts lcov files into a Cobertura report GitLab can ingest", () => {
    const lcov = [
      "TN:",
      "SF:src/a.ts",
      "DA:1,1",
      "DA:2,0",
      "end_of_record",
      "TN:",
      "SF:src/nested/b.ts",
      "DA:3,4",
      "end_of_record",
    ].join("\n");

    const xml = lcovToCobertura(lcov, {
      projectRoot: "/repo",
      timestamp: 1_719_849_600_000,
    });

    expect(xml).toContain('<coverage lines-covered="2" lines-valid="3" line-rate="0.6667"');
    expect(xml).toContain("<source>.</source>");
    expect(xml).toContain('<package name="src" line-rate="0.5000"');
    expect(xml).toContain('<package name="src/nested" line-rate="1.0000"');
    expect(xml).toContain('<class name="a.ts" filename="src/a.ts" line-rate="0.5000"');
    expect(xml).toContain('<line number="2" hits="0" branch="false"/>');
    expect(xml).toContain('<class name="b.ts" filename="src/nested/b.ts" line-rate="1.0000"');
    expect(xml).toContain('timestamp="1719849600"');
  });
});
