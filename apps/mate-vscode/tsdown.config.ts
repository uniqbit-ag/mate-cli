import { defineConfig } from "tsdown";

export default defineConfig({
  name: "mate-vscode",
  entry: { extension: "src/extension.ts" },
  outDir: "dist",
  format: "cjs",
  platform: "node",
  deps: { neverBundle: ["vscode"] },
  dts: false,
  sourcemap: false,
});
