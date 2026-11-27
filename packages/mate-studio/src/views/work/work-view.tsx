import {
  type Active,
  type ClientRect,
  type CollisionDetection,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type KeyboardCoordinateGetter,
  KeyboardSensor,
  type Over,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useDndContext,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { useNavigate } from "@tanstack/react-router";
import {
  type StudioWorkCard,
  type StudioWorkPayload,
  WORK_BUCKETS,
  type WorkBucket,
} from "@uniqbit/mate-core/studio";
import { type FormEvent, type ReactNode, useState } from "react";

import { Icon } from "../../components/icon";
import { Button } from "../../components/ui/button";
import { Input, Textarea } from "../../components/ui/fields";
import { Age, Count, EmptyNote, PAGE_PAD } from "../../components/view-parts";
import { cn } from "../../lib/cn";
import { useWorkUi } from "../../stores/work-ui";
import { CardHeading, WorkCard, type WorkDragData } from "./work-card";
import { DROP_VERBS } from "./work-card-model";
import { WorkDialogs } from "./work-dialogs";
import type { WorkSearch } from "./work-search";
import { useWorkAction } from "./use-work-action";

const BUCKET_LABELS: Record<WorkBucket, string> = {
  scratchpad: "Scratchpad",
  local: "Local work",
  remote: "Remote work",
};

const BUCKET_HINTS: Record<WorkBucket, string> = {
  scratchpad: "Ideas on this checkout only. Nothing here runs or is pushed.",
  local: "Your changes: not shared yet, claimed by you, or built here.",
  remote: "Shared changes: available to claim, claimed by others, or built elsewhere.",
};

const EMPTY: Record<WorkBucket, string> = {
  scratchpad: "No saved ideas.",
  local: "No local work. Propose a change to see it here.",
  remote: "Nothing shared. Refresh to look at the team branch.",
};

/** Remote work is empty while shared work sits in Local work: yours, claimed or built here. */
const REMOTE_EMPTY_WITH_SHARED = "No shared work to claim.";

/** A drop's bucket and action, when the card under drag accepts the bucket it is over. */
function dropOf(active: Active, over: Over | null) {
  const bucket = (over?.data.current as { bucket?: WorkBucket } | undefined)?.bucket;
  const action = bucket ? dragData(active)?.targets[bucket] : undefined;
  return bucket && action ? { bucket, action } : null;
}

const dragData = (active: Active | null) => active?.data.current as WorkDragData | undefined;

const titleOf = (active: Active) => dragData(active)?.title ?? String(active.id);

const KEY_STEPS: Record<string, 1 | -1> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
};

/** Arrow keys jump the dragged card to the nearest bucket that accepts it, left or right. */
const bucketKeys: KeyboardCoordinateGetter = (event, { currentCoordinates, context }) => {
  const step = KEY_STEPS[event.code];
  const from = context.collisionRect;
  if (!step || !from) return undefined;
  event.preventDefault();
  const here = { x: from.left + from.width / 2, y: from.top + from.height / 2 };
  // Hidden lanes and tabs measure zero wide.
  const target = context.droppableContainers
    .getEnabled()
    .flatMap((container) => {
      const rect = context.droppableRects.get(container.id);
      const ahead = rect && Math.sign(rect.left + rect.width / 2 - here.x) === step;
      return rect && rect.width > 0 && ahead ? [rect] : [];
    })
    .reduce<ClientRect | undefined>(
      (nearest, rect) => (!nearest || step * (rect.left - nearest.left) < 0 ? rect : nearest),
      undefined,
    );
  if (!target) return undefined;
  const y = Math.min(
    Math.max(here.y, target.top + from.height / 2),
    target.bottom - from.height / 2,
  );
  return {
    x: currentCoordinates.x + target.left + target.width / 2 - here.x,
    y:
      currentCoordinates.y +
      (target.height > from.height ? y : target.top + target.height / 2) -
      here.y,
  };
};

// The pointer decides when it is over a bucket; a keyboard drag has no pointer, so its rectangle does.
const collisions: CollisionDetection = (args) => {
  const within = pointerWithin(args);
  return within.length > 0 ? within : rectIntersection(args);
};

