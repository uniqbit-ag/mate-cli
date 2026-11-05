import { useState } from "react";
import type { StudioSkillInventory } from "@uniqbit/mate-core/studio";

import {
  CommandLine,
  EmptyNote,
  ListCard,
  PAGE_PAD,
  Pills,
  ROW,
} from "../../components/view-parts";
import { cn } from "../../lib/cn";
import { PanelHead, PanelSection, SidePanel } from "../../shell/panel";
import { workflowPlan } from "../workflow/steps";
import { SkillFiles } from "./skill-files";

type Agent = keyof StudioSkillInventory;

const AGENTS: { id: Agent; label: string; dir: string; invoke: (name: string) => string }[] = [
  { id: "claude", label: "Claude", dir: ".claude/skills", invoke: (name) => `/${name}` },
  { id: "opencode", label: "OpenCode", dir: ".opencode/skills", invoke: (name) => `@${name}` },
  { id: "agents", label: "Agents", dir: ".agents/skills", invoke: (name) => `$${name}` },
];

/** Skills only other skills load; they offer no start command of their own. */
const LOADED_BY_OTHERS: ReadonlySet<string> = new Set(["mate-grilling", "mate-domain-modeling"]);

/** Each Delivery Path skill and the stage it runs at, in path order. */
function stageSkills(): Map<string, string> {
  const stages = new Map<string, string>();
  for (const step of workflowPlan({}).paths[0]?.steps ?? []) {
    if (step.skill && !stages.has(step.skill)) stages.set(step.skill, step.label);
    for (const alternative of step.alternatives ?? []) {
      if (!stages.has(alternative.name)) stages.set(alternative.name, step.label);
    }
  }
  return stages;
}

interface SkillGroup {
  title: string;
  hint: string;
  names: string[];
}

function groupSkills(names: string[], stages: Map<string, string>): SkillGroup[] {
  const order = [...stages.keys()];
  const path = names
    .filter((name) => stages.has(name))
    .toSorted((a, b) => order.indexOf(a) - order.indexOf(b));
  const loaded = names.filter((name) => LOADED_BY_OTHERS.has(name));
  const mate = names.filter(
    (name) => name.startsWith("mate-") && !stages.has(name) && !LOADED_BY_OTHERS.has(name),
  );
  const other = names.filter((name) => !name.startsWith("mate-") && !stages.has(name));
  return [
    { title: "Delivery Path", hint: "In the order a change meets them", names: path },
    { title: "Other Mate skills", hint: "Run when you need them", names: mate },
    {
      title: "Used by other skills",
      hint: "Loaded for you, not started on their own",
      names: loaded,
    },
    { title: "Other skills", hint: "Installed besides Mate", names: other },
  ].filter((group) => group.names.length > 0);
}

interface SkillsProps {
  skills?: StudioSkillInventory;
  /** Lets the panel read the skill's files; absent, only its detail shows. */
  companion?: string;
}

/** One agent's skills at a time, grouped by purpose; a skill's detail opens in the panel. */
export function Skills({ skills, companion }: SkillsProps) {
  const inventory = skills ?? { claude: [], opencode: [], agents: [] };
  const [shown, setShown] = useState<Agent>("claude");
  const [open, setOpen] = useState<string | null>(null);
  const stages = stageSkills();
  const agent = AGENTS.find((entry) => entry.id === shown)!;

  return (
    <section
      className={cn(PAGE_PAD, "grid content-start gap-3 pb-10")}
      aria-label="Agent skills"
      data-skills-root
    >
      <Pills
        label="Agent"
        value={shown}
        onChange={(next) => {
          setShown(next);
          setOpen(null);
        }}
        options={AGENTS.map((entry) => ({
          value: entry.id,
          label: entry.label,
          count: inventory[entry.id].length,
        }))}
      />
      {AGENTS.map((entry) => {
        const active = entry.id === shown;
        const names = inventory[entry.id];
        return (
          <div
            key={entry.id}
            id={`skills-panel-${entry.id}`}
            className={active ? "grid gap-3" : "hidden"}
            aria-hidden={!active}
            data-skill-panel={entry.id}
            data-active={active}
          >
            {names.length === 0 ? (
              <EmptyNote>{entry.label} has no skills in this companion.</EmptyNote>
            ) : (
              groupSkills(names, stages).map((group) => (
                <ListCard
                  key={group.title}
                  title={group.title}
                  count={group.names.length}
                  hint={group.hint}
                >
                  <ul className="m-0 list-none p-0">
                    {group.names.map((name) => (
                      <li key={name}>
                        <button
                          type="button"
                          className={cn(ROW, "grid grid-cols-[minmax(0,1fr)_auto] py-1.5")}
                          aria-current={active && open === name ? "true" : undefined}
                          data-skill={name}
                          onClick={() => setOpen(name)}
                        >
                          <span className="truncate font-mono text-sm">{name}</span>
                          {stages.has(name) ? (
                            <span className="text-xs text-muted">{stages.get(name)}</span>
                          ) : null}
                        </button>
                      </li>
                    ))}
                  </ul>
                </ListCard>
              ))
            )}
          </div>
        );
      })}
      <SidePanel
        items={groupSkills(inventory[shown], stages).flatMap((group) => group.names)}
        current={open}
        onSelect={setOpen}
        wide={companion !== undefined}
        title={open ? `Skill ${open}` : "Skill"}
      >
        {open ? (
          <>
            <PanelHead
              mono
              title={open}
              kicker={
                stages.has(open) ? (
                  <span>Delivery Path · {stages.get(open)}</span>
                ) : (
                  <span>{agent.label}</span>
                )
              }
            />
            <PanelSection title="Start">
              {LOADED_BY_OTHERS.has(open) ? (
                <p className="m-0 text-sm">
                  Used by other skills: they load it when they need it, so it has no start command.
                </p>
              ) : (
                <CommandLine text={agent.invoke(open)} label="start command" />
              )}
            </PanelSection>
            <PanelSection title="Installed for">
              <ul className="m-0 grid list-none gap-1.5 p-0">
                {AGENTS.filter((entry) => inventory[entry.id].includes(open)).map((entry) => (
                  <li key={entry.id} className="flex items-center gap-3 text-sm">
                    <span className="w-20 text-muted">{entry.label}</span>
                    <code className="truncate font-mono text-xs">
                      {entry.dir}/{open}/
                    </code>
                  </li>
                ))}
              </ul>
            </PanelSection>
            {companion ? (
              <SkillFiles
                key={`${shown}/${open}`}
                companion={companion}
                agent={shown}
                name={open}
              />
            ) : null}
          </>
        ) : null}
      </SidePanel>
    </section>
  );
}
