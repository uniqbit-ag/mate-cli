import { GlobalRegistrator } from "@happy-dom/global-registrator";

// One DOM for every browser test in this process; imported first, before React loads.
if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register({ url: "http://localhost/" });
