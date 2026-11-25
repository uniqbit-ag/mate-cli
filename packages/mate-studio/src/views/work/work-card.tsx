import { useDraggable } from "@dnd-kit/core";
import type {
  StudioWorkCard,
  WorkActionId,
  WorkBucket,
  WorksetStageId,
} from "@uniqbit/mate-core/studio";

import { Icon } from "../../components/icon";
import { type Marker, ROW, StatusWord } from "../../components/view-parts";
import { cn } from "../../lib/cn";
import { useWorkUi, type WorkDialog } from "../../stores/work-ui";
import { acceptedActions, ACTION_LABELS, type DropAction, dropTargetsOf } from "./work-card-model";

const STAGE_MARKERS: Record<WorksetStageId, Marker> = {
  "clarify-intent": "idle",
  explore: "idle",
  propose: "idle",
  "human-review": "review",
  apply: "build",
  "merge-wait": "review",
  publish: "review",
  done: "done",
};

const PRIMARY: ReadonlySet<WorkActionId> = new Set(["claim", "start-manual"]);

function claimText(card: StudioWorkCard): string | null {
  switch (card.claim.kind) {
    case "mine":
      return `Claimed by you (${card.claim.label})`;
    case "other":
      return `Claimed by ${card.claim.label}`;
    case "none":
      return card.bucket === "remote" && card.progress.kind === "none" ? "Available" : null;
    case "conflict":
      return null;
  }
}

function progressText(card: StudioWorkCard): string | null {
  if (card.progress.kind === "here") return `In progress here on ${card.progress.branch}`;
  if (card.progress.kind === "elsewhere") return `In progress on ${card.progress.branch}`;
  return null;
}

const SYNC_NOTES: Record<string, string> = {
  ahead: "Local changes not shared",
  behind: "The shared version is newer; take it with mate artifact take",
  diverged: "Local and shared versions differ",
};

function sharingNotes(card: StudioWorkCard): string[] {
  const { sharing } = card;
  const shared = sharing.presence === "shared" || sharing.presence === "partial";
  // A partly shared group is named among the card's problems.
  const notes: string[] = [];
  if (shared && SYNC_NOTES[sharing.sync]) notes.push(SYNC_NOTES[sharing.sync]!);
  if (sharing.remoteOnly) notes.push("Only on the inbox; take it with mate artifact take");
  if (sharing.stale && shared) notes.push("Shared information may be stale");
  return notes;
}

function dialogFor(action: WorkActionId, workset: string): WorkDialog {
  return { kind: action, workset };
}

const QUIET_BUTTON =
  "inline-flex h-7 items-center gap-1.5 rounded-control border border-rule bg-surface px-2.5 text-xs hover:border-accent hover:bg-accent-soft";

/** Who claimed it, where it is built, and the member toggle. */
function CardFacts({ card }: { card: StudioWorkCard }) {
  const expanded = useWorkUi((state) => state.expanded[card.id] === true);
  const toggle = useWorkUi((state) => state.toggle);
  const claim = claimText(card);
  const progress = progressText(card);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
      {claim ? (
        <span className={cn(card.claim.kind === "mine" && "text-text")}>{claim}</span>
      ) : null}
      {progress ? <span>{progress}</span> : null}
      {card.memberNames.length > 1 ? (
        <button
          type="button"
          className="inline-flex items-center gap-1 text-xs text-muted hover:text-text"
          aria-expanded={expanded}
          aria-controls={`members-${card.id}`}
          onClick={() => toggle(card.id)}
        >
          <Icon name={expanded ? "chevron" : "right"} className="size-3.5" />
          {card.memberNames.length} changes
        </button>
      ) : null}
    </div>
  );
}

