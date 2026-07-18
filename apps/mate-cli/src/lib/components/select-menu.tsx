import { Text } from "ink";
import React from "react";

export interface SelectMenuItem {
  key: string;
  label: string;
  description?: string;
  indicator?: string;
  dimColor?: boolean;
}

interface SelectMenuProps {
  items: SelectMenuItem[];
  activeIndex: number;
  mode?: "multi" | "radio";
}

export function SelectMenu({ items, activeIndex, mode = "multi" }: SelectMenuProps) {
  return (
    <>
      {items.map((item, i) => {
        const active = i === activeIndex;
        const indicator = item.indicator ?? (mode === "radio" ? "○" : undefined);
        return (
          <Text key={item.key} color={active ? "cyan" : undefined} dimColor={item.dimColor}>
            {active ? "▸" : " "}
            {indicator !== undefined ? ` ${indicator}` : ""} {item.label}
            {item.description ? <Text dimColor> {item.description}</Text> : null}
          </Text>
        );
      })}
    </>
  );
}
