import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { GitTokenStatus } from "@uniqbit/mate-core/studio";
import { useState } from "react";

import { Sheet, SheetClose, SheetContent, SheetTitle } from "../../components/ui/sheet";
import { clearGitToken, gitTokensKey, gitTokensQuery } from "../../lib/git-tokens";
import { GitTokenForm } from "./git-token-form";

function sourceText(token: GitTokenStatus): string {
  return token.source === "studio"
    ? `set in Studio${token.setAt ? ` on ${token.setAt.slice(0, 10)}` : ""}`
    : "supplied at startup";
}

/** The Git access panel, sliding over the page: Git tokens per host or organization for cloning. */
export function GitAccessDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const status = useQuery(gitTokensQuery());
  const [saved, setSaved] = useState(false);
  const clear = useMutation({
    mutationFn: clearGitToken,
    onSuccess: (next) => {
      queryClient.setQueryData(gitTokensKey, next);
      setSaved(false);
    },
  });
  const tokens = status.data?.tokens ?? [];
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent
        className="agents-dialog"
        aria-labelledby="git-access-title"
        initialFocus={() =>
          document.querySelector<HTMLElement>(".agents-dialog .outcome-dialog-close")
        }
      >
        <header className="outcome-dialog-head">
          <div className="outcome-dialog-heading">
            <SheetTitle id="git-access-title">Git access</SheetTitle>
            <p className="outcome-dialog-state" data-git-access-status="">
              {status.error
                ? status.error.message
                : status.data
                  ? `${tokens.length} ${tokens.length === 1 ? "key" : "keys"} set.`
                  : "Checking…"}
            </p>
          </div>
          <SheetClose className="outcome-dialog-close" aria-keyshortcuts="Escape">
            Close <kbd>Esc</kbd>
          </SheetClose>
        </header>
        <div className="agents-dialog-body">
          <p className="note">
            A token clones private repositories. Set it for a host, or for a host and organization;
            the organization's token wins. Tokens are kept by the factory and never shown again.
          </p>
          {tokens.length > 0 ? (
            <ul className="git-access-keys" data-git-access-keys="">
              {tokens.map((token) => (
                <li key={token.key} data-git-access-key={token.key}>
                  <span className="mono">{token.key}</span>{" "}
                  <span className="note">{sourceText(token)}</span>
                  {token.source === "studio" ? (
                    <button
                      type="button"
                      onClick={() => clear.mutate(token.key)}
                      disabled={clear.isPending}
                    >
                      Remove
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          {clear.error ? (
            <p className="factory-problems" role="alert">
              {clear.error.message}
            </p>
          ) : null}
          <GitTokenForm onSaved={() => setSaved(true)} />
          {saved ? (
            <p className="note" role="status">
              Saved. The next clone uses it.
            </p>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
