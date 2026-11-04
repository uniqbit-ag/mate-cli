import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  // Bundle every runtime dependency into the server output except Mate Core, which the
  // published package resolves by self-reference (design D2).
  ssr: { noExternal: true, external: ["@uniqbit/mate-core"] },
  plugins: [tanstackStart({ router: { generatedRouteTree: "./route-tree.gen.ts" } }), viteReact()],
});
