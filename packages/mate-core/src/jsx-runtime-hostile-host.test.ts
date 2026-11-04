import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SRC = import.meta.dir;
const INK = import.meta.resolve("ink");
const SELECT_MENU = path.join(SRC, "lib/components/select-menu.tsx");
const WIZARD_HEADER = path.join(SRC, "lib/components/wizard-header.tsx");

const HOSTILE_HOSTS: Record<string, Record<string, string>> = {
  "tsconfig with a preact jsxImportSource": {
    "tsconfig.json": JSON.stringify({
      compilerOptions: { jsx: "react-jsx", jsxImportSource: "preact" },
    }),
  },
  "tsconfig with classic jsx and h/Fragment factories": {
    "tsconfig.json": JSON.stringify({
      compilerOptions: { jsx: "react", jsxFactory: "h", jsxFragmentFactory: "Fragment" },
    }),
  },
  "bunfig with a preact jsxImportSource": {
    "bunfig.toml": 'jsxImportSource = "preact"\n',
  },
};

/** Calls the components directly, so only their own pragmas decide how their JSX compiles. */
const RENDER_SCRIPT = `
import { renderToString } from ${JSON.stringify(INK)};
import { SelectMenu } from ${JSON.stringify(SELECT_MENU)};
import { WizardHeader } from ${JSON.stringify(WIZARD_HEADER)};

const menu = renderToString(
  SelectMenu({ items: [{ key: "a", label: "Alpha" }, { key: "b", label: "Beta" }], activeIndex: 0 }),
  { columns: 40 },
);
const header = renderToString(WizardHeader({ title: "Pick a companion", step: 0, totalSteps: 3 }), {
  columns: 40,
});
console.log(JSON.stringify({ menu, header }));
`;

let root: string;
let script: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "mate-jsx-host-"));
  await fs.mkdir(path.join(root, "script"));
  script = path.join(root, "script", "render.ts");
  await fs.writeFile(script, RENDER_SCRIPT);
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("Mate renders regardless of the host project's JSX settings", () => {
  for (const [name, files] of Object.entries(HOSTILE_HOSTS)) {
    it(`renders two Ink components from a directory with a ${name}`, async () => {
      const host = path.join(root, name.replace(/\W+/g, "-"));
      await fs.mkdir(host);
      for (const [file, content] of Object.entries(files)) {
        await fs.writeFile(path.join(host, file), content);
      }

      const child = Bun.spawn([process.execPath, script], {
        cwd: host,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);

      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
      const rendered = JSON.parse(stdout) as { menu: string; header: string };
      expect(rendered.menu).toContain("Alpha");
      expect(rendered.menu).toContain("Beta");
      expect(rendered.header).toContain("Pick a companion");
      expect(rendered.header).toContain("1 / 3");
    });
  }
});
