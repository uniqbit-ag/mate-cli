export const THEME_STORAGE_KEY = "mate-studio-theme";

/**
 * Runs in `<head>` before first paint. A server-rendered document arrives with
 * its markup already in place, so a remembered appearance applied after load
 * would paint the other one first and then repaint.
 */
export const STUDIO_PREPAINT_SCRIPT = `(function () {
  try {
    var chosen = localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});
    if (chosen === "dark" || chosen === "light") {
      document.documentElement.setAttribute("data-theme", chosen);
    }
  } catch (error) {
    /* a blocked web store only costs the preference, never the page */
  }
})();`;

/**
 * The only browser code Studio ships: cycling the appearance and copying a
 * prompt. Both need an API the server does not have, and nothing else here
 * renders, fetches, or holds state.
 */
export const STUDIO_CLIENT_SCRIPT = `(function () {
  var THEME_KEY = ${JSON.stringify(THEME_STORAGE_KEY)};
  var THEME_CYCLE = ["system", "dark", "light"];
  var toastTimer;

  function readTheme() {
    try {
      var stored = localStorage.getItem(THEME_KEY);
      return THEME_CYCLE.indexOf(stored) === -1 ? "system" : stored;
    } catch (error) {
      return "system";
    }
  }

  function storeTheme(theme) {
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch (error) {
      /* a blocked web store only costs the preference, never the page */
    }
  }

  var theme = readTheme();

  function applyTheme(next) {
    theme = next;
    var root = document.documentElement;
    if (next === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", next);
    var control = document.getElementById("studio-theme");
    if (control) {
      control.textContent = "Theme: " + next;
      control.setAttribute("data-theme-state", next);
    }
  }

  function announce(message) {
    var toast = document.getElementById("studio-toast");
    if (!toast) return;
    toast.textContent = message;
    toast.setAttribute("data-shown", "true");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toast.setAttribute("data-shown", "false");
    }, 1400);
  }

  function copy(text, label) {
    return navigator.clipboard.writeText(text).then(
      function () {
        announce("copied " + label);
      },
      function () {
        /* a blocked clipboard costs the copy, never the page */
        announce("copying is blocked in this browser");
      },
    );
  }

  applyTheme(theme);

  var toggle = document.getElementById("studio-theme");
  if (toggle) {
    toggle.addEventListener("click", function () {
      var next = THEME_CYCLE[(THEME_CYCLE.indexOf(theme) + 1) % THEME_CYCLE.length];
      applyTheme(next);
      storeTheme(next);
    });
  }

  document.querySelectorAll("[data-copy]").forEach(function (node) {
    node.addEventListener("click", function () {
      var text = node.getAttribute("data-copy");
      if (text) copy(text, node.getAttribute("data-copy-label") || "prompt");
    });
  });
})();`;
