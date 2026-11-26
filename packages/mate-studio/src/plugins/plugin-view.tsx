import type {
  StudioViewLayout,
  StudioViewMount,
  StudioViewMountContext,
} from "@uniqbit/mate-core/studio";
import { useEffect, useRef, useState } from "react";

import { cn } from "../lib/cn";
import { studioConnection } from "../stores/connection";

/** Loads a view module; the browser's own `import` outside tests. */
export type ModuleLoader = (url: string) => Promise<Record<string, unknown>>;

const browserImport: ModuleLoader = (url) =>
  import(/* @vite-ignore */ url) as Promise<Record<string, unknown>>;

/**
 * Loads a service's view module and mounts it into `element`. Resolves to its unmount; rejects
 * when the module has no `mount` export.
 */
export async function mountPluginView(
  element: HTMLElement,
  moduleUrl: string,
  context: StudioViewMountContext,
  load: ModuleLoader = browserImport,
): Promise<() => void> {
  const module = await load(moduleUrl);
  const mount = module.mount;
  if (typeof mount !== "function") throw new Error("the view module has no mount export");
  const unmount = (mount as StudioViewMount)(element, context);
  return typeof unmount === "function" ? unmount : () => {};
}

/**
 * A plugin service's view: its module owns everything inside the element, mounted in the
 * browser only and unmounted when the view, its companion or the module changes.
 */
export function PluginView({
  moduleUrl,
  context,
  layout = "page",
  load,
}: {
  moduleUrl: string;
  context: StudioViewMountContext;
  /** `"workspace"`: no inset; the module fills the main area. */
  layout?: StudioViewLayout;
  load?: ModuleLoader;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const { companion, apiBase, writable } = context;
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let unmount: (() => void) | null = null;
    let left = false;
    setFailure(null);
    // The monitor lives as long as the page, so a state change never mounts the view again.
    const connection = studioConnection() ?? undefined;
    mountPluginView(element, moduleUrl, { companion, apiBase, writable, connection }, load).then(
      (done) => {
        if (left) done();
        else unmount = done;
      },
      (error: unknown) => {
        if (!left) setFailure(error instanceof Error ? error.message : String(error));
      },
    );
    return () => {
      left = true;
      unmount?.();
      element.replaceChildren();
    };
  }, [moduleUrl, companion, apiBase, writable, load]);
  return (
    <section
      className={cn(
        "plugin-view min-h-0 flex-1",
        layout === "workspace" ? undefined : "mx-8 max-sm:mx-4",
      )}
      data-layout={layout}
    >
      {failure ? (
        <p className="m-0 rounded-card border border-dashed border-rule px-6 py-7 text-muted">
          The view could not load: {failure}
        </p>
      ) : null}
      <div ref={host} data-plugin-view={moduleUrl} />
    </section>
  );
}
