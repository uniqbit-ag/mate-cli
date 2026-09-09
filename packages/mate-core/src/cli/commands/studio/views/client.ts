import { COMPANION_DIGEST_PATTERN, COMPANION_PARAM } from "../selection";

export const THEME_STORAGE_KEY = "mate-studio-theme";
export const COMPANION_STORAGE_KEY = "mate-studio-companion";

/**
 * Runs in `<head>` before first paint. A server-rendered document arrives with
 * its markup already in place, so a remembered appearance applied after load
 * would paint the other one first and then repaint, and a remembered companion
 * restored after load would paint the picker before leaving it.
 *
 * The restore names the companion in the URL and reloads, because the URL is
 * what the server answers. A companion parameter that is present and empty is
 * a deliberate "no companion" and is left alone, so the redirect cannot loop
 * and the picker stays reachable.
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

  try {
    var params = new URLSearchParams(location.search);
    var last = localStorage.getItem(${JSON.stringify(COMPANION_STORAGE_KEY)});
    if (!params.has(${JSON.stringify(COMPANION_PARAM)}) && ${String(COMPANION_DIGEST_PATTERN)}.test(last || "")) {
      params.set(${JSON.stringify(COMPANION_PARAM)}, last);
      location.replace(location.pathname + "?" + params.toString());
    }
  } catch (error) {
    /* a blocked web store only costs the restore, never the page */
  }
})();`;

/**
 * The only browser code Studio ships: cycling the appearance, remembering the
 * companion on screen, switching workflow schema tabs, and copying a prompt.
 * Each needs an API the server does not have, and nothing else here renders,
 * fetches, or holds state.
 */
export const STUDIO_CLIENT_SCRIPT = `(function () {
  var THEME_KEY = ${JSON.stringify(THEME_STORAGE_KEY)};
  var COMPANION_KEY = ${JSON.stringify(COMPANION_STORAGE_KEY)};
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

  function rememberCompanion() {
    var scope = document.querySelector("[data-companion]");
    var current = scope && scope.getAttribute("data-companion");
    if (!current) return;
    try {
      localStorage.setItem(COMPANION_KEY, current);
    } catch (error) {
      /* a blocked web store only costs the next visit, never the page */
    }
  }

  function wireWorkflowSchemaTabs() {
    document.querySelectorAll("[data-workflow-schema-root]").forEach(function (root) {
      var tabs = root.querySelectorAll("[data-workflow-schema-profile]");
      var panels = root.querySelectorAll("[data-workflow-schema-panel]");

      function select(profile) {
        tabs.forEach(function (tab) {
          tab.setAttribute(
            "aria-selected",
            tab.getAttribute("data-workflow-schema-profile") === profile ? "true" : "false",
          );
        });
        panels.forEach(function (panel) {
          panel.setAttribute(
            "data-active",
            panel.getAttribute("data-workflow-schema-panel") === profile ? "true" : "false",
          );
        });
      }

      tabs.forEach(function (tab) {
        tab.addEventListener("click", function () {
          select(tab.getAttribute("data-workflow-schema-profile"));
        });
      });

      var selected = root.querySelector('[aria-selected="true"]');
      if (selected) select(selected.getAttribute("data-workflow-schema-profile"));
    });
  }

  function wireSkillTabs() {
    document.querySelectorAll("[data-skills-root]").forEach(function (root) {
      var tabs = root.querySelectorAll("[data-skill-profile]");
      var panels = root.querySelectorAll("[data-skill-panel]");

      function select(profile) {
        tabs.forEach(function (tab) {
          tab.setAttribute(
            "aria-selected",
            tab.getAttribute("data-skill-profile") === profile ? "true" : "false",
          );
        });
        panels.forEach(function (panel) {
          var active = panel.getAttribute("data-skill-panel") === profile;
          panel.setAttribute("data-active", active ? "true" : "false");
          panel.setAttribute("aria-hidden", active ? "false" : "true");
        });
      }

      tabs.forEach(function (tab) {
        tab.addEventListener("click", function () {
          select(tab.getAttribute("data-skill-profile"));
        });
      });

      var selected = root.querySelector('[aria-selected="true"]');
      if (selected) select(selected.getAttribute("data-skill-profile"));
    });
  }

  applyTheme(theme);
  rememberCompanion();
  wireWorkflowSchemaTabs();
  wireSkillTabs();

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