/** Work: every Workset once, in the bucket its facts place it; cards move by drag and drop. */
export function Work({ payload, search }: { payload: StudioWorkPayload; search: WorkSearch }) {
  const companion = search.companion!;
  const navigate = useNavigate();
  const bucket = search.bucket ?? "scratchpad";
  const dialog = useWorkUi((state) => state.dialog);
  const openDialog = useWorkUi((state) => state.open);
  const [moving, setMoving] = useState<StudioWorkCard | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: bucketKeys }),
  );
  const byBucket = (name: WorkBucket) => payload.cards.filter((card) => card.bucket === name);
  const anyShared = payload.cards.some(
    (card) => card.sharing.presence === "shared" || card.sharing.presence === "partial",
  );
  const select = (next: WorkBucket) =>
    void navigate({
      to: "/work",
      search: (previous) => ({
        companion: previous.companion,
        studioMode: previous.studioMode,
        ...(next === "scratchpad" ? {} : { bucket: next }),
      }),
      resetScroll: false,
    });
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    setMoving(null);
    const drop = dropOf(active, over);
    // A drop opens the same confirmation as the button; it never acts by itself.
    if (drop) openDialog({ kind: drop.action, workset: String(active.id) });
  };
  return (
    <section
      className={cn(PAGE_PAD, "view-section work @container grid content-start gap-4 pb-10")}
      aria-label="Work"
    >
      <DndContext
        id="work-dnd"
        sensors={sensors}
        collisionDetection={collisions}
        onDragStart={({ active }) =>
          setMoving(payload.cards.find((card) => card.id === active.id) ?? null)
        }
        onDragEnd={onDragEnd}
        onDragCancel={() => setMoving(null)}
        accessibility={{
          screenReaderInstructions: {
            draggable:
              "To move a Workset, press Space or Enter, choose a bucket with the arrow keys, then press Space or Enter to drop it, or Escape to cancel. A drop asks for confirmation.",
          },
          announcements: {
            onDragStart: ({ active }) => `Picked up ${titleOf(active)}.`,
            onDragOver: ({ active, over }) => {
              const drop = dropOf(active, over);
              return drop
                ? `Over ${BUCKET_LABELS[drop.bucket]}: drop to ${DROP_VERBS[drop.action]}.`
                : `${titleOf(active)} is not over a bucket that takes it.`;
            },
            onDragEnd: ({ active, over }) => {
              const drop = dropOf(active, over);
              return drop
                ? `Dropped on ${BUCKET_LABELS[drop.bucket]}. Confirm to ${DROP_VERBS[drop.action]}.`
                : `${titleOf(active)} stays where it was.`;
            },
            onDragCancel: ({ active }) => `Moving ${titleOf(active)} was cancelled.`,
          },
        }}
      >
        <div className="flex flex-wrap items-center gap-3">
          {/* Below the lanes' width one bucket shows at a time; its tab still takes a drop. */}
          <div
            role="tablist"
            aria-label="Work buckets"
            className="flex flex-wrap gap-1.5 @min-[56rem]:hidden"
          >
            {WORK_BUCKETS.map((name) => (
              <BucketTab
                key={name}
                bucket={name}
                cards={byBucket(name)}
                selected={bucket === name}
                onSelect={() => select(name)}
              />
            ))}
          </div>
          <TeamStatus payload={payload} companion={companion} />
        </div>
        <div className="grid items-start gap-4 @min-[56rem]:grid-cols-3">
          {WORK_BUCKETS.map((name) => (
            <Lane
              key={name}
              bucket={name}
              cards={byBucket(name)}
              empty={name === "remote" && anyShared ? REMOTE_EMPTY_WITH_SHARED : EMPTY[name]}
              selected={bucket === name}
              writable={payload.writable}
            >
              {name === "scratchpad" ? <Capture payload={payload} companion={companion} /> : null}
            </Lane>
          ))}
        </div>
        <DragOverlay dropAnimation={null}>
          {moving ? (
            <div className="flex w-[min(340px,80vw)] cursor-grabbing items-start gap-2 rounded-card border border-accent bg-surface py-2.5 pr-3 pl-2 text-base text-text shadow-float">
              <span className="grid size-6 flex-none place-items-center text-accent">
                <Icon name="grip" className="size-4 [stroke-width:2.6]" />
              </span>
              <CardHeading card={moving} />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
      {payload.diagnostics.length > 0 ? (
        <ul
          className="m-0 list-none p-0 text-xs text-warn"
          aria-label="Workset records that cannot be read"
        >
          {payload.diagnostics.map((diagnostic) => (
            <li key={diagnostic}>{diagnostic}</li>
          ))}
        </ul>
      ) : null}
      {payload.writable ? (
        <WorkDialogs companion={companion} payload={payload} dialog={dialog} />
      ) : null}
    </section>
  );
}

/** The action the card under drag would ask for here, and whether it is over this target. */
function useDropTarget(id: string, bucket: WorkBucket) {
  const { active } = useDndContext();
  const action = dragData(active)?.targets[bucket];
  const { setNodeRef, isOver } = useDroppable({ id, data: { bucket }, disabled: !action });
  return { setNodeRef, action, over: isOver && action !== undefined };
}

function BucketTab({
  bucket,
  cards,
  selected,
  onSelect,
}: {
  bucket: WorkBucket;
  cards: StudioWorkCard[];
  selected: boolean;
  onSelect: () => void;
}) {
  const { setNodeRef, action, over } = useDropTarget(`tab:${bucket}`, bucket);
  const needs = cards.filter((card) => card.needsYou).length;
  return (
    <button
      ref={setNodeRef}
      type="button"
      role="tab"
      id={`work-tab-${bucket}`}
      aria-selected={selected}
      aria-controls={`work-lane-${bucket}`}
      data-work-bucket={bucket}
      className={cn(
        "inline-flex h-8 items-center gap-2 rounded-control border px-3 text-sm transition-colors",
        selected ? "border-accent bg-accent-soft font-semibold" : "border-rule bg-surface",
        action && "outline-1 outline-offset-2 outline-accent outline-dashed",
        over && "border-accent bg-accent-soft outline-2 outline-solid",
      )}
      onClick={onSelect}
    >
      {BUCKET_LABELS[bucket]}
      <Count value={needs > 0 ? needs : cards.length} tone={needs > 0 ? "warn" : undefined} />
    </button>
  );
}

/** One bucket as a lane: its heading, what it holds, and the drop it offers while a card moves. */
function Lane({
  bucket,
  cards,
  empty,
  selected,
  writable,
  children,
}: {
  bucket: WorkBucket;
  cards: StudioWorkCard[];
  empty: string;
  selected: boolean;
  writable: boolean;
  children?: ReactNode;
}) {
  const { setNodeRef, action, over } = useDropTarget(`lane:${bucket}`, bucket);
  const needs = cards.filter((card) => card.needsYou).length;
  return (
    <section
      ref={setNodeRef}
      id={`work-lane-${bucket}`}
      aria-labelledby={`work-lane-${bucket}-title`}
      data-work-lane={bucket}
      className={cn(
        "work-lane grid min-w-0 content-start gap-3 rounded-panel p-2 transition-[background-color,outline-color] duration-150",
        !selected && "@max-[56rem]:hidden",
        action && "outline-1 -outline-offset-1 outline-accent outline-dashed",
        over && "bg-accent-soft outline-2 outline-solid",
      )}
    >
      <header className="grid gap-0.5 px-1 pt-0.5">
        {/* One lane at a time below the lanes' width: its tab already names it. */}
        <div className="flex items-center gap-2 @max-[56rem]:sr-only">
          <h2 id={`work-lane-${bucket}-title`} className="m-0 text-[0.9rem] font-semibold">
            {BUCKET_LABELS[bucket]}
          </h2>
          <Count value={cards.length} />
          {needs > 0 ? <Count value={needs} tone="warn" label={`${needs} need you`} /> : null}
          {action ? (
            <span className="ml-auto text-xs font-medium text-accent" aria-hidden="true">
              Drop to {DROP_VERBS[action]}
            </span>
          ) : null}
        </div>
        {/* Two lines reserved side by side, so the lanes' lists start level. */}
        <p className="m-0 text-xs text-muted @min-[56rem]:min-h-[2lh]">{BUCKET_HINTS[bucket]}</p>
      </header>
      {children}
      {cards.length === 0 ? (
        <EmptyNote className="px-4 py-4 text-sm">{empty}</EmptyNote>
      ) : (
        <ul
          className="m-0 list-none overflow-hidden rounded-card border border-rule bg-page p-0"
          aria-label={BUCKET_LABELS[bucket]}
        >
          {cards.map((card) => (
            <WorkCard key={card.id} card={card} writable={writable} />
          ))}
        </ul>
      )}
    </section>
  );
}

function TeamStatus({ payload, companion }: { payload: StudioWorkPayload; companion: string }) {
  const refresh = useWorkAction(companion);
  const { team } = payload;
  if (!payload.gitBacked) {
    return (
      <span className="text-xs text-muted">Local only: the companion is not a Git repository.</span>
    );
  }
  return (
    <div className="ml-auto flex flex-wrap items-center gap-2 text-xs text-muted">
      {team.remote && team.branch ? (
        <span>
          Shared on <code className="font-mono">{`${team.remote}/${team.branch}`}</code>
        </span>
      ) : null}
      {team.fetchedAt ? <Age at={team.fetchedAt} /> : <span>never refreshed</span>}
      {team.failure ? (
        <span className="text-warn" role="status">
          Stale: {team.failure}
        </span>
      ) : null}
      <Button
        size="sm"
        disabled={refresh.isPending}
        onClick={() => refresh.mutate({ action: "refresh" })}
        aria-label="Refresh shared work"
      >
        <Icon name="refresh" className="size-3.5" />
        Refresh
      </Button>
    </div>
  );
}

/** Scratchpad's one capture form: Save keeps the idea. */
function Capture({ payload, companion }: { payload: StudioWorkPayload; companion: string }) {
  const draft = useWorkUi((state) => state.drafts[companion] ?? "");
  const setDraft = useWorkUi((state) => state.setDraft);
  const [repository, setRepository] = useState(payload.linkedRepositories[0] ?? "");
  const [ticket, setTicket] = useState("");
  const save = useWorkAction(companion);
  if (!payload.writable) return null;
  const fields = {
    ...(payload.linkedRepositories.length > 1 ? { repository } : {}),
    ...(ticket.trim() ? { ticket: ticket.trim() } : {}),
  };
  const clear = () => {
    setDraft(companion, "");
    setTicket("");
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!draft.trim()) return;
    save.mutate(
      { action: "capture", text: draft, ...fields },
      {
        onSuccess: (result) => {
          if (result.ok) clear();
        },
      },
    );
  };
  const result = save.data;
  return (
    <form
      className="work-capture grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2"
      onSubmit={submit}
      aria-label="Capture an idea"
    >
      <label htmlFor="work-capture-text" className="text-sm font-medium">
        What should we build or improve?
      </label>
      <Textarea
        id="work-capture-text"
        value={draft}
        onChange={(event) => setDraft(companion, event.target.value)}
        placeholder="Describe the outcome in plain words."
      />
      <div className="flex flex-wrap items-center gap-2">
        {payload.linkedRepositories.length > 1 ? (
          <label className="flex min-w-0 max-w-full items-center gap-2 text-xs text-muted">
            Repository
            {/* A long repository name must not widen the page on a narrow screen. */}
            <select
              className="h-8 min-w-0 max-w-full truncate rounded-control border border-rule bg-page px-2 text-sm text-text"
              value={repository}
              onChange={(event) => setRepository(event.target.value)}
            >
              {payload.linkedRepositories.map((entry) => (
                <option key={entry} value={entry}>
                  {entry}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {payload.ticketFormat === "jira" ? (
          <label className="flex items-center gap-2 text-xs text-muted">
            Ticket
            <Input
              className="h-8 w-32"
              value={ticket}
              onChange={(event) => setTicket(event.target.value)}
              placeholder="ABC-123"
            />
          </label>
        ) : null}
        <div className="ml-auto flex gap-2">
          <Button type="submit" disabled={!draft.trim() || save.isPending}>
            Save
          </Button>
        </div>
      </div>
      {result && !result.ok ? (
        <p className="m-0 text-sm text-bad" role="alert">
          {result.reason}
        </p>
      ) : null}
    </form>
  );
}
