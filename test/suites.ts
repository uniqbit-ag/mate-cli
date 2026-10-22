import fs from "node:fs";
import path from "node:path";

export type TestSuite = "unit" | "integration";

const skippedDirectories = new Set(["node_modules", "dist", "coverage", "_artifacts"]);
const testFile = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

/** File headers declare external access; unmarked tests belong to the unit suite. */
export function suiteArguments(suite: TestSuite, cwd = process.cwd()): string[] {
  const excluded: string[] = [];
  function visit(directory: string): void {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || skippedDirectories.has(entry.name)) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && testFile.test(entry.name)) {
        const requiresAccess = /^\/\*\* @test-requires .+ \*\/(?:\r?\n|$)/.test(
          fs.readFileSync(file, "utf8"),
        );
        if (requiresAccess !== (suite === "integration")) {
          excluded.push(path.relative(cwd, file).split(path.sep).join("/"));
        }
      }
    }
  }
  visit(cwd);
  return [
    "--pass-with-no-tests",
    ...excluded.toSorted().map((file) => `--path-ignore-patterns=**/${file}`),
  ];
}
