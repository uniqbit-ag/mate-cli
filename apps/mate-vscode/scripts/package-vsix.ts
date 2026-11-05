/**
 * Builds `mate-vscode.vsix`, the only file the npm package ships.
 * vsce refuses a scoped name, so the extension manifest is staged with `name: "mate"`.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const appDir = path.join(import.meta.dir, "..");
const output = path.join(appDir, "mate-vscode.vsix");

execFileSync("bun", ["run", "build"], { cwd: appDir, stdio: "inherit" });

const manifest = JSON.parse(fs.readFileSync(path.join(appDir, "package.json"), "utf8"));
for (const key of ["scripts", "devDependencies", "publishConfig"]) delete manifest[key];
manifest.name = "mate";
manifest.files = ["dist/", "media/", "LICENSE", "README.md"];

const stage = fs.mkdtempSync(path.join(os.tmpdir(), "mate-vscode-"));
try {
  fs.writeFileSync(path.join(stage, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.cpSync(path.join(appDir, "dist"), path.join(stage, "dist"), { recursive: true });
  fs.cpSync(path.join(appDir, "media"), path.join(stage, "media"), { recursive: true });
  fs.copyFileSync(path.join(appDir, "README.md"), path.join(stage, "README.md"));
  fs.copyFileSync(path.join(appDir, "..", "..", "LICENSE"), path.join(stage, "LICENSE"));

  const vsce = path.join(
    path.dirname(createRequire(import.meta.url).resolve("@vscode/vsce/package.json")),
    "vsce",
  );
  execFileSync("node", [vsce, "package", "--no-dependencies", "-o", output], {
    cwd: stage,
    stdio: "inherit",
  });
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}
