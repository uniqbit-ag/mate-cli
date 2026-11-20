import { GlobalRegistrator } from "@happy-dom/global-registrator";

// One DOM for every browser test in this process; imported first, before React loads.
if (!GlobalRegistrator.isRegistered) {
  const { TransformStream } = globalThis;
  GlobalRegistrator.register({ url: "http://localhost/" });
  // happy-dom brings its own TransformStream, which the runtime's response bodies cannot pipe
  // through; the AI SDK's chat stream parser extends it.
  globalThis.TransformStream = TransformStream;
}
