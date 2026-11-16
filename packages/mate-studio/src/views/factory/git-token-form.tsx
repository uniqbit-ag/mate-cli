import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { FormEvent } from "react";

import { gitTokensKey, type GitTokens, setGitToken } from "../../lib/git-tokens";

/** Reads the form's fields and empties the token, so it lives only in this request. */
function takeFields(event: FormEvent<HTMLFormElement>): { key: string; token: string } {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const key = data.get("key");
  const token = data.get("token");
  form.querySelector<HTMLInputElement>('[name="token"]')!.value = "";
  return { key: typeof key === "string" ? key : "", token: typeof token === "string" ? token : "" };
}

/**
 * Sets a Git token for a `host` or `host/org`. Used by the Git access panel and by the dialogs
 * that add a repository, which pass the key of the URL that was refused.
 */
export function GitTokenForm({
  defaultKey = "",
  onSaved,
}: {
  defaultKey?: string;
  onSaved?: (tokens: GitTokens) => void;
}) {
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: ({ key, token }: { key: string; token: string }) => setGitToken(key, token),
    onSuccess: (next) => {
      queryClient.setQueryData(gitTokensKey, next);
      onSaved?.(next);
    },
  });
  return (
    <form
      className="factory-sheet"
      data-git-token-form=""
      onSubmit={(event) => save.mutate(takeFields(event))}
    >
      <label className="agents-field">
        <span>Host or host/organization</span>
        <input
          type="text"
          name="key"
          defaultValue={defaultKey}
          placeholder="git.acme.test/acme"
          autoComplete="off"
          spellCheck={false}
          required
        />
      </label>
      <label className="agents-field">
        <span>Token</span>
        <input type="password" name="token" autoComplete="off" spellCheck={false} required />
      </label>
      <div className="factory-sheet-actions">
        <button type="submit" disabled={save.isPending}>
          Save
        </button>
      </div>
      {save.error ? (
        <p className="factory-problems" role="alert">
          {save.error.message}
        </p>
      ) : null}
    </form>
  );
}
