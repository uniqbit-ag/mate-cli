import { GlobalRegistrator } from "@happy-dom/global-registrator";

// One DOM for every browser test in this process; imported first, before React loads.
if (!GlobalRegistrator.isRegistered) {
  GlobalRegistrator.register({ url: "http://localhost/" });
  // Happy DOM lacks the browser rule that hides a closed `details` body, so queries would see it.
  const style = document.createElement("style");
  style.textContent = "details:not([open]) > :not(summary) { display: none; }";
  document.head.append(style);
}
