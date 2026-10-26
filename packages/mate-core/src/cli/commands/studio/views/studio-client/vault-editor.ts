import { dirty, editor, pendingSave, setPendingSave } from "./page";

interface IncomingVersion {
  content?: string;
  token?: string;
  kind?: string;
}

function status(message: string): void {
  const node = document.getElementById("vault-status");
  if (node) node.textContent = message;
}

function setIncoming(event: IncomingVersion): void {
  const box = document.getElementById("vault-incoming");
  const content = document.getElementById("vault-incoming-content");
  const recover = document.getElementById("vault-recover");
  if (!box || !content || !recover) return;
  box.hidden = false;
  content.textContent = event.content || "";
  recover.setAttribute("data-vault-content", event.content || "");
  recover.setAttribute("data-vault-token", event.token || "");
}

function acceptIncoming(event: IncomingVersion): void {
  const node = editor();
  if (!node) return;
  node.value = event.content || "";
  node.setAttribute("data-vault-original", node.value);
  if (event.token) node.setAttribute("data-vault-token", event.token);
  const box = document.getElementById("vault-incoming");
  if (box) box.hidden = true;
  status("incoming version loaded into the editor");
}

function save(node: HTMLTextAreaElement): void {
  if (pendingSave()) return;
  const companion = document.querySelector("[data-companion]");
  const body = {
    companion: companion ? companion.getAttribute("data-companion") : "",
    path: node.getAttribute("data-vault-path"),
    content: node.value,
    token: node.getAttribute("data-vault-token"),
  };
  const request = fetch("/api/vault/save", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
    .then((response) =>
      response.json().then((result: IncomingVersion & { reason?: string }) => {
        if (!response.ok) {
          if (response.status === 409) setIncoming(result);
          status(result.reason || "save refused");
          return false;
        }
        node.setAttribute("data-vault-token", result.token || "");
        node.setAttribute("data-vault-original", node.value);
        status("saved");
        return true;
      }),
    )
    .catch(() => {
      status("save failed");
      return false;
    })
    .finally(() => {
      setPendingSave(null);
    });
  setPendingSave(request);
}

/** Applies a version the file stream reports; a dirty editor keeps its text and offers the new one. */
function followStream(node: HTMLTextAreaElement, eventsUrl: string): void {
  const events = new EventSource(eventsUrl);
  events.onmessage = (message) => {
    let event: IncomingVersion;
    try {
      event = JSON.parse(message.data);
    } catch {
      return;
    }
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

export function wireVaultEditor(): void {
  setPendingSave(null);
  const node = editor();
  const root = document.querySelector("[data-vault-root]");
  if (!node || !root) return;
  node.setAttribute("data-vault-original", node.value);
  const saveButton = document.getElementById("vault-save");
  if (saveButton) saveButton.addEventListener("click", () => save(node));
  const recover = document.getElementById("vault-recover");
  if (recover) {
    recover.addEventListener("click", () => {
      acceptIncoming({
        content: recover.getAttribute("data-vault-content") || "",
        token: recover.getAttribute("data-vault-token") || "",
      });
    });
  }
  const eventsUrl = node.getAttribute("data-vault-events");
  if (eventsUrl && typeof EventSource !== "undefined") followStream(node, eventsUrl);
}

/** Asks the browser to confirm leaving while the editor holds unsaved text. */
export function wireUnloadGuard(): void {
  if (typeof window === "undefined") return;
  window.addEventListener("beforeunload", (event) => {
    if (!dirty()) return;
    event.preventDefault();
    event.returnValue = "";
  });
}
