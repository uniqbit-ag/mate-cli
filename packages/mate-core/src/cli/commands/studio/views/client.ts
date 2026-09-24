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
    if (typeof navigator === "undefined" || !navigator.clipboard || typeof navigator.clipboard.writeText !== "function") {
      announce("copying is blocked in this browser");
      return Promise.resolve();
    }
    return Promise.resolve().then(function () { return navigator.clipboard.writeText(text); }).then(
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

  var savePromise = null;
  function editor() { return document.getElementById("vault-editor"); }
  function status(message) {
    var node = document.getElementById("vault-status");
    if (node) node.textContent = message;
  }
  function dirty() {
    var node = editor();
    return !!node && node.value !== (node.getAttribute("data-vault-original") || "");
  }
  function setIncoming(event) {
    var box = document.getElementById("vault-incoming");
    var content = document.getElementById("vault-incoming-content");
    var recover = document.getElementById("vault-recover");
    if (!box || !content || !recover) return;
    box.hidden = false;
    content.textContent = event.content || "";
    recover.setAttribute("data-vault-content", event.content || "");
    recover.setAttribute("data-vault-token", event.token || "");
  }
  function acceptIncoming(event) {
    var node = editor();
    if (!node) return;
    node.value = event.content || "";
    node.setAttribute("data-vault-original", node.value);
    if (event.token) node.setAttribute("data-vault-token", event.token);
    var box = document.getElementById("vault-incoming");
    if (box) box.hidden = true;
    status("incoming version loaded into the editor");
  }
  function askBeforeNavigation() {
    return !dirty() || window.confirm("Discard unsaved changes?");
  }
  function waitForSave() {
    return savePromise ? savePromise.then(function (result) { return result; }) : Promise.resolve(true);
  }
  function navigate(url) {
    waitForSave().then(function (allowed) {
      if (allowed && askBeforeNavigation()) location.assign(url);
    });
  }
  function navigationUrl(form, submitter) {
    var target = new URL(form.action || location.href, location.href);
    new FormData(form).forEach(function (value, key) {
      if (typeof value === "string") target.searchParams.append(key, value);
    });
    if (submitter && submitter.name && submitter.value) target.searchParams.set(submitter.name, submitter.value);
    return target.toString();
  }
  function wireNavigation() {
    document.querySelectorAll('form[method="get"]').forEach(function (form) {
      form.addEventListener("submit", function (event) {
        event.preventDefault();
        navigate(navigationUrl(form, event.submitter));
      });
      form.querySelectorAll("select").forEach(function (select) {
        select.addEventListener("change", function () { navigate(navigationUrl(form)); });
      });
    });
  }
  function wireVault() {
    var node = editor();
    var root = document.querySelector("[data-vault-root]");
    if (!node || !root) return;
    node.setAttribute("data-vault-original", node.value);
    var save = document.getElementById("vault-save");
    if (save) save.addEventListener("click", function () {
      if (savePromise) return;
      var companion = document.querySelector("[data-companion]");
      var body = {
        companion: companion ? companion.getAttribute("data-companion") : "",
        path: node.getAttribute("data-vault-path"),
        content: node.value,
        token: node.getAttribute("data-vault-token"),
      };
      savePromise = fetch("/api/vault/save", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }).then(function (response) {
        return response.json().then(function (result) {
          if (!response.ok) {
            if (response.status === 409) setIncoming(result);
            status(result.reason || "save refused");
            return false;
          }
          node.setAttribute("data-vault-token", result.token || "");
          node.setAttribute("data-vault-original", node.value);
          status("saved");
          return true;
        });
      }).catch(function () {
        status("save failed");
        return false;
      }).finally(function () { savePromise = null; });
    });
    var recover = document.getElementById("vault-recover");
    if (recover) recover.addEventListener("click", function () {
      acceptIncoming({ content: recover.getAttribute("data-vault-content") || "", token: recover.getAttribute("data-vault-token") || "" });
    });
    var companion = document.querySelector("[data-companion]");
    var path = node.getAttribute("data-vault-path");
    if (companion && path && typeof EventSource !== "undefined") {
      var events = new EventSource("/api/vault/events?companion=" + encodeURIComponent(companion.getAttribute("data-companion") || "") + "&path=" + encodeURIComponent(path));
      events.onmessage = function (message) {
        var event;
        try { event = JSON.parse(message.data); } catch (error) { return; }
        if (event.kind === "overwritten") {
          setIncoming(event);
          status("a version was overwritten; its content is available below");
          return;
        }
        if (event.kind === "removed") {
          status("this file no longer exists on disk");
          return;
        }
        if (dirty()) {
          setIncoming(event);
          status("the file changed on disk; unsaved content is still in the editor");
          return;
        }
        node.value = event.content || "";
        node.setAttribute("data-vault-original", node.value);
        if (event.token) node.setAttribute("data-vault-token", event.token);
        status("updated from disk");
      };
    }
  }
  if (typeof window !== "undefined") window.addEventListener("beforeunload", function (event) {
      if (!dirty()) return;
      event.preventDefault();
      event.returnValue = "";
    });
  wireNavigation();
  wireVault();
})();`;
