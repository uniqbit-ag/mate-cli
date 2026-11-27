import { GlobalRegistrator } from "@happy-dom/global-registrator";

// One DOM for every browser test in this process; imported first, before React loads.
if (!GlobalRegistrator.isRegistered) {
  const { TransformStream } = globalThis;
  GlobalRegistrator.register({ url: "http://localhost/" });
  // happy-dom brings its own TransformStream, which the runtime's response bodies cannot pipe
  // through; the AI SDK's chat stream parser extends it.
  globalThis.TransformStream = TransformStream;
  // Happy DOM lacks the browser rule that hides a closed `details` body, so queries would see it.
  const style = document.createElement("style");
  style.textContent = "details:not([open]) > :not(summary) { display: none; }";
  document.head.append(style);
}
