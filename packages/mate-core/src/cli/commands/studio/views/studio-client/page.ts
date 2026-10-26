let toastTimer: ReturnType<typeof setTimeout> | undefined;

export function announce(message: string): void {
  const toast = document.getElementById("studio-toast");
  if (!toast) return;
  toast.textContent = message;
  toast.setAttribute("data-shown", "true");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.setAttribute("data-shown", "false");
  }, 1400);
}

export function copy(text: string, label: string): Promise<void> {
  if (
    typeof navigator === "undefined" ||
    !navigator.clipboard ||
    typeof navigator.clipboard.writeText !== "function"
  ) {
    announce("copying is blocked in this browser");
    return Promise.resolve();
  }
  return Promise.resolve()
    .then(() => navigator.clipboard.writeText(text))
    .then(
      () => {
        announce(`copied ${label}`);
      },
      () => {
        /* a blocked clipboard costs the copy, never the page */
        announce("copying is blocked in this browser");
      },
    );
}

export function failure(error: unknown): string {
  const message = (error as { message?: string } | null | undefined)?.message;
  return message ? message : String(error);
}

export function fetchMarkup(url: string, signal?: AbortSignal): Promise<string> {
  return fetch(url, { headers: { accept: "text/html" }, signal }).then((response) => {
    if (!response.ok) throw new Error(`status ${response.status}`);
    return response.text();
  });
}

/** Moves server-rendered nodes into a container; builds no markup of its own. */
export function moveInto(container: Element, markup: string): void {
  const parsed = new DOMParser().parseFromString(markup, "text/html");
  container.replaceChildren(
    ...Array.from(parsed.body.childNodes, (child) => document.importNode(child, true)),
  );
}

/** The save in flight, so navigation waits for it and a second save is refused. */
let savePromise: Promise<boolean> | null = null;

export function pendingSave(): Promise<boolean> | null {
  return savePromise;
}

export function setPendingSave(save: Promise<boolean> | null): void {
  savePromise = save;
}

export function editor(): HTMLTextAreaElement | null {
  return document.getElementById("vault-editor") as HTMLTextAreaElement | null;
}

export function dirty(): boolean {
  const node = editor();
  return !!node && node.value !== (node.getAttribute("data-vault-original") || "");
}

function askBeforeNavigation(): boolean {
  return !dirty() || window.confirm("Discard unsaved changes?");
}

/** Leaves for `url` once any save has settled, unless the viewer keeps unsaved changes. */
export function navigate(url: string): void {
  (savePromise ?? Promise.resolve(true)).then((allowed) => {
    if (allowed && askBeforeNavigation()) location.assign(url);
  });
}

function navigationUrl(form: HTMLFormElement, submitter?: HTMLElement | null): string {
  const target = new URL(form.action || location.href, location.href);
  new FormData(form).forEach((value, key) => {
    if (typeof value === "string") target.searchParams.append(key, value);
  });
  const named = submitter as HTMLButtonElement | null | undefined;
  if (named && named.name && named.value) target.searchParams.set(named.name, named.value);
  return target.toString();
}

export function wireNavigation(scope?: ParentNode): void {
  (scope || document)
    .querySelectorAll<HTMLFormElement>('form[method="get"]:not([data-vault-refresh])')
    .forEach((form) => {
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        navigate(navigationUrl(form, (event as SubmitEvent).submitter));
      });
      form.querySelectorAll("select").forEach((select) => {
        select.addEventListener("change", () => {
          navigate(navigationUrl(form));
        });
      });
    });
}
