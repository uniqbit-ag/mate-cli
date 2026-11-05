import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  // The shadcn CLI writes `@/` imports into src/components/ui.
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  // Bundle every runtime dependency into the server output except Mate Core, which the
  // published package resolves by self-reference (design D2).
  ssr: { noExternal: true, external: ["@uniqbit/mate-core"] },
  environments: {
    ssr: {
      build: {
        rolldownOptions: {
          output: {
            // The Start manifest embeds absolute route paths, so its content hash differs per
            // checkout; an unhashed name keeps the packed tarball reproducible across machines.
            chunkFileNames: (chunk) =>
              chunk.name.startsWith("_tanstack-start-manifest")
                ? "assets/[name].js"
                : "assets/[name]-[hash].js",
          },
        },
      },
    },
  },
  plugins: [
    tailwindcss(),
    tanstackStart({ router: { generatedRouteTree: "./route-tree.gen.ts" } }),
    viteReact(),
  ],
});
