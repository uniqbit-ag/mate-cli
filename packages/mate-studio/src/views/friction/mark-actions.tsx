import {
  FRICTION_STATES,
  type FrictionItemState,
  type FrictionStateName,
  type FrictionStateOrigin,
  type MarkState,
} from "@uniqbit/mate-core/studio";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";

import { StatusWord, type Marker } from "../../components/view-parts";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/fields";

const STATE_WORDS: Record<FrictionStateName, { label: string; marker: Marker }> = {
  fixed: { label: "Fixed", marker: "done" },
  reported: { label: "Reported", marker: "review" },
  dismissed: { label: "Dismissed", marker: "idle" },
};

const BY: Record<FrictionStateOrigin, string> = {
  person: "by a person",
  triage: "by triage",
  studio: "in Studio",
};

export const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** The item's Friction State as one word with its marker; nothing for an unmarked item. */
export function StateWord({ state }: { state: FrictionItemState | null }) {
  if (!state) return null;
  const word = STATE_WORDS[state.state];
  return state.reopened ? (
    <StatusWord marker="warn">Reopened</StatusWord>
  ) : (
    <StatusWord marker={word.marker}>{word.label}</StatusWord>
  );
}

export function ItemState({ state, time }: { state: FrictionItemState; time: ReactNode }) {
  const word = STATE_WORDS[state.state];
  return (
    <p className="m-0 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-muted">
      <StateWord state={state} />
      <span>
        {state.reopened ? "Fixed, then recorded again; marked " : `${word.label} `}
        {BY[state.by]} {time}
      </span>
      {state.state === "reported" && state.eventsSince !== undefined ? (
        <span className="tabular-nums">{plural(state.eventsSince, "event")} since reported</span>
      ) : null}
      {state.link ? (
        <a href={state.link} target="_blank" rel="noreferrer" className="text-text underline">
          {state.link}
        </a>
      ) : null}
      {state.note ? <span className="text-text">{state.note}</span> : null}
    </p>
  );
}

const NOTE = { label: "Note (optional)", key: "note", type: "text" } as const;
const LINK = { label: "Issue link (optional)", key: "link", type: "url" } as const;
/** Each mark's action label and its optional field. */
const MARKS: Record<FrictionStateName, { action: string; field: typeof NOTE | typeof LINK }> = {
  fixed: { action: "Mark fixed", field: NOTE },
  reported: { action: "Mark reported", field: LINK },
  dismissed: { action: "Dismiss", field: NOTE },
};

/** Resolves to a refusal to show, or `null` once the mark is saved. */
export type MarkItem = (
  state: MarkState,
  input: { note?: string; link?: string },
) => Promise<string | null>;

/** Mark actions of one item; a handled item also offers Reopen. */
export function MarkActions({
  name,
  handled,
  onMark,
}: {
  name: string;
  handled: boolean;
  onMark: MarkItem;
}) {
  const [draft, setDraft] = useState<FrictionStateName | null>(null);
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const fieldId = useId();
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (draft) field.current?.focus();
  }, [draft]);

  const close = () => {
    setDraft(null);
    setText("");
    setRefusal(null);
  };

  async function submit(state: MarkState, input: { note?: string; link?: string } = {}) {
    setPending(true);
    setRefusal(null);
    const refused = await onMark(state, input);
    setPending(false);
    if (refused) setRefusal(refused);
    else close();
  }

  return (
    <div className="grid gap-1.5">
      {draft ? (
        <form
          aria-label={`${MARKS[draft].action}: ${name}`}
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void submit(draft, { [MARKS[draft].field.key]: text });
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") close();
          }}
        >
          <label htmlFor={fieldId} className="grid gap-1 text-xs text-muted">
            {MARKS[draft].field.label}
            <Input
              id={fieldId}
              ref={field}
              type={MARKS[draft].field.type}
              value={text}
              onChange={(event) => setText(event.target.value)}
              className="h-8 w-72 max-w-full"
            />
          </label>
          <Button size="sm" variant="primary" type="submit" disabled={pending}>
            {MARKS[draft].action}
          </Button>
          <Button size="sm" onClick={close} disabled={pending}>
            Cancel
          </Button>
        </form>
      ) : (
        <div role="group" aria-label={`Mark ${name}`} className="flex flex-wrap gap-2">
          {FRICTION_STATES.map((state) => (
            <Button key={state} size="sm" disabled={pending} onClick={() => setDraft(state)}>
              {MARKS[state].action}
            </Button>
          ))}
          {handled ? (
            <Button size="sm" disabled={pending} onClick={() => void submit("open")}>
              Reopen
            </Button>
          ) : null}
        </div>
      )}
      {refusal ? (
        <p className="m-0 max-w-[70ch] text-xs text-bad" role="alert">
          {refusal}
        </p>
      ) : null}
    </div>
  );
}
