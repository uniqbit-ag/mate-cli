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
    <section className="panel skills-panel">
      <div className="section-header">
        <div>
          <h3>Agent Skills</h3>
          <p className="section-note">Every skill installed in this Companion Repository.</p>
        </div>
        <span className="section-count">
          {total} {total === 1 ? "skill" : "skills"}
        </span>
      </div>
      <div className="skills-tabs" data-skills-root>
        <div className="skills-tab-list" role="tablist" aria-label="Skill source">
          {PROFILES.map((profile, index) => {
            const active = index === 0;
            const names = inventory[profile.id];
            return (
              <button
                key={profile.id}
                type="button"
                role="tab"
                id={`skills-tab-${profile.id}`}
                aria-selected={active}
                aria-controls={`skills-panel-${profile.id}`}
                data-skill-profile={profile.id}
              >
                <strong>{profile.label}</strong>
                <span>{names.length} skills</span>
              </button>
            );
          })}
        </div>
        <div className="skills-panels">
          {PROFILES.map((profile, index) => {
            const active = index === 0;
            const names = inventory[profile.id];
            return (
              <div
                key={profile.id}
                id={`skills-panel-${profile.id}`}
                role="tabpanel"
                aria-labelledby={`skills-tab-${profile.id}`}
                aria-hidden={!active}
                data-skill-panel={profile.id}
                data-active={active}
                tabIndex={0}
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
      </div>
    </section>
  );
}
