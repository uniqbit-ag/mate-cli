import type {
  SharePreview,
  StudioWorkCard,
  StudioWorkPayload,
  WorkRequest,
  WorkResult,
} from "@uniqbit/mate-core/studio";
import { useEffect, useState, type ReactNode } from "react";

import { Button } from "../../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../../components/ui/dialog";
import { CommandLine } from "../../components/view-parts";
import { useWorkUi, type WorkDialog } from "../../stores/work-ui";
import { newWorkKey, REFUSAL_HINTS, useWorkAction } from "./use-work-action";

interface DialogProps {
  companion: string;
  payload: StudioWorkPayload;
}

function Refusal({ result }: { result: WorkResult | undefined }) {
  if (!result || result.ok) return null;
  return (
    <div
      className="grid gap-1 rounded-control border border-bad bg-bad-soft px-3 py-2 text-sm"
      role="alert"
    >
      <span>{result.reason}</span>
      {REFUSAL_HINTS[result.kind] ? (
        <span className="text-xs text-muted">{REFUSAL_HINTS[result.kind]}</span>
      ) : null}
    </div>
  );
}

/** The dialog frame every Work confirmation shares; closing never acts. */
function Frame({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description: ReactNode;
  children?: ReactNode;
  footer: ReactNode;
}) {
  const close = useWorkUi((state) => state.close);
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : close())}>
      <DialogContent className="grid gap-4 p-5" data-work-dialog="">
        <div className="grid gap-1">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </div>
        {children}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          {footer}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function useConfirm(companion: string) {
  const close = useWorkUi((state) => state.close);
  const mutation = useWorkAction(companion);
  // One key per open dialog: a double click resubmits the same attempt.
  const [key] = useState(newWorkKey);
  const run = (request: WorkRequest, onOk?: (result: WorkResult) => void) =>
    mutation.mutate(request, {
      onSuccess: (result) => {
        if (!result.ok) return;
        if (onOk) onOk(result);
        else close();
      },
    });
  return { mutation, run, key, result: mutation.data };
}