function TextList({
  items,
  className,
  label,
}: {
  items: string[];
  className: string;
  label?: string;
}) {
  if (items.length === 0) return null;
  return (
    <ul className={cn("m-0 list-none p-0 text-xs", className)} aria-label={label}>
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

/** Installed prompts: Run in Studio's terminal (guarded) and Copy (unguarded). */
function CardOffers({ card, writable }: { card: StudioWorkCard; writable: boolean }) {
  return card.offers.map((offer) => (
    <span key={`${offer.action}:${offer.subject}`} className="inline-flex gap-1.5">
      {writable && offer.runAgents.length > 0 ? (
        <button
          type="button"
          className={cn(QUIET_BUTTON, "work-action")}
          data-studio-action={offer.action}
          data-studio-subject={offer.subject}
          data-studio-agents={offer.runAgents.join(" ")}
          aria-label={`${offer.label} ${offer.subject} in the terminal`}
        >
          <Icon name="play" className="size-3.5" />
          {offer.label}
        </button>
      ) : null}
      <button
        type="button"
        className={cn(QUIET_BUTTON, "work-copy")}
        data-studio-copy-prompt={offer.action}
        data-prompt-claude={offer.prompts.claude}
        data-prompt-opencode={offer.prompts.opencode}
        aria-label={`Copy the ${offer.label.toLowerCase()} prompt for ${offer.subject}`}
      >
        <Icon name="copy" className="size-3.5" />
        {offer.label} prompt
      </button>
    </span>
  ));
}

function CardActions({ card, actions }: { card: StudioWorkCard; actions: WorkActionId[] }) {
  const open = useWorkUi((state) => state.open);
  return actions.map((action) => (
    <button
      key={action}
      type="button"
      className={cn(
        "work-action inline-flex h-7 items-center rounded-control border px-2.5 text-xs",
        PRIMARY.has(action)
          ? "border-accent bg-accent-soft font-semibold hover:bg-accent hover:text-on-accent"
          : "border-rule bg-surface hover:border-accent hover:bg-accent-soft",
      )}
      data-work-action={action}
      onClick={() => open(dialogFor(action, card.id))}
    >
      {ACTION_LABELS[action]}
    </button>
  ));
}

function CardMembers({ card }: { card: StudioWorkCard }) {
  const expanded = useWorkUi((state) => state.expanded[card.id] === true);
  if (!expanded || card.memberNames.length < 2) return null;
  return (
    <ul
      id={`members-${card.id}`}
      className="m-0 grid list-none gap-1 pr-3 pb-2.5 pl-10"
      aria-label="Changes"
    >
      {card.members.map((member) => (
        <li key={member.name} className="flex flex-wrap items-center gap-3 text-xs">
          <code className="font-mono">{member.name}</code>
          {card.sharing.remoteOnly ? null : (
            <StatusWord marker={member.problem ? "issue" : STAGE_MARKERS[member.stage]}>
              {member.delivered ? "Delivered" : member.stageLabel}
            </StatusWord>
          )}
          {member.problem ? <span className="text-bad">{member.problem}</span> : null}
        </li>
      ))}
    </ul>
  );
}

/** What a dragged card carries: enough for the overlay and for the lanes that accept it. */
export interface WorkDragData {
  title: string;
  targets: Partial<Record<WorkBucket, DropAction>>;
}

/** The card's title, id and state; shared with the drag overlay so the two never drift. */
export function CardHeading({ card }: { card: StudioWorkCard }) {
  return (
    <div className="grid min-w-0 flex-1 gap-1">
      <span className="line-clamp-2 font-medium [overflow-wrap:anywhere]">{card.title}</span>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        {/* Stages are read from the checkout's files; a change only on the inbox has none. */}
        {card.sharing.remoteOnly && card.diagnostics.length === 0 ? null : (
          <StatusWord marker={card.diagnostics.length > 0 ? "issue" : STAGE_MARKERS[card.stage]}>
            {card.done ? "Done" : card.stageLabel}
          </StatusWord>
        )}
        {/* A change's card is titled by its id; name the id only when the title differs. */}
        {card.title === card.id ? null : (
          <code className="min-w-0 truncate font-mono text-xs text-muted">{card.id}</code>
        )}
      </div>
    </div>
  );
}

/** One Workset in its lane: state, ownership and actions; members expand below. */
export function WorkCard({ card, writable }: { card: StudioWorkCard; writable: boolean }) {
  const actions = writable ? acceptedActions(card) : [];
  const targets = writable ? dropTargetsOf(card) : {};
  const draggable = Object.keys(targets).length > 0;
  const data: WorkDragData = { title: card.title, targets };
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, isDragging } = useDraggable({
    id: card.id,
    data,
    disabled: !draggable,
  });
  return (
    <li
      ref={setNodeRef}
      className={cn(
        "work-card border-t border-rule-soft transition-opacity first:border-t-0",
        isDragging && "opacity-40",
      )}
      data-workset={card.id}
    >
      <div
        className={cn(ROW, "items-start gap-2 border-t-0 py-2.5 pr-3 pl-2 hover:bg-transparent")}
      >
        {draggable ? (
          <button
            ref={setActivatorNodeRef}
            type="button"
            className="work-drag -my-0.5 grid size-6 flex-none cursor-grab touch-none place-items-center rounded-control text-muted hover:bg-surface hover:text-text active:cursor-grabbing"
            data-work-drag={card.id}
            {...attributes}
            {...listeners}
            aria-label={`Move ${card.title}`}
          >
            <Icon name="grip" className="size-4 [stroke-width:2.6]" />
          </button>
        ) : (
          <span className="size-6 flex-none" aria-hidden="true" />
        )}
        <div className="grid min-w-0 flex-1 gap-1.5">
          <CardHeading card={card} />
          <CardFacts card={card} />
          <TextList items={sharingNotes(card)} className="grid gap-0.5 text-muted" />
          <TextList items={card.diagnostics} className="grid gap-0.5 text-bad" label="Problems" />
          {actions.length > 0 || card.offers.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
              <CardActions card={card} actions={actions} />
              <CardOffers card={card} writable={writable} />
            </div>
          ) : null}
        </div>
      </div>
      <CardMembers card={card} />
    </li>
  );
}
