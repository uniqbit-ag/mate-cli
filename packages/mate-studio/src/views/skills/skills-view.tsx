import { useState } from "react";
import type { StudioSkillInventory } from "@uniqbit/mate-core/studio";

const PROFILES = [
  { id: "claude", label: "Claude", description: "Skills available to Claude agents." },
  { id: "opencode", label: "OpenCode", description: "Skills available to OpenCode." },
  { id: "agents", label: "Agents", description: "Shared skills available to all agents." },
] as const;

interface SkillsProps {
  skills?: StudioSkillInventory;
}

/** Lists the skills from each runtime tree without merging away runtime-specific entries. */
export function Skills({ skills }: SkillsProps) {
  const inventory = skills ?? { claude: [], opencode: [], agents: [] };
  const total = inventory.claude.length + inventory.opencode.length + inventory.agents.length;
  const [shown, setShown] = useState<string>(PROFILES[0].id);

  return (
    <section className="view-section" aria-label="Agent skills" data-skills-root>
      <div className="view-intro">
        <label className="view-choice">
          <span>Agent</span>
          <select
            data-skills-select
            value={shown}
            onChange={(event) => setShown(event.target.value)}
          >
            {PROFILES.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.label} – {inventory[profile.id].length} skills
              </option>
            ))}
          </select>
        </label>
        <p className="view-summary">
          {total} {total === 1 ? "skill" : "skills"} · installed in this Companion Repository
        </p>
      </div>
      <div className="skills-panels">
        {PROFILES.map((profile) => {
          const active = profile.id === shown;
          const names = inventory[profile.id];
          return (
            <div
              key={profile.id}
              id={`skills-panel-${profile.id}`}
              aria-hidden={!active}
              data-skill-panel={profile.id}
              data-active={active}
            >
              <p className="skills-panel-description">{profile.description}</p>
              {names.length === 0 ? (
                <p className="empty">No {profile.label} skills in this companion.</p>
              ) : (
                <div className="skills-grid">
                  {names.map((name) => (
                    <div key={name} className="skill-card">
                      <code>{name}</code>
                      <span>/{name}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
