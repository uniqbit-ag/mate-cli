import path from "node:path";

import type { MateSlotClaim, MateTuiApi } from "../src/opencode/tui";

// `solid-js` is not a mate-core dependency; resolve it where @opentui/solid does.
const opentuiSolid = path.dirname(Bun.resolveSync("@opentui/solid", import.meta.dir));
const { createStore, produce } = await import(Bun.resolveSync("solid-js/store", opentuiSolid));
const { testRender } = await import("@opentui/solid");
const { default: plugin } = await import("../src/opencode/tui");

type Notes = { lines: string[] };

const claims: MateSlotClaim[] = [];
let setNotes: (mutation: (draft: Notes) => void) => void = () => {};
const api = {
  theme: { text: { muted: "#808080" } },
  ui: {
    slot(claim: MateSlotClaim) {
      claims.push(claim);
      return () => {};
    },
    toast: { show() {} },
  },
  storage: {
    memory(_key: string, options: { initial: Notes }) {
      const [store, set] = createStore(structuredClone(options.initial));
      setNotes = (mutation) => set(produce(mutation));
      return [store, setNotes];
    },
  },
} as unknown as MateTuiApi;

const cleanup = await plugin.setup(api);

const renders = await Promise.all(
  claims.map(async (claim) => ({
    placement: claim.prepend ?? claim.append ?? "",
    setup: await testRender(() => claim.render() as never, { width: 100, height: 12 }),
  })),
);

async function frame(rendered: (typeof renders)[number]): Promise<string> {
  await rendered.setup.renderOnce();
  return rendered.setup.captureCharFrame();
}

const initial = await Promise.all(renders.map(frame));
setNotes((draft) => {
  draft.lines = ["acme sync unfinished"];
});
const added = await Promise.all(renders.map(frame));
setNotes((draft) => {
  draft.lines = [];
});
const cleared = await Promise.all(renders.map(frame));

const frames = renders.map((rendered, index) => ({
  placement: rendered.placement,
  initial: initial[index],
  added: added[index],
  cleared: cleared[index],
}));
for (const rendered of renders) rendered.setup.renderer.destroy();
cleanup?.();
console.log(JSON.stringify({ placements: claims.length, frames }));
process.exit(0);
