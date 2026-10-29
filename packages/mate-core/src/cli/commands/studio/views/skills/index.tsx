/** @jsxImportSource hono/jsx */

import type { StudioSkillInventory } from "../../mate-inventory";

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

  return (
    <section className="view-section" aria-label="Agent skills" data-skills-root>
      <div className="view-intro">
        <label className="view-choice">
          <span>Agent</span>
          <select data-skills-select>
            {PROFILES.map((profile, index) => (
              <option key={profile.id} value={profile.id} selected={index === 0}>
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
        {PROFILES.map((profile, index) => {
          const active = index === 0;
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
