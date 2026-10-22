import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { BrandMark } from "@/components/brand-mark";
import { withBase } from "./base";

export const githubUrl = "https://github.com/uniqbit-ag/mate-cli";

/** Header shared by the landing page (`HomeLayout`) and the docs (`DocsLayout`). */
export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: <BrandMark />,
      url: withBase("/"),
    },
    links: [
      { text: "Docs", url: withBase("/docs"), active: "nested-url" },
      { text: "Use cases", url: withBase("/#use-cases"), active: "none" },
    ],
    githubUrl,
  };
}
