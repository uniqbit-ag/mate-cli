import { REPORT_VIEW_PREFIX } from "../routes";
import { COMPANION_DIGEST_PATTERN, COMPANION_PARAM } from "../selection";

export const THEME_STORAGE_KEY = "mate-studio-theme";
export const COMPANION_STORAGE_KEY = "mate-studio-companion";
export const VAULT_TREE_STORAGE_KEY = "mate-studio-vault-tree";

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
    if (localStorage.getItem(${JSON.stringify(VAULT_TREE_STORAGE_KEY)}) === "hidden") {
      document.documentElement.setAttribute("data-vault-tree", "hidden");
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
 * companion on screen, switching workflow schema tabs, copying a prompt, the
 * vault's editor, filter and tree toggle, and swapping in a deferred vault tree.
 * Each needs an API the server does not have; all markup comes from the server.
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

  /* Delegated: a spec row's controls need no per-node wiring. */
  var AGENT_ORDER = ["claude", "opencode"];
  function copyPromptFor(node) {
    var viewed = document.documentElement.getAttribute("data-agent-viewed");
    var order = viewed ? [viewed].concat(AGENT_ORDER) : AGENT_ORDER;
    for (var index = 0; index < order.length; index += 1) {
      var text = node.getAttribute("data-prompt-" + order[index]);
      if (text) return text;
    }
    return null;
  }
  if (typeof document.addEventListener === "function") document.addEventListener("click", function (event) {
    var target = event.target;
    if (!target || typeof target.closest !== "function") return;
    var run = target.closest("[data-studio-action]");
    if (run) {
      var agents = (run.getAttribute("data-studio-agents") || "").split(" ").filter(Boolean);
      document.dispatchEvent(new CustomEvent("studio:terminal-action", {
        detail: { action: run.getAttribute("data-studio-action"), subject: run.getAttribute("data-studio-subject"), agents: agents },
      }));
      return;
    }
    var prompt = target.closest("[data-studio-copy-prompt]");
    if (prompt) {
      var text = copyPromptFor(prompt);
      if (text) copy(text, "prompt");
    }
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
  function wireNavigation(scope) {
    (scope || document).querySelectorAll('form[method="get"]:not([data-vault-refresh])').forEach(function (form) {
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
    var eventsUrl = node.getAttribute("data-vault-events");
    if (eventsUrl && typeof EventSource !== "undefined") {
      var events = new EventSource(eventsUrl);
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
  function showTree(shown) {
    var root = document.documentElement;
    if (shown) root.removeAttribute("data-vault-tree");
    else root.setAttribute("data-vault-tree", "hidden");
    var toggle = document.getElementById("vault-tree-toggle");
    if (toggle) {
      toggle.textContent = shown ? "Hide files" : "Show files";
      toggle.setAttribute("aria-expanded", shown ? "true" : "false");
    }
    try {
      localStorage.setItem(${JSON.stringify(VAULT_TREE_STORAGE_KEY)}, shown ? "shown" : "hidden");
    } catch (error) {
      /* a blocked web store only costs the preference, never the page */
    }
  }
  var displayedGeneration = null;
  var latestGeneration = null;
  var refreshSequence = 0;
  var filterSequence = 0;
  var filterTimer = null;
  var filterRequest = null;
  var FILTER_DELAY = 150;

  function failure(error) {
    return error && error.message ? error.message : String(error);
  }
  function fetchMarkup(url, signal) {
    return fetch(url, { headers: { accept: "text/html" }, signal: signal }).then(function (response) {
      if (!response.ok) throw new Error("status " + response.status);
      return response.text();
    });
  }
  /** Moves server-rendered nodes into a container; builds no markup of its own. */
  function moveInto(container, markup) {
    var parsed = new DOMParser().parseFromString(markup, "text/html");
    container.replaceChildren.apply(
      container,
      Array.prototype.map.call(parsed.body.childNodes, function (child) { return document.importNode(child, true); }),
    );
  }
  function readGeneration(slot) {
    var value = slot ? slot.getAttribute("data-vault-generation") : null;
    return value === null || value === "" ? null : Number(value);
  }
  /** The indicator clears only once the displayed listing is as new as the newest change seen. */
  function showStale() {
    var note = document.getElementById("vault-stale");
    if (!note) return;
    note.hidden = !(latestGeneration !== null && displayedGeneration !== null && latestGeneration > displayedGeneration);
  }
  function openedByViewer() {
    var keys = [];
    document.querySelectorAll("details[data-vault-children-url][open]").forEach(function (folder) {
      keys.push(folder.getAttribute("data-vault-dir"));
    });
    return keys;
  }
  /** Swaps server-rendered parts into place; a refreshed tree drops loaded folders and reopens the viewer's. */
  function swapVaultSlots(markup) {
    var reopen = openedByViewer();
    var parsed = new DOMParser().parseFromString(markup, "text/html");
    parsed.querySelectorAll("[data-vault-slot]").forEach(function (slot) {
      var name = slot.getAttribute("data-vault-slot");
      var target = document.querySelector('[data-vault-slot="' + name + '"]');
      if (!target) return;
      var node = document.importNode(slot, true);
      target.replaceWith(node);
      wireNavigation(node);
      if (name !== "tree") return;
      displayedGeneration = readGeneration(node);
      node.querySelectorAll("details[data-vault-children-url]").forEach(function (folder) {
        if (reopen.indexOf(folder.getAttribute("data-vault-dir")) !== -1) folder.open = true;
      });
    });
    showStale();
    runFilter();
  }
  function failVaultSlots(message) {
    document.querySelectorAll("[data-vault-slot][aria-busy]").forEach(function (slot) {
      slot.removeAttribute("aria-busy");
      slot.textContent = message;
    });
  }
  function loadChildren(folder) {
    var url = folder.getAttribute("data-vault-children-url");
    var container = folder.querySelector(".vault-children");
    if (!url || !container || folder.hasAttribute("data-vault-loaded") || folder.hasAttribute("data-vault-loading")) return;
    folder.setAttribute("data-vault-loading", "");
    fetchMarkup(url).then(function (markup) {
      moveInto(container, markup);
      folder.setAttribute("data-vault-loaded", "");
    }).catch(function (error) {
      container.textContent = "This folder could not be loaded: " + failure(error);
    }).finally(function () { folder.removeAttribute("data-vault-loading"); });
  }
  function runFilter() {
    var filter = document.getElementById("vault-filter");
    var results = document.getElementById("vault-filter-results");
    var panel = document.getElementById("vault-tree-panel");
    var layout = document.querySelector("[data-vault-layout]");
    if (!filter || !results || !panel || !layout) return;
    clearTimeout(filterTimer);
    if (filterRequest) filterRequest.abort();
    var needle = filter.value.trim();
    filterSequence += 1;
    if (!needle) {
      results.hidden = true;
      results.replaceChildren();
      panel.removeAttribute("data-vault-filtering");
      return;
    }
    var url = new URL(layout.getAttribute("data-vault-filter-url") || "", location.href);
    url.searchParams.set("q", needle);
    var sequence = filterSequence;
    filterRequest = typeof AbortController !== "undefined" ? new AbortController() : null;
    fetchMarkup(url.toString(), filterRequest ? filterRequest.signal : undefined).then(function (markup) {
      if (sequence !== filterSequence) return;
      moveInto(results, markup);
      results.hidden = false;
      panel.setAttribute("data-vault-filtering", "");
    }).catch(function (error) {
      if (sequence !== filterSequence || (error && error.name === "AbortError")) return;
      results.textContent = "The filter could not run: " + failure(error);
      results.hidden = false;
      panel.setAttribute("data-vault-filtering", "");
    });
  }
  /** Replaces the tree, listing and filter results in place; the editor and terminal are left alone. */
  function refreshTree() {
    var layout = document.querySelector("[data-vault-layout]");
    var status = document.getElementById("vault-refresh-status");
    var url = layout ? layout.getAttribute("data-vault-refresh-url") : null;
    if (!url) return;
    refreshSequence += 1;
    var sequence = refreshSequence;
    if (status) status.hidden = true;
    fetchMarkup(url).then(function (markup) {
      if (sequence === refreshSequence) swapVaultSlots(markup);
    }).catch(function (error) {
      if (sequence !== refreshSequence || !status) return;
      status.textContent = "The tree could not be refreshed: " + failure(error) + ". Select Refresh tree to retry.";
      status.hidden = false;
    });
  }
  function watchTreeChanges(layout) {
    var url = layout.getAttribute("data-vault-changes-url");
    if (!url || typeof EventSource === "undefined") return;
    var changes = new EventSource(url);
    changes.onmessage = function (message) {
      var event;
      try { event = JSON.parse(message.data); } catch (error) { return; }
      if (!event || event.type !== "vault-tree-changed" || typeof event.generation !== "number") return;
      if (latestGeneration === null || event.generation > latestGeneration) latestGeneration = event.generation;
      showStale();
    };
  }
  function wireVaultBrowser() {
    var layout = document.querySelector("[data-vault-layout]");
    if (!layout) return;
    var panel = document.getElementById("vault-tree-panel");
    displayedGeneration = readGeneration(document.querySelector('[data-vault-slot="tree"]'));
    if (panel) {
      panel.addEventListener("click", function (event) {
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        var link = event.target && event.target.closest ? event.target.closest("a[data-vault-entry]") : null;
        if (!link) return;
        event.preventDefault();
        navigate(link.href);
      });
      panel.addEventListener("toggle", function (event) {
        var folder = event.target;
        if (folder && folder.open && folder.matches && folder.matches("details[data-vault-children-url]")) loadChildren(folder);
      }, true);
    }
    var refresh = document.querySelector("form[data-vault-refresh]");
    if (refresh) refresh.addEventListener("submit", function (event) {
      event.preventDefault();
      refreshTree();
    });
    var filter = document.getElementById("vault-filter");
    if (filter) {
      filter.hidden = false;
      filter.addEventListener("input", function () {
        clearTimeout(filterTimer);
        filterTimer = setTimeout(runFilter, FILTER_DELAY);
      });
    }
    var toggle = document.getElementById("vault-tree-toggle");
    if (toggle) {
      toggle.hidden = false;
      var hidden = document.documentElement.getAttribute("data-vault-tree") === "hidden";
      toggle.textContent = hidden ? "Show files" : "Hide files";
      toggle.setAttribute("aria-expanded", hidden ? "false" : "true");
      toggle.addEventListener("click", function () {
        showTree(document.documentElement.getAttribute("data-vault-tree") === "hidden");
      });
    }
    watchTreeChanges(layout);
    var deferred = layout.getAttribute("data-vault-view");
    if (!deferred) return;
    fetchMarkup(deferred).then(swapVaultSlots).catch(function (error) {
      failVaultSlots("The files could not be listed: " + failure(error));
    });
  }
  /** Hosted reports: the list, the sandboxed frame, and the toast and badge for a new arrival. */
  function wireReports() {
    var shell = document.querySelector("[data-reports-events-url]");
    if (!shell || typeof EventSource === "undefined") return;
    var current = shell.getAttribute("data-companion");
    var listUrl = shell.getAttribute("data-reports-url");
    var viewUrl = shell.getAttribute("data-reports-view-url");
    var list = document.getElementById("reports-list");
    var frame = document.getElementById("reports-frame");
    var open = document.getElementById("reports-open");
    var empty = document.getElementById("reports-empty");
    var template = document.getElementById("reports-item-template");
    var badge = document.getElementById("reports-badge");
    var toast = document.getElementById("reports-toast");
    var toastTitle = document.getElementById("reports-toast-title");
    var toastOpen = document.getElementById("reports-toast-open");
    var shown = null;
    var toastTimeout;
    function reportHash() {
      var match = /(?:^|[#&])report=([0-9a-f]{32})/.exec(location.hash || "");
      return match ? match[1] : null;
    }
    function show(id) {
      if (!frame) return;
      shown = id;
      var src = ${JSON.stringify(REPORT_VIEW_PREFIX)} + id;
      frame.src = src;
      frame.hidden = false;
      if (open) { open.href = src; open.hidden = false; }
      if (list) list.querySelectorAll("button[data-report-id]").forEach(function (button) {
        button.setAttribute("aria-pressed", button.getAttribute("data-report-id") === id ? "true" : "false");
      });
      try { history.replaceState(null, "", "#report=" + id); } catch (error) { /* the address is a convenience */ }
    }
    function render(reports) {
      if (!list || !template || !template.content.firstElementChild) return;
      list.replaceChildren();
      if (empty) empty.hidden = reports.length > 0;
      reports.forEach(function (report) {
        var item = template.content.firstElementChild.cloneNode(true);
        var button = item.querySelector("button");
        button.setAttribute("data-report-id", report.id);
        button.setAttribute("aria-pressed", report.id === shown ? "true" : "false");
        item.querySelector("[data-report-title]").textContent = report.title;
        item.querySelector("[data-report-time]").textContent = new Date(report.createdAt).toLocaleString();
        button.addEventListener("click", function () { show(report.id); });
        list.append(item);
      });
      if (reports.length === 0 || reports.some(function (report) { return report.id === shown; })) return;
      var named = reportHash();
      show(reports.some(function (report) { return report.id === named; }) ? named : reports[0].id);
    }
    function refreshList() {
      if (!list || !listUrl) return;
      fetch(listUrl, { headers: { accept: "application/json" } }).then(function (response) {
        if (!response.ok) throw new Error("status " + response.status);
        return response.json();
      }).then(function (body) { render(body.reports || []); }).catch(function () { /* the next event or reconnect retries */ });
    }
    function announceReport(event) {
      if (badge) badge.hidden = false;
      if (!toast || !toastTitle) return;
      toastTitle.textContent = "New report: " + event.title;
      if (toastOpen && viewUrl) toastOpen.href = viewUrl + "#report=" + event.id;
      toast.setAttribute("data-shown", "true");
      clearTimeout(toastTimeout);
      toastTimeout = setTimeout(function () { toast.setAttribute("data-shown", "false"); }, 10000);
    }
    var events = new EventSource(shell.getAttribute("data-reports-events-url"));
    events.onopen = refreshList;
    events.onmessage = function (message) {
      var event;
      try { event = JSON.parse(message.data); } catch (error) { return; }
      if (!event || event.type !== "report-published" || event.companion !== current) return;
      if (list) refreshList();
      else announceReport(event);
    };
  }
  wireNavigation();
  wireVault();
  wireVaultBrowser();
  wireReports();
})();`;
