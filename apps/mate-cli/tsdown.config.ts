import { defineConfig } from "tsdown";

export default defineConfig({
  name: "mate-cli",
  entry: "src/cli.ts",
  outDir: "dist",
  format: "esm",
  platform: "node",
  deps: { neverBundle: true },
  dts: false,
  sourcemap: false,
});