function PreviewSummary({ preview }: { preview: SharePreview }) {
  return (
    <>
      <p className="m-0">
        To <code className="font-mono">{`${preview.target.remote}/${preview.target.branch}`}</code>:{" "}
        {preview.members.length} {preview.members.length === 1 ? "change" : "changes"},{" "}
        {preview.files.length} files.
      </p>
      <details>
        <summary className="cursor-pointer text-xs text-muted">Files</summary>
        <ul className="m-0 mt-1 max-h-40 list-none overflow-auto p-0 font-mono text-xs">
          {preview.files.map((file) => (
            <li key={file.path}>{file.path}</li>
          ))}
        </ul>
      </details>
      {preview.excluded.length > 0 ? (
        <p className="m-0 text-xs text-muted">
          Not shared: {preview.excluded.map((entry) => entry.path).join(", ")}
        </p>
      ) : null}
      {preview.problems.length > 0 ? (
        <ul className="m-0 list-none p-0 text-xs text-bad">
          {preview.problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

/** Another person's unshared active work is shared only when explicitly included. */
function DependencyChoice({
  dependencies,
  included,
  onChange,
}: {
  dependencies: string[];
  included: ReadonlySet<string>;
  onChange: (update: (current: string[]) => string[]) => void;
}) {
  if (dependencies.length === 0) return null;
  return (
    <fieldset className="m-0 grid gap-1 border-0 p-0">
      <legend className="text-xs text-warn">
        It depends on unshared active changes. Include them, or share them first.
      </legend>
      {dependencies.map((dependency) => (
        <label key={dependency} className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={included.has(dependency)}
            onChange={(event) => {
              const checked = event.target.checked;
              onChange((current) =>
                checked ? [...current, dependency] : current.filter((name) => name !== dependency),
              );
            }}
          />
          <code className="font-mono">{dependency}</code>
        </label>
      ))}
    </fieldset>
  );
}

function ShareDialog({ companion, card }: { companion: string; card: StudioWorkCard }) {
  const preview = useWorkAction(companion);
  const { mutation, run, key, result } = useConfirm(companion);
  const [include, setInclude] = useState<string[]>([]);
  const { mutate } = preview;
  useEffect(() => {
    mutate({ action: "share-preview", workset: card.id, include });
  }, [mutate, card.id, include]);
  const shown: SharePreview | undefined = preview.data?.ok ? preview.data.preview : undefined;
  const blocked =
    !shown ||
    shown.problems.length > 0 ||
    shown.externalDependencies.length > 0 ||
    preview.isPending;
  const included = new Set(include);
  return (
    <Frame
      title={`Share ${card.title}`}
      description={`Pushes only these files to the team inbox ${shown?.target.branch ?? "mate/inbox"}, where teammates can claim it. Your checkout stays as it is. It starts no work, claims nothing, submits nothing and records no approval.`}
      footer={
        <Button
          variant="primary"
          disabled={blocked || mutation.isPending}
          onClick={() =>
            shown && run({ action: "share", workset: card.id, hash: shown.hash, include, key })
          }
        >
          Share
        </Button>
      }
    >
      {preview.isPending ? (
        <p className="m-0 text-sm text-muted">Reading what would be shared…</p>
      ) : null}
      <Refusal result={preview.data} />
      {shown ? (
        <div className="grid gap-3 text-sm">
          <PreviewSummary preview={shown} />
          <DependencyChoice
            dependencies={shown.externalDependencies}
            included={included}
            onChange={setInclude}
          />
        </div>
      ) : null}
      <Refusal result={result} />
    </Frame>
  );
}

function ClaimDialog({
  companion,
  card,
  kind,
  operator,
}: {
  companion: string;
  card: StudioWorkCard;
  kind: "claim" | "release";
  operator: StudioWorkPayload["operator"];
}) {
  const { mutation, run, key, result } = useConfirm(companion);
  const close = useWorkUi((state) => state.close);
  const [needsTake, setNeedsTake] = useState<string[]>([]);
  const copy = {
    claim: {
      title: `Claim ${card.title}`,
      description: `Adds owner.yaml naming ${operator?.label ?? "you"} to all ${card.memberNames.length} of its changes on the team inbox. A claim coordinates trusted teammates; it is not access control.`,
      button: "Claim",
    },
    release: {
      title: `Release ${card.title}`,
      description:
        "Removes its owner.yaml files, so anyone on the team may claim it. Its files and branches stay as they are.",
      button: "Release",
    },
  }[kind];
  return (
    <Frame
      title={copy.title}
      description={copy.description}
      footer={
        needsTake.length > 0 ? (
          <Button variant="primary" onClick={close}>
            Done
          </Button>
        ) : (
          <Button
            variant="primary"
            disabled={mutation.isPending}
            onClick={() =>
              run({ action: kind, workset: card.id, members: card.memberNames, key }, (ok) => {
                if (ok.ok && ok.needsTake?.length) setNeedsTake(ok.needsTake);
                else close();
              })
            }
          >
            {copy.button}
          </Button>
        )
      }
    >
      {needsTake.length > 0 ? (
        <div className="grid gap-2 text-sm" role="status">
          <p className="m-0">Claimed. Take its changes into this checkout before you start:</p>
          {needsTake.map((change) => (
            <CommandLine
              key={change}
              text={`mate artifact take ${change}`}
              label={`Take ${change}`}
            />
          ))}
        </div>
      ) : null}
      <Refusal result={result} />
    </Frame>
  );
}

function StartManualDialog({ companion, card }: { companion: string; card: StudioWorkCard }) {
  const [prompts, setPrompts] = useState<NonNullable<
    Extract<WorkResult, { ok: true }>["prompts"]
  > | null>(null);
  const { mutation, run, result } = useConfirm(companion);
  const close = useWorkUi((state) => state.close);
  return (
    <Frame
      title={`Continue ${card.title} manually`}
      description="Checks that it is yours to continue, then shows the prompts for your own agent session. Nothing is written."
      footer={
        prompts ? (
          <Button variant="primary" onClick={close}>
            Done
          </Button>
        ) : (
          <Button
            variant="primary"
            disabled={mutation.isPending}
            onClick={() =>
              run({ action: "start-manual", workset: card.id, members: card.memberNames }, (ok) =>
                setPrompts(ok.ok ? (ok.prompts ?? []) : []),
              )
            }
          >
            Continue
          </Button>
        )
      }
    >
      {prompts ? (
        <div className="grid gap-2">
          {prompts.flatMap((entry) =>
            Object.entries(entry).map(([agent, prompt]) => (
              <CommandLine
                key={`${agent}:${prompt}`}
                text={prompt ?? ""}
                label={`${agent} prompt`}
              />
            )),
          )}
          <p className="m-0 text-xs text-muted">
            A copied prompt runs wherever you paste it; Studio cannot see or fence that session.
          </p>
        </div>
      ) : null}
      <Refusal result={result} />
    </Frame>
  );
}

/** The open confirmation, for the Workset it names as the latest payload shows it. */
export function WorkDialogs({
  companion,
  payload,
  dialog,
}: DialogProps & { dialog: WorkDialog | null }) {
  if (!dialog) return null;
  const card = payload.cards.find((entry) => entry.id === dialog.workset);
  if (!card) return null;
  switch (dialog.kind) {
    case "share":
      return <ShareDialog key={card.id} companion={companion} card={card} />;
    case "claim":
    case "release":
      return (
        <ClaimDialog
          key={card.id}
          companion={companion}
          card={card}
          kind={dialog.kind}
          operator={payload.operator}
        />
      );
    case "start-manual":
      return <StartManualDialog key={card.id} companion={companion} card={card} />;
  }
}
