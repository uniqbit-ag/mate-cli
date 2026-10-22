import { useEffect, useState } from "react";

export function InstallCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
    } catch {
      /** Clipboard access can be denied; the command stays selectable. */
    }
  }

  return (
    <div className="flex w-full max-w-md items-center gap-2 rounded-lg border bg-fd-card py-1.5 pr-1.5 pl-4 font-mono text-sm shadow-sm">
      <span className="text-fd-muted-foreground select-none" aria-hidden="true">
        $
      </span>
      <code className="flex-1 truncate">{command}</code>
      <button
        type="button"
        onClick={copy}
        className="rounded-md border bg-fd-background px-2.5 py-1 font-sans text-xs font-medium transition-colors hover:bg-fd-accent"
        aria-label={copied ? "Copied" : "Copy install command"}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
