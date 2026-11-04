import { describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

const PACKAGE_ROOT = path.resolve(import.meta.dir, "..");
const RUNTIME_PRAGMA = "/** @jsxRuntime automatic */";

function expectedSource(file: string): string {
  const relative = path.relative(PACKAGE_ROOT, file).split(path.sep).join("/");
  if (relative.startsWith("src/opencode/") || relative.startsWith("opencode-plugin/")) {
    return "@opentui/solid";
  }
  return "react";
}

async function tsxFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await tsxFiles(full)));
    else if (entry.name.endsWith(".tsx")) files.push(full);
  }
  return files;
}

/** The comments before the first statement; any other token ends the header. */
export function leadingComments(source: string): string[] {
  const comments: string[] = [];
  let rest = source;
  for (;;) {
    rest = rest.trimStart();
    const match = rest.match(/^(?:\/\*[\s\S]*?\*\/|\/\/[^\n]*)/);
    if (!match) return comments;
    comments.push(match[0]);
    rest = rest.slice(match[0].length);
  }
}

/** Any other comment naming a pragma, including one that merges the two, fails. */
export function declaresRuntime(source: string, importSource: string): boolean {
  const pragmaComments = leadingComments(source).filter((comment) =>
    /@jsx(?:Runtime|ImportSource)\b/.test(comment),
  );
  return (
    pragmaComments.length === 2 &&
    pragmaComments.includes(RUNTIME_PRAGMA) &&
    pragmaComments.includes(`/** @jsxImportSource ${importSource} */`)
  );
}

describe("every mate-core TSX module declares its JSX runtime", () => {
  it("opens each .tsx file with the two one-line pragmas for its area", async () => {
    const files = [
      ...(await tsxFiles(path.join(PACKAGE_ROOT, "src"))),
      ...(await tsxFiles(path.join(PACKAGE_ROOT, "opencode-plugin"))),
    ];
    expect(files.length).toBeGreaterThanOrEqual(21);
    for (const file of files) {
      const source = await fs.readFile(file, "utf8");
      const importSource = expectedSource(file);
      expect({ file, declared: declaresRuntime(source, importSource) }).toEqual({
        file,
        declared: true,
      });
    }
  });

  const header = (...lines: string[]) => `${lines.join("\n")}\nexport const x = 1;\n`;
  const reactPragma = "/** @jsxImportSource react */";

  it("accepts the two separate one-line pragmas", () => {
    expect(declaresRuntime(header(RUNTIME_PRAGMA, reactPragma), "react")).toBe(true);
  });

  it("rejects a missing runtime pragma, a missing source pragma, and the wrong source", () => {
    expect(declaresRuntime(header(reactPragma), "react")).toBe(false);
    expect(declaresRuntime(header(RUNTIME_PRAGMA), "react")).toBe(false);
    expect(declaresRuntime(header(RUNTIME_PRAGMA, reactPragma), "@opentui/solid")).toBe(false);
  });

  it("rejects pragma text that follows the first statement", () => {
    const late = `export const x = "${RUNTIME_PRAGMA} ${reactPragma}";\n${RUNTIME_PRAGMA}\n${reactPragma}\n`;
    expect(declaresRuntime(late, "react")).toBe(false);
  });

  it("rejects two pragmas sharing one comment", () => {
    const oneLine = header("/** @jsxRuntime automatic @jsxImportSource react */");
    const block = header("/**\n * @jsxRuntime automatic\n * @jsxImportSource react\n */");
    expect(declaresRuntime(oneLine, "react")).toBe(false);
    expect(declaresRuntime(block, "react")).toBe(false);
  });
});
