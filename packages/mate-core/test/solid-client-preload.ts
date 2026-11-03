import { plugin } from "bun";
import { readFile } from "node:fs/promises";

/** Mirrors OpenCode's runtime: `solid-js` resolves to its server build, which is swapped for the client build. No Solid transform is applied. */
plugin({
  name: "solid-client-builds",
  setup(build) {
    build.onLoad(
      { filter: /[/\\]node_modules[/\\]solid-js[/\\]dist[/\\]server\.js$/ },
      async (args) => ({
        contents: await readFile(args.path.replace("server.js", "solid.js"), "utf8"),
        loader: "js",
      }),
    );
    build.onLoad(
      { filter: /[/\\]node_modules[/\\]solid-js[/\\]store[/\\]dist[/\\]server\.js$/ },
      async (args) => ({
        contents: await readFile(args.path.replace("server.js", "store.js"), "utf8"),
        loader: "js",
      }),
    );
  },
});
